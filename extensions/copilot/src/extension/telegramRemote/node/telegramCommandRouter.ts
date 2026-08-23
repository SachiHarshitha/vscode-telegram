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
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlRegistry, RemoteRequestOrigin } from '../common/remoteControlTypes';
import type { TelegramAnswerCallbackQueryOptions, TelegramInlineKeyboardMarkup, TelegramMessage, TelegramSendMessageOptions, TelegramUpdate } from '../common/telegramTypes';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import type { TelegramCallbackConstraints, TelegramCallbackContext, TelegramCallbackInput, TelegramCallbackRegistration } from './telegramCallbackRegistry';
import { TelegramSessionState } from './telegramSessionState';

const maximumSessionButtons = 30;
const maximumButtonLabelLength = 64;
const maximumPromptLength = 32_000;

export interface TelegramCommandEnvironment {
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
}

export interface TelegramPromptDispatchResult {
	readonly accepted: true;
	readonly correlationId: string;
	readonly completion: Promise<void>;
}

export interface TelegramPromptDispatcher {
	dispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin): TelegramPromptDispatchResult;
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
	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void>;
}

interface ActiveDispatch {
	readonly sessionId: string;
	readonly requestId: string;
}

/** Routes only already-authorized Telegram updates into metadata and narrow remote-control seams. */
export class TelegramCommandRouter extends Disposable {
	private readonly activePickerRequestIds = new Map<string, string>();
	private readonly selectionRevisionIds = new Map<string, string>();
	private readonly activeDispatches = new Map<string, ActiveDispatch>();
	private currentIdentity: TelegramPairedIdentity | undefined;

	constructor(
		private readonly host: TelegramCommandHost,
		private readonly sessionState: TelegramSessionState,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly registry: IRemoteControlRegistry,
		private readonly promptDispatcher: TelegramPromptDispatcher,
		private readonly environment: TelegramCommandEnvironment,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(host.registerAuthorizedUpdateHandler(accepted => this.handleAuthorizedUpdate(accepted.update, accepted.identity)));
		this._register(host.onDidAuthorizeConnection(identity => this.runBackground('restore selected session', this.authorizeConnection(identity))));
		this._register(host.onDidBlockRemoteAccess(() => this.blockRemoteRouting()));
		this._register(host.onDidChangePairedIdentity(identity => this.handleIdentityChange(identity)));
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
					await this.safeSend(identity.chatId, l10n.t('Unknown Telegram Remote command. Use /start, /status, /sessions, /deselect, or /stop.'));
					return;
				case undefined:
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

		const pickerRequestId = this.activePickerRequestIds.get(identity.pairingId);
		if (pickerRequestId) {
			const selection = this.host.consumeCallback(update, { requestId: pickerRequestId, action: 'session.select' });
			if (selection) {
				await this.selectSession(identity, selection.sessionId);
				await this.safeAnswer(callback.id, { text: l10n.t('Session selected.') });
				return;
			}
		}

		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		const selectionRevisionId = this.selectionRevisionIds.get(identity.pairingId);
		if (selectedSessionId && selectionRevisionId) {
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
		if (active && selectedSessionId === active.sessionId) {
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

	private async sendStatus(identity: TelegramPairedIdentity): Promise<void> {
		const selected = await this.getValidSelectedSession(identity);
		const lines = [
			l10n.t('Telegram Remote'),
			l10n.t('Workstation: {0}', this.environment.workstationLabel),
			l10n.t('Workspace: {0}', this.environment.workspaceLabel),
			selected
				? l10n.t('Session: {0}', formatSessionName(selected))
				: l10n.t('Session: none selected'),
			'',
			l10n.t('Commands: /sessions, /status, /deselect, /stop'),
		];
		let replyMarkup: TelegramInlineKeyboardMarkup | undefined;
		if (selected) {
			const revisionId = this.selectionRevisionIds.get(identity.pairingId) ?? this.rotateSelectionRevision(identity);
			const deselect = this.host.registerCallback({
				identity,
				sessionId: selected.id,
				requestId: revisionId,
				action: 'session.deselect',
			});
			replyMarkup = { inline_keyboard: [[{ text: l10n.t('Deselect session'), callback_data: deselect.callbackData }]] };
		}
		await this.safeSend(identity.chatId, lines.join('\n'), { replyMarkup });
	}

	private async sendSessionPicker(identity: TelegramPairedIdentity): Promise<void> {
		const sessions = [...await this.sessionService.getAllSessions(CancellationToken.None)]
			.sort((left, right) => left.label.localeCompare(right.label));
		if (sessions.length === 0) {
			await this.safeSend(identity.chatId, l10n.t('No Copilot sessions are available in this VS Code window.'));
			return;
		}

		const requestId = randomUUID();
		this.activePickerRequestIds.set(identity.pairingId, requestId);
		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		const rows = sessions.slice(0, maximumSessionButtons).map(session => {
			const callback = this.host.registerCallback({ identity, sessionId: session.id, requestId, action: 'session.select' });
			const prefix = session.id === selectedSessionId ? '✓ ' : '';
			return [{ text: truncate(`${prefix}${formatSessionName(session)}`, maximumButtonLabelLength), callback_data: callback.callbackData }];
		});
		const omitted = sessions.length - rows.length;
		const text = [
			l10n.t('Select a Copilot session.'),
			l10n.t('Workstation: {0}', this.environment.workstationLabel),
			l10n.t('Workspace: {0}', this.environment.workspaceLabel),
			omitted > 0 ? l10n.t('{0} additional sessions are not shown.', omitted) : undefined,
		].filter((line): line is string => !!line).join('\n');
		await this.safeSend(identity.chatId, text, { replyMarkup: { inline_keyboard: rows } });
	}

	private async selectSession(identity: TelegramPairedIdentity, sessionId: string): Promise<void> {
		const item = await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		if (!item) {
			await this.safeSend(identity.chatId, l10n.t('That Copilot session was deleted or closed. Run /sessions to refresh the list.'));
			return;
		}
		this.invalidateRoutingState(identity);
		await this.sessionState.select(identity, item.id);
		this.rotateSelectionRevision(identity);
		await this.sendStatus(identity);
	}

	private async deselect(identity: TelegramPairedIdentity): Promise<void> {
		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		this.invalidateRoutingState(identity);
		const removed = await this.sessionState.deselect(identity);
		if (selectedSessionId) {
			this.host.invalidateSessionCallbacks(selectedSessionId);
		}
		await this.safeSend(identity.chatId, removed
			? l10n.t('The Copilot session is no longer remotely attached.')
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
		}
		const result = this.promptDispatcher.dispatch(selected.id, prompt, this.registry.createTelegramOrigin(String(update.update_id)));
		const active: ActiveDispatch = { sessionId: selected.id, requestId: result.correlationId };
		this.activeDispatches.set(identity.pairingId, active);
		const stop = this.host.registerCallback({
			identity,
			sessionId: selected.id,
			requestId: result.correlationId,
			action: 'session.stop',
		});
		await this.safeSend(identity.chatId, l10n.t('Prompt accepted for {0}. New text will steer the active turn.', formatSessionName(selected)), {
			replyMarkup: { inline_keyboard: [[{ text: l10n.t('Stop'), callback_data: stop.callbackData }]] },
		});
		void result.completion.then(
			() => this.completeDispatch(identity, active),
			() => {
				if (this.completeDispatch(identity, active)) {
					void this.safeSend(identity.chatId, l10n.t('The native Copilot request could not be completed. Use /status before retrying.'));
				}
			},
		);
	}

	private async stopActiveDispatch(identity: TelegramPairedIdentity): Promise<boolean> {
		const active = this.activeDispatches.get(identity.pairingId);
		const selectedSessionId = this.sessionState.getSelectedSessionId(identity);
		if (!active || selectedSessionId !== active.sessionId) {
			await this.safeSend(identity.chatId, l10n.t('There is no active Telegram-started task to stop.'));
			return false;
		}
		this.activeDispatches.delete(identity.pairingId);
		this.host.invalidateRequestCallbacks(active.sessionId, active.requestId);
		const stopped = await this.registry.abort(active.sessionId);
		await this.safeSend(identity.chatId, stopped
			? l10n.t('The active Copilot task was stopped.')
			: l10n.t('There is no live Copilot task to stop. The session was not reopened.'));
		return stopped;
	}

	private async getValidSelectedSession(identity: TelegramPairedIdentity): Promise<ICopilotCLISessionItem | undefined> {
		const sessionId = this.sessionState.getSelectedSessionId(identity);
		if (!sessionId) {
			return undefined;
		}
		const item = await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		if (item) {
			return item;
		}
		this.invalidateRoutingState(identity);
		await this.sessionState.deselect(identity);
		await this.safeSend(identity.chatId, l10n.t('The selected Copilot session was deleted or closed. Use /sessions to select another session.'));
		return undefined;
	}

	private async authorizeConnection(identity: TelegramPairedIdentity): Promise<void> {
		this.currentIdentity = identity;
		const sessionId = await this.sessionState.restore(identity, async candidate => !!await this.sessionService.getSessionItem(candidate, CancellationToken.None));
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
		this.host.invalidateSessionCallbacks(sessionId);
		const identity = this.currentIdentity;
		const wasSelected = identity && this.sessionState.getSelectedSessionId(identity) === sessionId;
		if (!await this.sessionState.clearSession(sessionId) || !identity || !wasSelected || !this.host.isAcceptingUpdates) {
			return;
		}
		this.invalidateRoutingState(identity);
		await this.safeSend(identity.chatId, l10n.t('The remotely selected Copilot session was deleted. Use /sessions to select another session.'));
	}

	private blockRemoteRouting(): void {
		this.activePickerRequestIds.clear();
		this.selectionRevisionIds.clear();
		this.activeDispatches.clear();
		this.sessionState.suspend();
	}

	private invalidateRoutingState(identity: TelegramPairedIdentity): void {
		this.host.invalidateAllCallbacks();
		this.activePickerRequestIds.delete(identity.pairingId);
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

	private async safeSend(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<void> {
		try {
			await this.host.sendMessage(chatId, text, options);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to send a Telegram command response.');
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

function parseCommand(text: string): 'start' | 'status' | 'sessions' | 'deselect' | 'stop' | 'unknown' | undefined {
	if (!text.startsWith('/')) {
		return undefined;
	}
	const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.exec(text);
	if (!match) {
		return 'unknown';
	}
	const command = match[1].toLowerCase();
	return command === 'start' || command === 'status' || command === 'sessions' || command === 'deselect' || command === 'stop'
		? command
		: 'unknown';
}

function formatSessionName(session: ICopilotCLISessionItem): string {
	const workspace = session.workingDirectory?.fsPath;
	return workspace ? `${session.label} — ${workspace}` : session.label;
}

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}
