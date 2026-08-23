/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import type { Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import type { ICopilotCLISessionService } from '../../chatSessions/copilotcli/node/copilotcliSessionService';
import { projectRemoteAgentEvent, type RemoteAgentEvent } from '../common/remoteAgentEvent';
import type { IRemoteControlSessionEvent } from '../common/remoteControlTypes';
import type { TelegramEditMessageTextOptions, TelegramMessage, TelegramSendMessageOptions } from '../common/telegramTypes';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import { TelegramSessionState } from './telegramSessionState';
import { renderTelegramActivity, renderTelegramEvent, type TelegramActivityAction } from './telegramEventRenderer';

const minimumEditIntervalMs = 1_000;
const initialFlushDelayMs = 250;
const maximumRecentActions = 8;
const maximumResponseLength = 12_000;
const maximumReasoningLength = 2_000;
const supersededContinuation = '_Earlier streamed continuation was superseded\\._';

export interface TelegramActivityHost {
	readonly isAcceptingUpdates: boolean;
	readonly pairedIdentity: TelegramPairedIdentity | undefined;
	readonly onDidBlockRemoteAccess: Event<void>;
	readonly onDidChangePairedIdentity: Event<TelegramPairedIdentity | undefined>;
	sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage>;
	editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true>;
}

export interface TelegramActivityScheduler {
	now(): number;
	schedule(callback: () => Promise<void>, delayMs: number): IDisposable;
}

interface TelegramActivityEnvironment {
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
}

interface ActivityState {
	readonly generation: number;
	readonly pairingId: string;
	readonly chatId: number;
	readonly sessionId: string;
	readonly sessionLabel: string;
	readonly actions: TelegramActivityAction[];
	readonly messageIds: number[];
	readonly lastMessageTexts: string[];
	revision: number;
	dirty: boolean;
	complete: boolean;
	sealed: boolean;
	responseMessageId?: string;
	response?: string;
	reasoningId?: string;
	reasoning?: string;
	usage?: string;
	lastFlushAt: number;
	flushDueAt?: number;
	flushTimer?: IDisposable;
}

/** Owns bounded Telegram activity state and rate-limited Bot API send/edit operations. */
export class TelegramActivityCoalescer extends Disposable {
	private readonly scheduler: TelegramActivityScheduler;
	private activeState: ActivityState | undefined;
	private generation = 0;
	private flushQueue = Promise.resolve();

	constructor(
		private readonly host: TelegramActivityHost,
		private readonly sessionState: TelegramSessionState,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly environment: TelegramActivityEnvironment,
		scheduler: TelegramActivityScheduler | undefined,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.scheduler = scheduler ?? new DefaultTelegramActivityScheduler();
		this._register(host.onDidBlockRemoteAccess(() => this.reset()));
		this._register(host.onDidChangePairedIdentity(() => this.reset()));
	}

	async publish(sessionId: string, rawEvent: IRemoteControlSessionEvent): Promise<void> {
		const identity = this.getActiveIdentity(sessionId);
		if (!identity) {
			return;
		}
		const event = projectRemoteAgentEvent(rawEvent);
		if (!event || isAgentScopedStream(event)) {
			return;
		}

		let state = this.activeState;
		if (!state || state.sessionId !== sessionId || state.pairingId !== identity.pairingId || (state.sealed && startsNewActivity(event))) {
			state = await this.createState(identity, sessionId);
			if (!state) {
				return;
			}
		}
		if (this.activeState !== state || !this.getActiveIdentity(sessionId)) {
			return;
		}

		const mutation = renderTelegramEvent(event);
		if (mutation.action) {
			upsertAction(state.actions, mutation.action);
		}
		if (mutation.response && mutation.response.text) {
			if (state.responseMessageId !== mutation.response.messageId) {
				state.responseMessageId = mutation.response.messageId;
				state.response = '';
			}
			state.response = mutation.response.append
				? appendBounded(state.response ?? '', mutation.response.text, maximumResponseLength)
				: truncate(mutation.response.text, maximumResponseLength);
		}
		if (mutation.reasoning && mutation.reasoning.text) {
			if (state.reasoningId !== mutation.reasoning.reasoningId) {
				state.reasoningId = mutation.reasoning.reasoningId;
				state.reasoning = '';
			}
			state.reasoning = mutation.reasoning.append
				? appendBounded(state.reasoning ?? '', mutation.reasoning.text, maximumReasoningLength)
				: truncate(mutation.reasoning.text, maximumReasoningLength);
		}
		state.usage = mutation.usage ?? state.usage;
		state.complete = mutation.terminal ?? state.complete;
		state.dirty = true;
		state.revision++;
		this.scheduleFlush(state, event.source === 'live' && (mutation.urgent === true || mutation.terminal === true));
	}

	private async createState(identity: TelegramPairedIdentity, sessionId: string): Promise<ActivityState | undefined> {
		this.reset();
		const generation = ++this.generation;
		const item = await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		if (generation !== this.generation || !this.getActiveIdentity(sessionId)) {
			return undefined;
		}
		const state: ActivityState = {
			generation,
			pairingId: identity.pairingId,
			chatId: identity.chatId,
			sessionId,
			sessionLabel: item?.label ?? sessionId,
			actions: [],
			messageIds: [],
			lastMessageTexts: [],
			revision: 0,
			dirty: false,
			complete: false,
			sealed: false,
			lastFlushAt: 0,
		};
		this.activeState = state;
		return state;
	}

	private scheduleFlush(state: ActivityState, urgent: boolean): void {
		const now = this.scheduler.now();
		const earliestEdit = state.messageIds.length > 0 ? state.lastFlushAt + minimumEditIntervalMs : now;
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
		if (this.activeState !== state || !state.dirty || !this.getActiveIdentity(state.sessionId)) {
			return;
		}
		const revision = state.revision;
		const chunks = renderTelegramActivity({
			workstation: this.environment.workstationLabel,
			workspace: this.environment.workspaceLabel,
			session: state.sessionLabel,
			actions: state.actions.map(item => item.text),
			response: state.response,
			reasoning: state.reasoning,
			usage: state.usage,
			complete: state.complete,
		});
		const messageCount = Math.max(chunks.length, state.messageIds.length);
		for (let index = 0; index < messageCount; index++) {
			if (this.activeState !== state || !this.getActiveIdentity(state.sessionId)) {
				return;
			}
			const text = chunks[index] ?? supersededContinuation;
			if (state.lastMessageTexts[index] === text) {
				continue;
			}
			try {
				const messageId = state.messageIds[index];
				if (messageId === undefined) {
					const message = await this.host.sendMessage(state.chatId, text, { parseMode: 'MarkdownV2', disableNotification: true });
					state.messageIds[index] = message.message_id;
				} else {
					await this.host.editMessageText(state.chatId, messageId, text, { parseMode: 'MarkdownV2' });
				}
				state.lastMessageTexts[index] = text;
			} catch {
				this.logService.warn('[TelegramRemote] Failed to publish a Telegram activity update.');
			}
		}
		state.lastFlushAt = this.scheduler.now();
		if (state.revision === revision) {
			state.dirty = false;
			state.sealed = state.complete;
		} else {
			this.scheduleFlush(state, false);
		}
	}

	private getActiveIdentity(sessionId: string): TelegramPairedIdentity | undefined {
		const identity = this.host.pairedIdentity;
		return this.host.isAcceptingUpdates && identity && this.sessionState.getSelectedSessionId(identity) === sessionId ? identity : undefined;
	}

	private reset(): void {
		this.generation++;
		this.activeState?.flushTimer?.dispose();
		this.activeState = undefined;
	}

	public override dispose(): void {
		this.reset();
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

function appendBounded(current: string, value: string, maximumLength: number): string {
	return truncate(`${current}${value}`, maximumLength);
}

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function startsNewActivity(event: RemoteAgentEvent): boolean {
	return event.kind !== 'assistant.usage' && event.kind !== 'session.usage_info' && event.kind !== 'session.idle';
}

function isAgentScopedStream(event: RemoteAgentEvent): boolean {
	return !!event.agentId && (event.kind === 'assistant.message' || event.kind === 'assistant.message_delta'
		|| event.kind === 'assistant.reasoning' || event.kind === 'assistant.reasoning_delta');
}
