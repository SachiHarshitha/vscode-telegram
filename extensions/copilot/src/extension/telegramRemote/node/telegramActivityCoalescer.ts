/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter, type Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../chatSessions/copilotcli/node/copilotcliSessionService';
import { projectRemoteAgentEvent, type RemoteAgentEvent } from '../../remoteControl/common/remoteAgentEvent';
import type { IRemoteControlSessionEvent } from '../../remoteControl/common/remoteControlTypes';
import type { TelegramAuthorizedSessionScope, TelegramSessionScopePolicy } from '../common/telegramSessionScope';
import type { TelegramEditMessageTextOptions, TelegramInlineKeyboardMarkup, TelegramMessage, TelegramSendMessageOptions } from '../common/telegramTypes';
import type { TelegramRequestActivity, TelegramRequestTerminalEvent } from './telegramCommandRouter';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import { TelegramSessionState } from './telegramSessionState';
import { renderTelegramActivity, renderTelegramEvent, type TelegramActivityAction, type TelegramActivityDetail, type TelegramActivityTerminalOutcome } from './telegramEventRenderer';
import { renderTelegramMarkdownAnswer } from './telegramMarkdown';

const minimumEditIntervalMs = 1_000;
const initialFlushDelayMs = 250;
const maximumRecentActions = 6;
const maximumResponseLength = 32_000;
const maximumReasoningLength = 600;
const maximumCorrelatedTools = 32;
const emptyInlineKeyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };

export interface TelegramActivityHost {
	readonly isAcceptingUpdates: boolean;
	readonly pairedIdentity: TelegramPairedIdentity | undefined;
	readonly onDidBlockRemoteAccess: Event<void>;
	readonly onDidChangePairedIdentity: Event<TelegramPairedIdentity | undefined>;
	sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage>;
	editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true>;
	editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<TelegramMessage | true>;
	preserveDeliveryClient(): void;
	clearDeliveryClient(): void;
}

export interface TelegramActivityScheduler {
	now(): number;
	schedule(callback: () => Promise<void>, delayMs: number): IDisposable;
}

interface TelegramActivityEnvironment {
	readonly workstationLabel: string;
}

interface AuthorizedActivitySession {
	readonly identity: TelegramPairedIdentity;
	readonly item: ICopilotCLISessionItem;
	readonly scope: TelegramAuthorizedSessionScope;
}

interface ActivityState {
	readonly generation: number;
	readonly identity: TelegramPairedIdentity;
	readonly pairingId: string;
	readonly userId: number;
	readonly chatId: number;
	readonly sessionId: string;
	readonly sessionScopeFingerprint: string;
	readonly sessionLabel: string;
	readonly workingDirectoryLabel: string;
	readonly actions: TelegramActivityAction[];
	readonly toolNames: Map<string, string>;
	requestId?: string;
	replyMarkup?: TelegramInlineKeyboardMarkup;
	clearReplyMarkupOnNextEdit?: boolean;
	messageId?: number;
	lastMessageText?: string;
	revision: number;
	dirty: boolean;
	complete: boolean;
	connectionClosed: boolean;
	terminalOutcome?: TelegramActivityTerminalOutcome;
	terminalNotified: boolean;
	responseMessageId?: string;
	response?: string;
	reasoningId?: string;
	reasoning?: string;
	usage?: string;
	lastFlushAt: number;
	flushDueAt?: number;
	flushTimer?: IDisposable;
	finalAttempted: boolean;
	replayTurnId?: string;
}

/** Owns one bounded activity card, its Stop control, and exactly-once separate final-answer delivery. */
export class TelegramActivityCoalescer extends Disposable implements TelegramRequestActivity {
	private readonly terminalEmitter = this._register(new Emitter<TelegramRequestTerminalEvent>());
	readonly onDidReachTerminal = this.terminalEmitter.event;
	private readonly scheduler: TelegramActivityScheduler;
	private activeState: ActivityState | undefined;
	private generation = 0;
	private flushQueue = Promise.resolve();

	constructor(
		private readonly host: TelegramActivityHost,
		private readonly sessionState: TelegramSessionState,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly environment: TelegramActivityEnvironment,
		private readonly sessionScopePolicy: TelegramSessionScopePolicy,
		private readonly getActivityDetail: () => TelegramActivityDetail,
		scheduler: TelegramActivityScheduler | undefined,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.scheduler = scheduler ?? new DefaultTelegramActivityScheduler();
		this._register(host.onDidChangePairedIdentity(identity => {
			if (!identity) {
				this.dropActiveState(true);
			}
		}));
	}

	async beginRequest(identity: TelegramPairedIdentity, session: ICopilotCLISessionItem, requestId: string, replyMarkup: TelegramInlineKeyboardMarkup): Promise<{ readonly generation: number; readonly messageId: number } | undefined> {
		const authorized = await this.getAuthorizedSession(session.id, identity, session);
		if (!authorized) {
			return undefined;
		}
		await this.removeStopControl(this.activeState);
		this.reset();
		const state = this.createState(authorized);
		state.requestId = requestId;
		state.replyMarkup = replyMarkup;
		state.actions.push({ key: 'request', text: l10n.t('Prompt accepted — Copilot is starting') });
		state.dirty = true;
		state.revision++;
		this.activeState = state;
		await this.enqueueFlush(state);
		return state.messageId === undefined ? undefined : { generation: state.generation, messageId: state.messageId };
	}

	async completeRequest(identity: TelegramPairedIdentity, sessionId: string, requestId: string, outcome: 'completed' | 'failed' | 'cancelled' | 'superseded'): Promise<void> {
		const state = this.activeState;
		if (!state || state.pairingId !== identity.pairingId || state.userId !== identity.userId || state.chatId !== identity.chatId
			|| state.sessionId !== sessionId || state.requestId !== requestId) {
			return;
		}
		upsertAction(state.actions, {
			key: 'request',
			text: outcome === 'completed' ? l10n.t('Request completed')
				: outcome === 'failed' ? l10n.t('Request failed')
					: outcome === 'cancelled' ? l10n.t('Request cancelled')
						: l10n.t('Request superseded'),
		});
		state.complete = true;
		state.terminalOutcome = outcome === 'superseded' ? undefined : outcome;
		state.dirty = true;
		state.revision++;
		await this.removeStopControl(state);
		this.scheduleFlush(state, true);
	}

	closeRemoteConnection(): string | undefined {
		const state = this.activeState;
		if (!state?.requestId || state.complete) {
			this.dropActiveState(true);
			this.host.clearDeliveryClient();
			return undefined;
		}
		state.connectionClosed = true;
		this.host.preserveDeliveryClient();
		upsertAction(state.actions, { key: 'request', text: l10n.t('Remote connection closed; task may continue locally') });
		if (state.replyMarkup) {
			state.replyMarkup = undefined;
			state.clearReplyMarkupOnNextEdit = true;
		}
		state.dirty = true;
		state.revision++;
		this.scheduleFlush(state, true);
		return state.sessionId;
	}

	isStopControl(sessionId: string, requestId: string, generation: number, messageId: number): boolean {
		const state = this.activeState;
		return !!state && state.sessionId === sessionId && state.requestId === requestId && state.generation === generation
			&& state.messageId === messageId && !!state.replyMarkup;
	}

	async publish(sessionId: string, rawEvent: IRemoteControlSessionEvent): Promise<void> {
		const drainingState = this.activeState?.connectionClosed && this.activeState.sessionId === sessionId ? this.activeState : undefined;
		const authorized = drainingState ? await this.getDrainingSession(drainingState) : await this.getAuthorizedSession(sessionId);
		if (!authorized) {
			if (!drainingState) {
				this.dropActiveState(true);
			}
			return;
		}
		const event = projectRemoteAgentEvent(rawEvent);
		if (!event || isAgentScopedStream(event)) {
			return;
		}

		let state = this.activeState;
		if (!state || state.sessionId !== sessionId || state.pairingId !== authorized.identity.pairingId
			|| state.sessionScopeFingerprint !== authorized.scope.fingerprint) {
			await this.removeStopControl(state);
			this.reset();
			state = this.createState(authorized);
			state.actions.push({ key: 'attachment', text: l10n.t('Existing session attached') });
			this.activeState = state;
		}

		if (event.source === 'replay') {
			this.applyReplayState(state, event);
			return;
		}

		const detail = this.getActivityDetail();
		const correlatedToolName = getToolCallId(event) ? state.toolNames.get(getToolCallId(event)!) : undefined;
		if (event.kind === 'tool.execution_start') {
			rememberToolName(state.toolNames, event.toolCallId, event.toolName);
		}
		const mutation = renderTelegramEvent(event, { detail, correlatedToolName });
		if (mutation.action) {
			upsertAction(state.actions, mutation.action);
		}
		if (event.kind === 'tool.execution_complete') {
			state.toolNames.delete(event.toolCallId);
		}
		if (state.requestId && mutation.response && mutation.response.text) {
			if (state.responseMessageId !== mutation.response.messageId) {
				state.responseMessageId = mutation.response.messageId;
				state.response = '';
			}
			state.response = mutation.response.append
				? appendBounded(state.response ?? '', mutation.response.text, maximumResponseLength)
				: truncate(mutation.response.text, maximumResponseLength);
		}
		if (detail === 'debug' && mutation.reasoning && mutation.reasoning.text) {
			if (state.reasoningId !== mutation.reasoning.reasoningId) {
				state.reasoningId = mutation.reasoning.reasoningId;
				state.reasoning = '';
			}
			state.reasoning = mutation.reasoning.append
				? appendBounded(state.reasoning ?? '', mutation.reasoning.text, maximumReasoningLength)
				: truncate(mutation.reasoning.text, maximumReasoningLength);
		}
		state.usage = mutation.usage ?? state.usage;
		if (mutation.terminal) {
			state.complete = true;
			state.terminalOutcome = mutation.terminal;
			upsertAction(state.actions, {
				key: 'request',
				text: mutation.terminal === 'completed' ? l10n.t('Request completed')
					: mutation.terminal === 'failed' ? l10n.t('Request failed') : l10n.t('Request cancelled'),
			});
		}
		const visibleChange = !!mutation.action || !!mutation.usage || !!mutation.terminal || (detail === 'debug' && !!mutation.reasoning);
		const finalBecameAvailable = !!state.requestId && state.complete && !!state.response && !state.finalAttempted;
		if (!visibleChange && !finalBecameAvailable) {
			return;
		}
		state.dirty = true;
		state.revision++;
		this.scheduleFlush(state, mutation.urgent === true || mutation.terminal !== undefined || finalBecameAvailable);
	}

	private createState(authorized: AuthorizedActivitySession): ActivityState {
		return {
			generation: ++this.generation,
			identity: authorized.identity,
			pairingId: authorized.identity.pairingId,
			userId: authorized.identity.userId,
			chatId: authorized.identity.chatId,
			sessionId: authorized.item.id,
			sessionScopeFingerprint: authorized.scope.fingerprint,
			sessionLabel: authorized.item.label,
			workingDirectoryLabel: authorized.scope.workingDirectoryLabel,
			actions: [],
			toolNames: new Map(),
			revision: 0,
			dirty: false,
			complete: false,
			connectionClosed: false,
			terminalNotified: false,
			lastFlushAt: 0,
			finalAttempted: false,
		};
	}

	private applyReplayState(state: ActivityState, event: RemoteAgentEvent): void {
		if (state.requestId) {
			return;
		}
		if (event.kind === 'tool.execution_start') {
			rememberToolName(state.toolNames, event.toolCallId, event.toolName);
		}
		if (event.kind === 'assistant.turn_start') {
			state.replayTurnId = event.turnId;
			state.actions.splice(0, state.actions.length,
				{ key: 'attachment', text: l10n.t('Existing session attached') },
				{ key: 'turn', text: l10n.t('Attached to an active turn') });
			return;
		}
		if ((event.kind === 'assistant.turn_end' && event.turnId === state.replayTurnId) || isTerminalEvent(event)) {
			state.replayTurnId = undefined;
			state.actions.splice(0, state.actions.length, { key: 'attachment', text: l10n.t('Existing session attached') });
			state.toolNames.clear();
			return;
		}
		if (!state.replayTurnId) {
			return;
		}
		const toolCallId = getToolCallId(event);
		const mutation = renderTelegramEvent(event, { detail: 'compact', correlatedToolName: toolCallId ? state.toolNames.get(toolCallId) : undefined });
		if (mutation.action) {
			upsertAction(state.actions, mutation.action);
		}
	}

	private scheduleFlush(state: ActivityState, urgent: boolean): void {
		const now = this.scheduler.now();
		const earliestEdit = state.messageId !== undefined ? state.lastFlushAt + minimumEditIntervalMs : now;
		const dueAt = Math.max(earliestEdit, urgent ? now : now + initialFlushDelayMs);
		if (state.flushTimer && (state.flushDueAt ?? Number.POSITIVE_INFINITY) <= dueAt) {
			return;
		}
		state.flushTimer?.dispose();
		state.flushDueAt = dueAt;
		state.flushTimer = this.scheduler.schedule(async () => {
			state.flushTimer = undefined;
			state.flushDueAt = undefined;
			await this.enqueueFlush(state);
		}, Math.max(0, dueAt - now));
	}

	private enqueueFlush(state: ActivityState): Promise<void> {
		const result = this.flushQueue.then(() => this.flush(state));
		this.flushQueue = result.catch(() => { });
		return result;
	}

	private async flush(state: ActivityState): Promise<void> {
		const deliverable = state.connectionClosed ? await this.getDrainingSession(state) : await this.getAuthorizedSession(state.sessionId);
		if (this.activeState !== state || !state.dirty || !deliverable) {
			return;
		}
		const revision = state.revision;
		const text = renderTelegramActivity({
			workstation: this.environment.workstationLabel,
			workspace: state.workingDirectoryLabel,
			session: state.sessionLabel,
			actions: state.actions,
			reasoning: state.reasoning,
			usage: state.usage,
			complete: state.complete,
			detail: this.getActivityDetail(),
		});
		try {
			if (state.messageId === undefined) {
				const message = await this.host.sendMessage(state.chatId, text, { parseMode: 'HTML', disableNotification: true, replyMarkup: state.replyMarkup });
				state.messageId = message.message_id;
			} else if (state.lastMessageText !== text || state.clearReplyMarkupOnNextEdit) {
				await this.host.editMessageText(state.chatId, state.messageId, text, {
					parseMode: 'HTML',
					replyMarkup: state.clearReplyMarkupOnNextEdit ? emptyInlineKeyboard : state.replyMarkup,
				});
			}
			state.lastMessageText = text;
			state.clearReplyMarkupOnNextEdit = false;
		} catch {
			this.logService.warn('[TelegramRemote] Failed to publish a Telegram activity update.');
			return;
		}
		state.lastFlushAt = this.scheduler.now();
		if (state.complete) {
			await this.removeStopControl(state);
			await this.sendFinalAnswer(state);
			this.notifyTerminal(state);
		}
		if (state.revision === revision) {
			state.dirty = false;
		} else {
			this.scheduleFlush(state, false);
		}
	}

	private async sendFinalAnswer(state: ActivityState): Promise<void> {
		const deliverable = state.connectionClosed ? await this.getDrainingSession(state) : await this.getAuthorizedSession(state.sessionId);
		if (!state.requestId || !state.response || state.finalAttempted || !deliverable) {
			return;
		}
		state.finalAttempted = true;
		for (const chunk of renderTelegramMarkdownAnswer(state.response)) {
			const stillDeliverable = state.connectionClosed ? await this.getDrainingSession(state) : await this.getAuthorizedSession(state.sessionId);
			if (this.activeState !== state || !stillDeliverable) {
				return;
			}
			try {
				await this.host.sendMessage(state.chatId, chunk, { parseMode: 'HTML' });
			} catch {
				this.logService.warn('[TelegramRemote] Failed to deliver a Telegram final answer.');
				return;
			}
		}
	}

	private async removeStopControl(state: ActivityState | undefined): Promise<void> {
		if (!state?.replyMarkup) {
			return;
		}
		state.replyMarkup = undefined;
		state.clearReplyMarkupOnNextEdit = false;
		if (state.messageId === undefined) {
			return;
		}
		try {
			await this.host.editMessageReplyMarkup(state.chatId, state.messageId, emptyInlineKeyboard);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to remove a stale Telegram Stop control.');
		}
	}

	private async getAuthorizedSession(sessionId: string, expectedIdentity?: TelegramPairedIdentity, knownItem?: ICopilotCLISessionItem): Promise<AuthorizedActivitySession | undefined> {
		const identity = this.host.pairedIdentity;
		if (!this.host.isAcceptingUpdates || !identity || (expectedIdentity && !sameIdentity(identity, expectedIdentity))
			|| this.sessionState.getSelectedSessionId(identity) !== sessionId) {
			return undefined;
		}
		const item = knownItem ?? await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		const scope = item && this.sessionScopePolicy.authorizeSession(item);
		return item && scope && this.sessionState.getSelectedSessionScopeFingerprint(identity) === scope.fingerprint
			? { identity, item, scope }
			: undefined;
	}

	private async getDrainingSession(state: ActivityState): Promise<AuthorizedActivitySession | undefined> {
		const item = await this.sessionService.getSessionItem(state.sessionId, CancellationToken.None);
		const scope = item && this.sessionScopePolicy.authorizeSession(item);
		return item && scope && scope.fingerprint === state.sessionScopeFingerprint
			? { identity: state.identity, item, scope }
			: undefined;
	}

	private notifyTerminal(state: ActivityState): void {
		if (!state.requestId || !state.terminalOutcome || state.terminalNotified) {
			return;
		}
		state.terminalNotified = true;
		this.terminalEmitter.fire({
			identity: state.identity,
			sessionId: state.sessionId,
			requestId: state.requestId,
			outcome: state.terminalOutcome,
		});
		if (state.connectionClosed) {
			this.sessionState.finishSuspendedDelivery();
			this.host.clearDeliveryClient();
		}
	}

	private dropActiveState(removeStop: boolean): void {
		const state = this.activeState;
		this.reset();
		if (removeStop) {
			void this.removeStopControl(state);
		}
		this.host.clearDeliveryClient();
	}

	private reset(): void {
		this.generation++;
		this.activeState?.flushTimer?.dispose();
		this.activeState = undefined;
	}

	public override dispose(): void {
		this.dropActiveState(true);
		super.dispose();
	}
}

class DefaultTelegramActivityScheduler implements TelegramActivityScheduler {
	now(): number {
		return Date.now();
	}

	schedule(callback: () => Promise<void>, delayMs: number): IDisposable {
		const handle = setTimeout(() => void callback(), delayMs);
		return toDisposable(() => clearTimeout(handle));
	}
}

function upsertAction(actions: TelegramActivityAction[], action: TelegramActivityAction): void {
	const existingIndex = actions.findIndex(candidate => candidate.key === action.key);
	if (existingIndex >= 0) {
		actions.splice(existingIndex, 1);
	}
	actions.push(action);
	while (actions.length > maximumRecentActions) {
		actions.shift();
	}
}

function rememberToolName(toolNames: Map<string, string>, toolCallId: string, toolName: string): void {
	toolNames.delete(toolCallId);
	toolNames.set(toolCallId, toolName);
	while (toolNames.size > maximumCorrelatedTools) {
		toolNames.delete(toolNames.keys().next().value!);
	}
}

function appendBounded(current: string, value: string, maximumLength: number): string {
	return truncate(`${current}${value}`, maximumLength);
}

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function getToolCallId(event: RemoteAgentEvent): string | undefined {
	return event.kind === 'tool.execution_start' || event.kind === 'tool.execution_progress'
		|| event.kind === 'tool.execution_partial_result' || event.kind === 'tool.execution_complete'
		? event.toolCallId
		: undefined;
}

function isTerminalEvent(event: RemoteAgentEvent): boolean {
	return event.kind === 'session.task_complete' || event.kind === 'session.shutdown' || event.kind === 'abort' || event.kind === 'session.idle';
}

function isAgentScopedStream(event: RemoteAgentEvent): boolean {
	return !!event.agentId && event.kind.startsWith('assistant.');
}

function sameIdentity(left: TelegramPairedIdentity, right: TelegramPairedIdentity): boolean {
	return left.pairingId === right.pairingId && left.userId === right.userId && left.chatId === right.chatId;
}
