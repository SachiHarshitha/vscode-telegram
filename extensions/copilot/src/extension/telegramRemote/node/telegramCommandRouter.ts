/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as l10n from '@vscode/l10n';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import type { Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { basename } from '../../../util/vs/base/common/resources';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlRegistry, RemoteRequestOrigin } from '../common/remoteControlTypes';
import type { TelegramAuthorizedSessionScope, TelegramSessionScopePolicy } from '../common/telegramSessionScope';
import { TelegramBotApiError, type TelegramAnswerCallbackQueryOptions, type TelegramEditMessageTextOptions, type TelegramInlineKeyboardMarkup, type TelegramMessage, type TelegramSendMessageOptions, type TelegramUpdate } from '../common/telegramTypes';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import type { TelegramCallbackConstraints, TelegramCallbackContext, TelegramCallbackInput, TelegramCallbackRegistration } from './telegramCallbackRegistry';
import { TelegramSessionState } from './telegramSessionState';

const maximumSessionButtons = 30;
const maximumButtonLabelLength = 64;
const maximumPromptLength = 32_000;
const emptyInlineKeyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };

export interface TelegramCommandEnvironment {
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
	readonly workspaceRoots?: readonly NonNullable<ICopilotCLISessionItem['workingDirectory']>[];
	readonly remotePermissionResponses?: boolean;
}

export interface TelegramPromptDispatchResult {
	readonly accepted: true;
	readonly correlationId: string;
	readonly completion: Promise<void>;
}

export interface TelegramPromptDispatcher {
	dispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin): TelegramPromptDispatchResult;
}

export interface TelegramSessionCreator {
	createSession(workspaceRoot: NonNullable<ICopilotCLISessionItem['workingDirectory']>, prompt: string): ICopilotCLISessionItem;
}

export interface TelegramRequestActivity {
	readonly onDidReachTerminal: Event<TelegramRequestTerminalEvent>;
	beginRequest(identity: TelegramPairedIdentity, session: ICopilotCLISessionItem, requestId: string, replyMarkup: TelegramInlineKeyboardMarkup): Promise<{ readonly generation: number; readonly messageId: number } | undefined>;
	completeRequest(identity: TelegramPairedIdentity, sessionId: string, requestId: string, outcome: 'completed' | 'failed' | 'cancelled' | 'superseded'): Promise<void>;
	isStopControl(sessionId: string, requestId: string, generation: number, messageId: number): boolean;
	closeRemoteConnection(): string | undefined;
}

export interface TelegramRequestTerminalEvent {
	readonly identity: TelegramPairedIdentity;
	readonly sessionId: string;
	readonly requestId: string;
	readonly outcome: 'completed' | 'failed' | 'cancelled';
}

export interface TelegramCommandHost {
	readonly isAcceptingUpdates: boolean;
	readonly pairedIdentity: TelegramPairedIdentity | undefined;
	readonly onDidAuthorizeConnection: Event<TelegramPairedIdentity>;
	readonly onDidBlockRemoteAccess: Event<void>;
	readonly onDidChangePairedIdentity: Event<TelegramPairedIdentity | undefined>;
	registerAuthorizedUpdateHandler(handler: (accepted: { readonly update: TelegramUpdate; readonly identity: TelegramPairedIdentity }) => Promise<void>): IDisposable;
	registerCallback(input: TelegramCallbackInput): TelegramCallbackRegistration;
	consumeCallback(update: TelegramUpdate, constraints?: TelegramCallbackConstraints): TelegramCallbackContext | undefined;
	invalidateSessionCallbacks(sessionId: string): void;
	invalidateRequestCallbacks(sessionId: string, requestId: string): void;
	invalidateAllCallbacks(): void;
	sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage>;
	editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true>;
	editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<TelegramMessage | true>;
	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void>;
}

interface ActiveDispatch {
	readonly sessionId: string;
	readonly requestId: string;
	readonly activityGeneration?: number;
}

interface AuthorizedSession {
	readonly item: ICopilotCLISessionItem;
	readonly scope: TelegramAuthorizedSessionScope;
}

interface TrackedStatusMessage {
	readonly chatId: number;
	readonly messageId: number;
	lastRenderedText: string;
	hasReplyMarkup: boolean;
	replyMarkupSignature: string;
}

/** Routes only already-authorized Telegram updates into metadata and narrow remote-control seams. */
export class TelegramCommandRouter extends Disposable {
	private readonly activePickerRequestIds = new Map<string, string>();
	private readonly activeNewSessionRequestIds = new Map<string, string>();
	private readonly pendingNewSessionPrompts = new Map<string, string | undefined>();
	private readonly pendingNewSessionRoots = new Map<string, NonNullable<ICopilotCLISessionItem['workingDirectory']>>();
	private readonly provisionalSessions = new Map<string, ICopilotCLISessionItem>();
	private readonly selectionRevisionIds = new Map<string, string>();
	private readonly activeDispatches = new Map<string, ActiveDispatch>();
	private readonly statusMessages = new Map<string, TrackedStatusMessage>();
	private currentIdentity: TelegramPairedIdentity | undefined;

	constructor(
		private readonly host: TelegramCommandHost,
		private readonly sessionState: TelegramSessionState,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly registry: IRemoteControlRegistry,
		private readonly promptDispatcher: TelegramPromptDispatcher,
		private readonly sessionCreator: TelegramSessionCreator,
		private readonly environment: TelegramCommandEnvironment,
		private readonly sessionScopePolicy: TelegramSessionScopePolicy,
		private readonly activity: TelegramRequestActivity,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(host.registerAuthorizedUpdateHandler(accepted => this.handleAuthorizedUpdate(accepted.update, accepted.identity)));
		this._register(host.onDidAuthorizeConnection(identity => this.runBackground('restore selected session', this.authorizeConnection(identity))));
		this._register(host.onDidBlockRemoteAccess(() => this.blockRemoteRouting()));
		this._register(host.onDidChangePairedIdentity(identity => this.handleIdentityChange(identity)));
		this._register(activity.onDidReachTerminal(event => this.handleActivityTerminal(event)));
		this._register(sessionService.onDidDeleteSession(sessionId => this.runBackground('detach deleted session', this.handleDeletedSession(sessionId))));
		if (host.isAcceptingUpdates && host.pairedIdentity) {
			this.runBackground('restore selected session', this.authorizeConnection(host.pairedIdentity));
		}
	}

	private async handleAuthorizedUpdate(update: TelegramUpdate, identity: TelegramPairedIdentity): Promise<void> {
		try {
			if (update.callback_query) {
				await this.handleCallback(update, identity);
				return;
			}
			const text = update.message?.text?.trim();
			if (!text) {
				await this.safeSend(identity.chatId, l10n.t('Telegram Remote accepts text messages and its inline controls.'));
				return;
			}
			const command = parseCommand(text);
			switch (command) {
				case 'start':
				case 'status':
					await this.sendStatus(identity);
					return;
				case 'new':
					await this.beginNewSession(update, identity, parseCommandArgument(text));
					return;
				case 'sessions':
					await this.sendSessionPicker(identity);
					return;
				case 'deselect':
					await this.deselect(identity);
					return;
				case 'stop':
					await this.stopActiveDispatch(identity);
					return;
				case 'unknown':
					await this.safeSend(identity.chatId, l10n.t('Unknown Telegram Remote command. Use /start, /new, /status, /sessions, /deselect, or /stop.'));
					return;
				case undefined:
					if (await this.dispatchPendingNewSession(update, identity, text)) {
						return;
					}
					await this.dispatchPrompt(update, identity, text);
			}
		} catch {
			this.logService.error('[TelegramRemote] Authorized update routing failed; details were suppressed.');
			await this.safeSend(identity.chatId, l10n.t('Telegram Remote could not complete that request. Refresh with /status and try again.'));
		}
	}

	private async handleCallback(update: TelegramUpdate, identity: TelegramPairedIdentity): Promise<void> {
		const callback = update.callback_query!;
		const data = callback.data;
		if (!data) {
			await this.safeAnswer(callback.id, { text: l10n.t('This control is invalid.'), showAlert: true });
			return;
		}

		const callbackMessageId = callback.message?.message_id;
		const statusMessage = this.statusMessages.get(identity.pairingId);
		const newSessionRequestId = this.activeNewSessionRequestIds.get(identity.pairingId);
		if (newSessionRequestId && callbackMessageId !== undefined && statusMessage?.messageId === callbackMessageId && statusMessage.chatId === identity.chatId) {
			const creation = this.host.consumeCallback(update, { requestId: newSessionRequestId, action: 'session.create' });
			if (creation) {
				const workspaceRoot = this.environment.workspaceRoots?.find(root => root.toString() === creation.value);
				const prompt = this.pendingNewSessionPrompts.get(newSessionRequestId);
				this.activeNewSessionRequestIds.delete(identity.pairingId);
				this.pendingNewSessionPrompts.delete(newSessionRequestId);
				if (!workspaceRoot) {
					await this.safeAnswer(callback.id, { text: l10n.t('That workspace is no longer available.'), showAlert: true });
					return;
				}
				await this.safeAnswer(callback.id, { text: l10n.t('Workspace selected.') });
				await this.safeRemoveReplyMarkup(identity.chatId, callbackMessageId);
				this.statusMessages.delete(identity.pairingId);
				if (prompt) {
					await this.createAndDispatchNewSession(update, identity, workspaceRoot, prompt);
				} else {
					this.pendingNewSessionRoots.set(identity.pairingId, workspaceRoot);
					await this.sendOrEditStatus(identity, l10n.t('New Copilot session ready in {0}. Send its first prompt.', workspaceRoot.fsPath || workspaceRoot.toString()));
				}
				return;
			}
		}

		const pickerRequestId = this.activePickerRequestIds.get(identity.pairingId);
		if (pickerRequestId && callbackMessageId !== undefined && statusMessage?.messageId === callbackMessageId && statusMessage.chatId === identity.chatId) {
			const selection = this.host.consumeCallback(update, { requestId: pickerRequestId, action: 'session.select' });
			if (selection) {
				const selected = await this.selectSession(identity, selection.sessionId);
				await this.safeAnswer(callback.id, { text: selected ? l10n.t('Session selected.') : l10n.t('That session is outside the authorized workspace.'), showAlert: !selected });
				return;
			}
		}

		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		const selectionRevisionId = this.selectionRevisionIds.get(identity.pairingId);
		if (selectedSessionId && selectionRevisionId && callbackMessageId !== undefined && statusMessage?.messageId === callbackMessageId && statusMessage.chatId === identity.chatId) {
			const deselect = this.host.consumeCallback(update, {
				sessionId: selectedSessionId,
				requestId: selectionRevisionId,
				action: 'session.deselect',
			});
			if (deselect) {
				await this.deselect(identity);
				await this.safeAnswer(callback.id, { text: l10n.t('Session deselected.') });
				return;
			}
		}

		const active = this.activeDispatches.get(identity.pairingId);
		if (active && selectedSessionId === active.sessionId && active.activityGeneration !== undefined && callbackMessageId !== undefined
			&& this.activity.isStopControl(active.sessionId, active.requestId, active.activityGeneration, callbackMessageId)) {
			const stop = this.host.consumeCallback(update, {
				sessionId: active.sessionId,
				requestId: active.requestId,
				action: 'session.stop',
			});
			if (stop) {
				const stopped = await this.stopActiveDispatch(identity);
				await this.safeAnswer(callback.id, { text: stopped ? l10n.t('Stopped.') : l10n.t('No active task.'), showAlert: !stopped });
				return;
			}
		}

		await this.safeAnswer(callback.id, { text: l10n.t('This control is stale. Use /status to refresh it.'), showAlert: true });
	}

	private async beginNewSession(update: TelegramUpdate, identity: TelegramPairedIdentity, prompt: string | undefined): Promise<void> {
		if (prompt && prompt.length > maximumPromptLength) {
			await this.safeSend(identity.chatId, l10n.t('That prompt is too long. Shorten it and try again.'));
			return;
		}
		const workspaceRoots = this.environment.workspaceRoots ?? [];
		if (workspaceRoots.length === 0) {
			await this.safeSend(identity.chatId, l10n.t('Open and authorize a workspace in VS Code before creating a Copilot session.'));
			return;
		}

		this.pendingNewSessionRoots.delete(identity.pairingId);
		if (workspaceRoots.length === 1) {
			if (prompt) {
				await this.createAndDispatchNewSession(update, identity, workspaceRoots[0], prompt);
			} else {
				this.pendingNewSessionRoots.set(identity.pairingId, workspaceRoots[0]);
				await this.sendOrEditStatus(identity, l10n.t('New Copilot session ready in {0}. Send its first prompt.', workspaceRoots[0].fsPath || workspaceRoots[0].toString()));
			}
			return;
		}

		const requestId = randomUUID();
		this.activeNewSessionRequestIds.set(identity.pairingId, requestId);
		this.pendingNewSessionPrompts.set(requestId, prompt);
		const rows = workspaceRoots.slice(0, maximumSessionButtons).map(workspaceRoot => {
			const callback = this.host.registerCallback({
				identity,
				sessionId: 'new-session',
				requestId,
				action: 'session.create',
				value: workspaceRoot.toString(),
			});
			return [{ text: truncate(basename(workspaceRoot), maximumButtonLabelLength), callback_data: callback.callbackData }];
		});
		await this.sendOrEditStatus(identity, prompt
			? l10n.t('Choose the authorized workspace for the new Copilot session.')
			: l10n.t('Choose an authorized workspace, then send the first prompt.'),
		{ replyMarkup: { inline_keyboard: rows } });
	}

	private async dispatchPendingNewSession(update: TelegramUpdate, identity: TelegramPairedIdentity, prompt: string): Promise<boolean> {
		const workspaceRoot = this.pendingNewSessionRoots.get(identity.pairingId);
		if (!workspaceRoot) {
			return false;
		}
		this.pendingNewSessionRoots.delete(identity.pairingId);
		await this.createAndDispatchNewSession(update, identity, workspaceRoot, prompt);
		return true;
	}

	private async createAndDispatchNewSession(
		update: TelegramUpdate,
		identity: TelegramPairedIdentity,
		workspaceRoot: NonNullable<ICopilotCLISessionItem['workingDirectory']>,
		prompt: string,
	): Promise<void> {
		const item = this.sessionCreator.createSession(workspaceRoot, prompt);
		const scope = this.sessionScopePolicy.authorizeSession(item);
		if (!scope) {
			throw new Error('Created Telegram session is outside the authorized workspace.');
		}
		await this.supersedeActiveDispatch(identity);
		this.invalidateRoutingState(identity);
		this.provisionalSessions.set(item.id, item);
		await this.sessionState.select(identity, item.id, scope.fingerprint);
		this.rotateSelectionRevision(identity);
		await this.dispatchPrompt(update, identity, prompt);
	}

	private async sendStatus(identity: TelegramPairedIdentity): Promise<void> {
		const selected = await this.getValidSelectedSession(identity);
		const lines = [
			l10n.t('Telegram Remote'),
			l10n.t('Workstation: {0}', this.environment.workstationLabel),
			selected
				? l10n.t('Authorized workspace: {0}', selected.scope.workingDirectoryLabel)
				: l10n.t('Authorized workspace scope: {0}', this.environment.workspaceLabel),
			selected
				? l10n.t('Session: {0}', selected.item.label)
				: l10n.t('Session: none selected'),
			'',
			this.environment.remotePermissionResponses
				? l10n.t('Permissions: supported prompts may be answered remotely')
				: l10n.t('Permissions: approval is required locally in this build'),
			l10n.t('Commands: /new, /sessions, /status, /deselect, /stop'),
		];
		let replyMarkup: TelegramInlineKeyboardMarkup | undefined;
		if (selected) {
			const revisionId = this.selectionRevisionIds.get(identity.pairingId) ?? this.rotateSelectionRevision(identity);
			const deselect = this.host.registerCallback({
				identity,
				sessionId: selected.item.id,
				requestId: revisionId,
				action: 'session.deselect',
			});
			replyMarkup = { inline_keyboard: [[{ text: l10n.t('Deselect session'), callback_data: deselect.callbackData }]] };
		}
		await this.sendOrEditStatus(identity, lines.join('\n'), { replyMarkup });
	}

	private async sendSessionPicker(identity: TelegramPairedIdentity): Promise<void> {
		const sessions = [...await this.sessionService.getAllSessions(CancellationToken.None)]
			.map(item => ({ item, scope: this.sessionScopePolicy.authorizeSession(item) }))
			.filter((candidate): candidate is AuthorizedSession => !!candidate.scope)
			.sort((left, right) => left.item.label.localeCompare(right.item.label));
		if (sessions.length === 0) {
			await this.sendOrEditStatus(identity, l10n.t('No Copilot sessions are available in the authorized workspace.'));
			return;
		}

		const requestId = randomUUID();
		this.activePickerRequestIds.set(identity.pairingId, requestId);
		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		const rows = sessions.slice(0, maximumSessionButtons).map(session => {
			const callback = this.host.registerCallback({ identity, sessionId: session.item.id, requestId, action: 'session.select' });
			const prefix = session.item.id === selectedSessionId ? '✓ ' : '';
			return [{ text: truncate(`${prefix}${formatSessionButton(session.item)}`, maximumButtonLabelLength), callback_data: callback.callbackData }];
		});
		const omitted = sessions.length - rows.length;
		const text = [
			l10n.t('Select a Copilot session.'),
			l10n.t('Workstation: {0}', this.environment.workstationLabel),
			l10n.t('Workspace: {0}', this.environment.workspaceLabel),
			omitted > 0 ? l10n.t('{0} additional sessions are not shown.', omitted) : undefined,
		].filter((line): line is string => !!line).join('\n');
		await this.sendOrEditStatus(identity, text, { replyMarkup: { inline_keyboard: rows } });
	}

	private async selectSession(identity: TelegramPairedIdentity, sessionId: string): Promise<boolean> {
		const item = await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		const scope = item && this.sessionScopePolicy.authorizeSession(item);
		if (!item || !scope) {
			await this.sendOrEditStatus(identity, l10n.t('That Copilot session is unavailable in the authorized workspace. Run /sessions to refresh the list.'));
			return false;
		}
		await this.supersedeActiveDispatch(identity);
		this.invalidateRoutingState(identity);
		await this.sessionState.select(identity, item.id, scope.fingerprint);
		this.rotateSelectionRevision(identity);
		await this.sendStatus(identity);
		return true;
	}

	private async deselect(identity: TelegramPairedIdentity): Promise<void> {
		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		await this.supersedeActiveDispatch(identity);
		this.invalidateRoutingState(identity);
		const removed = await this.sessionState.deselect(identity);
		if (selectedSessionId) {
			this.host.invalidateSessionCallbacks(selectedSessionId);
			this.provisionalSessions.delete(selectedSessionId);
		}
		await this.sendOrEditStatus(identity, removed
			? l10n.t('The Copilot session is no longer remotely attached. Use /sessions to select another session.')
			: l10n.t('No Copilot session is selected. Use /sessions to select one.'));
	}

	private async dispatchPrompt(update: TelegramUpdate, identity: TelegramPairedIdentity, prompt: string): Promise<void> {
		if (prompt.length > maximumPromptLength) {
			await this.safeSend(identity.chatId, l10n.t('That prompt is too long. Shorten it and try again.'));
			return;
		}
		const selected = await this.getValidSelectedSession(identity);
		if (!selected) {
			await this.safeSend(identity.chatId, l10n.t('No Copilot session is selected. Use /sessions before sending a prompt.'));
			return;
		}

		const previous = this.activeDispatches.get(identity.pairingId);
		if (previous) {
			this.host.invalidateRequestCallbacks(previous.sessionId, previous.requestId);
			await this.activity.completeRequest(identity, previous.sessionId, previous.requestId, 'superseded');
		}
		const result = this.promptDispatcher.dispatch(selected.item.id, prompt, this.registry.createTelegramOrigin(String(update.update_id)));
		const stop = this.host.registerCallback({
			identity,
			sessionId: selected.item.id,
			requestId: result.correlationId,
			action: 'session.stop',
		});
		const activity = await this.activity.beginRequest(identity, selected.item, result.correlationId, {
			inline_keyboard: [[{ text: l10n.t('Stop'), callback_data: stop.callbackData }]],
		});
		const active: ActiveDispatch = {
			sessionId: selected.item.id,
			requestId: result.correlationId,
			activityGeneration: activity?.generation,
		};
		this.activeDispatches.set(identity.pairingId, active);
		void result.completion.catch(() => this.finishDispatch(identity, active, 'failed'));
	}

	private async stopActiveDispatch(identity: TelegramPairedIdentity): Promise<boolean> {
		const active = this.activeDispatches.get(identity.pairingId);
		const selected = await this.getValidSelectedSession(identity);
		if (!active || !selected || selected.item.id !== active.sessionId) {
			await this.safeSend(identity.chatId, l10n.t('There is no active Telegram-started task to stop.'));
			return false;
		}
		this.activeDispatches.delete(identity.pairingId);
		this.host.invalidateRequestCallbacks(active.sessionId, active.requestId);
		const stopped = await this.registry.abort(active.sessionId);
		await this.activity.completeRequest(identity, active.sessionId, active.requestId, 'cancelled');
		if (!stopped) {
			await this.safeSend(identity.chatId, l10n.t('There is no live Copilot task to stop. The session was not reopened.'));
		}
		return stopped;
	}

	private async getValidSelectedSession(identity: TelegramPairedIdentity): Promise<AuthorizedSession | undefined> {
		const sessionId = this.sessionState.getSelectedSessionId(identity);
		if (!sessionId) {
			return undefined;
		}
		const persistedItem = await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		if (persistedItem) {
			this.provisionalSessions.delete(sessionId);
		}
		const item = persistedItem ?? this.provisionalSessions.get(sessionId);
		const scope = item && this.sessionScopePolicy.authorizeSession(item);
		if (item && scope && this.sessionState.getSelectedSessionScopeFingerprint(identity) === scope.fingerprint) {
			return { item, scope };
		}
		await this.supersedeActiveDispatch(identity);
		this.invalidateRoutingState(identity);
		await this.sessionState.deselect(identity);
		await this.safeSend(identity.chatId, l10n.t('The selected Copilot session is no longer available in the authorized workspace. Use /sessions to select another session.'));
		return undefined;
	}

	private async authorizeConnection(identity: TelegramPairedIdentity): Promise<void> {
		this.currentIdentity = identity;
		const sessionId = await this.sessionState.restore(identity, async (candidate, storedScopeFingerprint) => {
			const item = await this.sessionService.getSessionItem(candidate, CancellationToken.None);
			const scope = item && this.sessionScopePolicy.authorizeSession(item);
			return !!scope && scope.fingerprint === storedScopeFingerprint;
		});
		if (sessionId) {
			this.rotateSelectionRevision(identity);
		}
	}

	private handleIdentityChange(identity: TelegramPairedIdentity | undefined): void {
		const previous = this.currentIdentity;
		this.currentIdentity = identity;
		if (!identity && previous) {
			this.invalidateRoutingState(previous);
			this.runBackground('clear revoked session selection', this.sessionState.clearIdentity(previous));
		}
	}

	private async handleDeletedSession(sessionId: string): Promise<void> {
		this.provisionalSessions.delete(sessionId);
		this.host.invalidateSessionCallbacks(sessionId);
		const identity = this.currentIdentity;
		const wasSelected = identity && this.sessionState.getSelectedSessionId(identity) === sessionId;
		if (!await this.sessionState.clearSession(sessionId) || !identity || !wasSelected || !this.host.isAcceptingUpdates) {
			return;
		}
		await this.supersedeActiveDispatch(identity);
		this.invalidateRoutingState(identity);
		await this.safeSend(identity.chatId, l10n.t('The remotely selected Copilot session was deleted. Use /sessions to select another session.'));
	}

	private blockRemoteRouting(): void {
		const drainingSessionId = this.activity.closeRemoteConnection();
		this.activePickerRequestIds.clear();
		this.activeNewSessionRequestIds.clear();
		this.pendingNewSessionPrompts.clear();
		this.pendingNewSessionRoots.clear();
		this.selectionRevisionIds.clear();
		for (const [pairingId, active] of this.activeDispatches) {
			if (active.sessionId !== drainingSessionId) {
				this.activeDispatches.delete(pairingId);
			}
		}
		this.statusMessages.clear();
		this.sessionState.suspend(!!drainingSessionId);
	}

	private handleActivityTerminal(event: TelegramRequestTerminalEvent): void {
		const active = this.activeDispatches.get(event.identity.pairingId);
		if (!active || active.sessionId !== event.sessionId || active.requestId !== event.requestId) {
			return;
		}
		this.activeDispatches.delete(event.identity.pairingId);
		this.host.invalidateRequestCallbacks(active.sessionId, active.requestId);
	}

	private invalidateRoutingState(identity: TelegramPairedIdentity): void {
		this.host.invalidateAllCallbacks();
		this.activePickerRequestIds.delete(identity.pairingId);
		const newSessionRequestId = this.activeNewSessionRequestIds.get(identity.pairingId);
		if (newSessionRequestId) {
			this.pendingNewSessionPrompts.delete(newSessionRequestId);
		}
		this.activeNewSessionRequestIds.delete(identity.pairingId);
		this.pendingNewSessionRoots.delete(identity.pairingId);
		this.selectionRevisionIds.delete(identity.pairingId);
		this.activeDispatches.delete(identity.pairingId);
	}

	private rotateSelectionRevision(identity: TelegramPairedIdentity): string {
		const revision = randomUUID();
		this.selectionRevisionIds.set(identity.pairingId, revision);
		return revision;
	}

	private completeDispatch(identity: TelegramPairedIdentity, active: ActiveDispatch): boolean {
		if (this.activeDispatches.get(identity.pairingId) !== active) {
			return false;
		}
		this.activeDispatches.delete(identity.pairingId);
		this.host.invalidateRequestCallbacks(active.sessionId, active.requestId);
		return true;
	}

	private async finishDispatch(identity: TelegramPairedIdentity, active: ActiveDispatch, outcome: 'completed' | 'failed'): Promise<void> {
		if (!this.completeDispatch(identity, active)) {
			return;
		}
		await this.activity.completeRequest(identity, active.sessionId, active.requestId, outcome);
	}

	private async supersedeActiveDispatch(identity: TelegramPairedIdentity): Promise<void> {
		const active = this.activeDispatches.get(identity.pairingId);
		if (active) {
			await this.activity.completeRequest(identity, active.sessionId, active.requestId, 'superseded');
		}
	}

	private async sendOrEditStatus(identity: TelegramPairedIdentity, text: string, options?: TelegramEditMessageTextOptions): Promise<void> {
		const tracked = this.statusMessages.get(identity.pairingId);
		const hasReplyMarkup = containsInlineControls(options?.replyMarkup);
		const replyMarkupSignature = serializeReplyMarkup(options?.replyMarkup);
		if (tracked?.chatId === identity.chatId && tracked.hasReplyMarkup) {
			await this.safeRemoveReplyMarkup(identity.chatId, tracked.messageId);
		}
		this.statusMessages.delete(identity.pairingId);
		const message = await this.safeSend(identity.chatId, text, options);
		if (message) {
			this.statusMessages.set(identity.pairingId, {
				chatId: identity.chatId,
				messageId: message.message_id,
				lastRenderedText: text,
				hasReplyMarkup,
				replyMarkupSignature,
			});
		}
	}

	private async safeSend(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage | undefined> {
		try {
			return await this.host.sendMessage(chatId, text, options);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to send a Telegram command response.');
			return undefined;
		}
	}

	private async safeRemoveReplyMarkup(chatId: number, messageId: number): Promise<void> {
		try {
			await this.host.editMessageReplyMarkup(chatId, messageId, emptyInlineKeyboard);
		} catch (error) {
			this.logService.warn(`[TelegramRemote] status-controls-remove=failed ${formatTelegramApiFailure(error)}`);
		}
	}

	private async safeAnswer(callbackQueryId: string, options: TelegramAnswerCallbackQueryOptions): Promise<void> {
		try {
			await this.host.answerCallbackQuery(callbackQueryId, options);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to answer a Telegram callback query.');
		}
	}

	private runBackground(operation: string, promise: Promise<unknown>): void {
		void promise.catch(() => this.logService.error(`[TelegramRemote] Failed to ${operation}; details were suppressed.`));
	}
}

function parseCommand(text: string): 'start' | 'new' | 'status' | 'sessions' | 'deselect' | 'stop' | 'unknown' | undefined {
	if (!text.startsWith('/')) {
		return undefined;
	}
	const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.exec(text);
	if (!match) {
		return 'unknown';
	}
	const command = match[1].toLowerCase();
	return command === 'start' || command === 'new' || command === 'status' || command === 'sessions' || command === 'deselect' || command === 'stop'
		? command
		: 'unknown';
}

function parseCommandArgument(text: string): string | undefined {
	const match = /^\/[a-z]+(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(text);
	return match?.[1]?.trim() || undefined;
}

function formatSessionButton(session: ICopilotCLISessionItem): string {
	const repository = session.workingDirectory ? basename(session.workingDirectory) : undefined;
	return repository && repository.toLocaleLowerCase() !== session.label.toLocaleLowerCase()
		? `${session.label} — ${repository}`
		: session.label;
}

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function containsInlineControls(replyMarkup: TelegramInlineKeyboardMarkup | undefined): boolean {
	return !!replyMarkup?.inline_keyboard.some(row => row.length > 0);
}

function serializeReplyMarkup(replyMarkup: TelegramInlineKeyboardMarkup | undefined): string {
	return containsInlineControls(replyMarkup) ? JSON.stringify(replyMarkup) : '';
}

function formatTelegramApiFailure(error: unknown): string {
	return error instanceof TelegramBotApiError
		? `kind=${error.kind} http=${error.httpStatus ?? 'none'} errorCode=${error.errorCode ?? 'none'}`
		: 'kind=unknown http=none errorCode=none';
}
