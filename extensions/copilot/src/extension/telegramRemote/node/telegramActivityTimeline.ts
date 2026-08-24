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
import type { ActivityRound, ActivityRoundMutation } from '../common/activityRound';
import { projectRemoteAgentEvent, type RemoteAgentEvent } from '../common/remoteAgentEvent';
import type { IRemoteControlSessionEvent, IRemotePermissionRequest, IRemoteUserInputRequest, IRemoteUserInputResponse, RemotePermissionResult } from '../common/remoteControlTypes';
import type { TelegramAuthorizedSessionScope, TelegramSessionScopePolicy } from '../common/telegramSessionScope';
import { TelegramBotApiError, type TelegramAnswerCallbackQueryOptions, type TelegramEditRichMessageOptions, type TelegramInlineKeyboardMarkup, type TelegramInputRichMessage, type TelegramMessage, type TelegramSendRichMessageOptions, type TelegramUpdate } from '../common/telegramTypes';
import { ActivityAggregator } from './activityAggregator';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import type { TelegramCallbackConstraints, TelegramCallbackContext, TelegramCallbackInput, TelegramCallbackRegistration } from './telegramCallbackRegistry';
import type { TelegramActivityReplyResolution, TelegramRequestActivity, TelegramRequestTerminalEvent } from './telegramCommandRouter';
import type { TelegramPlanInteractionHandler } from './telegramPlanBridge';
import { renderTelegramActivityRound, type TelegramRichActivityDetail } from './telegramRichRenderer';
import { TelegramSessionState } from './telegramSessionState';

const minimumEditIntervalMs = 750;
const maximumCorrelations = 1_000;
const correlationLifetimeMs = 30 * 60_000;
const emptyInlineKeyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };

export interface TelegramActivityTimelineHost {
	readonly isAcceptingUpdates: boolean;
	readonly pairedIdentity: TelegramPairedIdentity | undefined;
	readonly onDidChangePairedIdentity: Event<TelegramPairedIdentity | undefined>;
	registerCallback(input: TelegramCallbackInput): TelegramCallbackRegistration;
	consumeCallback(update: TelegramUpdate, constraints?: TelegramCallbackConstraints): TelegramCallbackContext | undefined;
	invalidateRequestCallbacks(sessionId: string, requestId: string): void;
	sendRichMessage(chatId: number, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageOptions): Promise<TelegramMessage>;
	editRichMessage(chatId: number, messageId: number, richMessage: TelegramInputRichMessage, options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true>;
	editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<TelegramMessage | true>;
	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void>;
	preserveDeliveryClient(): void;
	clearDeliveryClient(): void;
}

export interface TelegramActivityTimelineScheduler {
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

interface RoundDelivery {
	round: ActivityRound;
	messageId?: number;
	lastSignature?: string;
	replyMarkup?: TelegramInlineKeyboardMarkup;
	lastFlushAt: number;
	dirty: boolean;
	flushTimer?: IDisposable;
}

interface TimelineState {
	readonly generation: number;
	readonly identity: TelegramPairedIdentity;
	readonly sessionId: string;
	readonly scopeFingerprint: string;
	readonly aggregator: ActivityAggregator;
	readonly rounds: Map<string, RoundDelivery>;
	requestId?: string;
	startRoundId?: string;
	requestStarted: boolean;
	complete: boolean;
	connectionClosed: boolean;
	terminalOutcome?: 'completed' | 'failed' | 'cancelled';
	terminalNotified: boolean;
}

interface ActivityCorrelation {
	readonly chatId: number;
	readonly messageId: number;
	readonly generation: number;
	readonly sessionId: string;
	readonly requestId?: string;
	readonly roundId: string;
	readonly createdAt: number;
}

interface PendingInteraction<T> {
	readonly identity: TelegramPairedIdentity;
	readonly sessionId: string;
	readonly requestId: string;
	readonly roundId: string;
	readonly messageId: number;
	readonly allowFreeform: boolean;
	readonly resolve: (value: T | undefined, reason: 'remote' | 'cancelled') => void;
}

/** Owns the granular Telegram activity timeline and reply/callback correlation. */
export class TelegramActivityTimeline extends Disposable implements TelegramRequestActivity {
	private readonly terminalEmitter = this._register(new Emitter<TelegramRequestTerminalEvent>());
	readonly onDidReachTerminal = this.terminalEmitter.event;
	private readonly scheduler: TelegramActivityTimelineScheduler;
	private readonly correlations = new Map<string, ActivityCorrelation>();
	private readonly pendingPermissions = new Map<string, PendingInteraction<RemotePermissionResult>>();
	private readonly pendingQuestions = new Map<string, PendingInteraction<IRemoteUserInputResponse>>();
	private planInteractionHandler: TelegramPlanInteractionHandler | undefined;
	private activeState: TimelineState | undefined;
	private generation = 0;
	private deliveryQueue = Promise.resolve();

	constructor(
		private readonly host: TelegramActivityTimelineHost,
		private readonly sessionState: TelegramSessionState,
		private readonly sessionService: ICopilotCLISessionService,
		_environment: TelegramActivityEnvironment,
		private readonly sessionScopePolicy: TelegramSessionScopePolicy,
		private readonly getActivityDetail: () => TelegramRichActivityDetail,
		scheduler: TelegramActivityTimelineScheduler | undefined,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.scheduler = scheduler ?? new DefaultTimelineScheduler();
		this._register(host.onDidChangePairedIdentity(identity => {
			if (!identity) {
				this.dropActiveState(true);
			}
		}));
	}

	setPlanInteractionHandler(handler: TelegramPlanInteractionHandler): IDisposable {
		if (this.planInteractionHandler) {
			throw new Error('A Telegram plan interaction handler is already registered.');
		}
		this.planInteractionHandler = handler;
		return toDisposable(() => {
			if (this.planInteractionHandler === handler) {
				this.planInteractionHandler = undefined;
			}
		});
	}

	async beginRequest(identity: TelegramPairedIdentity, session: ICopilotCLISessionItem, requestId: string, replyMarkup: TelegramInlineKeyboardMarkup): Promise<{ readonly generation: number; readonly messageId: number } | undefined> {
		const authorized = await this.getAuthorizedSession(session.id, identity, session);
		if (!authorized) {
			return undefined;
		}
		await this.removeStopControl(this.activeState);
		this.reset();
		const state = this.createState(authorized, requestId);
		this.activeState = state;
		const mutation = state.aggregator.beginRequest();
		state.startRoundId = mutation.round.id;
		await this.publishMutation(state, mutation, replyMarkup, true);
		const messageId = state.rounds.get(mutation.round.id)?.messageId;
		return messageId === undefined ? undefined : { generation: state.generation, messageId };
	}

	async completeRequest(identity: TelegramPairedIdentity, sessionId: string, requestId: string, outcome: 'completed' | 'failed' | 'cancelled' | 'superseded'): Promise<void> {
		const state = this.activeState;
		if (!state || !sameIdentity(state.identity, identity) || state.sessionId !== sessionId || state.requestId !== requestId || state.complete) {
			return;
		}
		state.complete = true;
		state.terminalOutcome = outcome === 'superseded' ? undefined : outcome;
		await this.removeStopControl(state);
		const mutation = state.aggregator.completeRequest(outcome);
		if (mutation) {
			await this.publishMutation(state, mutation, undefined, true);
		}
		this.notifyTerminal(state);
	}

	isStopControl(sessionId: string, requestId: string, generation: number, messageId: number): boolean {
		const state = this.activeState;
		if (!state || state.sessionId !== sessionId || state.requestId !== requestId || state.generation !== generation || !state.startRoundId) {
			return false;
		}
		const start = state.rounds.get(state.startRoundId);
		return start?.messageId === messageId && containsControls(start.replyMarkup);
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
		void this.removeStopControl(state);
		return state.sessionId;
	}

	async publish(sessionId: string, rawEvent: IRemoteControlSessionEvent): Promise<void> {
		const drainingState = this.activeState?.connectionClosed && this.activeState.sessionId === sessionId ? this.activeState : undefined;
		const authorized = drainingState ? await this.getDrainingSession(drainingState) : await this.getAuthorizedSession(sessionId);
		if (!authorized) {
			return;
		}
		const event = projectRemoteAgentEvent(rawEvent);
		if (!event || isAgentScopedStream(event)) {
			return;
		}
		let state = this.activeState;
		if (!state || state.sessionId !== sessionId || state.scopeFingerprint !== authorized.scope.fingerprint || !sameIdentity(state.identity, authorized.identity)) {
			this.reset();
			state = this.createState(authorized, undefined);
			this.activeState = state;
		}
		if (!state.requestStarted) {
			if (isRequestActivityEvent(event)) {
				state.requestStarted = true;
			} else if (event.kind === 'session.idle' || event.kind === 'session.task_complete' || event.kind === 'abort') {
				// A selected SDK session can still emit the previous turn's idle/terminal
				// edge while the native remote prompt is being opened. It must not retire
				// the new request's Stop control before that request actually starts.
				return;
			} else if (isTerminalEvent(event)) {
				state.requestStarted = true;
			}
		}
		for (const mutation of state.aggregator.accept(event)) {
			await this.publishMutation(state, mutation, undefined, isUrgent(event, mutation.round));
		}
		if (isTerminalEvent(event) && !state.complete) {
			state.complete = true;
			state.terminalOutcome = terminalOutcome(event);
			await this.removeStopControl(state);
			this.notifyTerminal(state);
		}
	}

	async requestPermission(sessionId: string, request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> {
		const state = await this.ensureInteractiveState(sessionId);
		if (!state || token.isCancellationRequested) {
			return undefined;
		}
		const mutation = state.aggregator.createPermission(request);
		const approve = this.host.registerCallback({ identity: state.identity, sessionId, requestId: request.requestId, toolCallId: request.permissionRequest.toolCallId, action: 'permission.approveOnce' });
		const deny = this.host.registerCallback({ identity: state.identity, sessionId, requestId: request.requestId, toolCallId: request.permissionRequest.toolCallId, action: 'permission.deny' });
		const replyMarkup: TelegramInlineKeyboardMarkup = { inline_keyboard: [[
			{ text: l10n.t('Approve once'), callback_data: approve.callbackData },
			{ text: l10n.t('Deny'), callback_data: deny.callbackData },
		]] };
		await this.publishMutation(state, mutation, replyMarkup, true);
		const messageId = state.rounds.get(mutation.round.id)?.messageId;
		if (messageId === undefined) {
			this.host.invalidateRequestCallbacks(sessionId, request.requestId);
			return undefined;
		}
		return new Promise(resolve => {
			let settled = false;
			let cancellation: IDisposable = Disposable.None;
			const key = interactionKey(sessionId, request.requestId);
			const complete = (value: RemotePermissionResult | undefined, reason: 'remote' | 'cancelled') => {
				if (settled) {
					return;
				}
				settled = true;
				cancellation.dispose();
				this.pendingPermissions.delete(key);
				this.host.invalidateRequestCallbacks(sessionId, request.requestId);
				void this.finishInteraction(state, mutation.round.id, reason === 'remote'
					? value?.kind === 'approve-once' ? l10n.t('Permission approved once') : l10n.t('Permission denied')
					: l10n.t('Permission answered locally or expired'), value?.kind === 'approve-once' ? 'completed' : 'failed');
				resolve(value);
			};
			this.pendingPermissions.set(key, { identity: state.identity, sessionId, requestId: request.requestId, roundId: mutation.round.id, messageId, allowFreeform: false, resolve: complete });
			cancellation = token.onCancellationRequested(() => complete(undefined, 'cancelled'));
			if (token.isCancellationRequested) {
				complete(undefined, 'cancelled');
			}
		});
	}

	async requestUserInput(sessionId: string, request: IRemoteUserInputRequest, token: CancellationToken): Promise<IRemoteUserInputResponse | undefined> {
		const state = await this.ensureInteractiveState(sessionId);
		if (!state || token.isCancellationRequested) {
			return undefined;
		}
		const mutation = state.aggregator.createQuestion(request);
		const rows = request.choices.slice(0, 12).map(choice => {
			const callback = this.host.registerCallback({ identity: state.identity, sessionId, requestId: request.requestId, toolCallId: request.toolCallId, action: 'input.choice', value: choice });
			return [{ text: choice.slice(0, 64), callback_data: callback.callbackData }];
		});
		await this.publishMutation(state, mutation, rows.length > 0 ? { inline_keyboard: rows } : undefined, true);
		const messageId = state.rounds.get(mutation.round.id)?.messageId;
		if (messageId === undefined) {
			this.host.invalidateRequestCallbacks(sessionId, request.requestId);
			return undefined;
		}
		return new Promise(resolve => {
			let settled = false;
			let cancellation: IDisposable = Disposable.None;
			const key = interactionKey(sessionId, request.requestId);
			const complete = (value: IRemoteUserInputResponse | undefined, reason: 'remote' | 'cancelled') => {
				if (settled) {
					return;
				}
				settled = true;
				cancellation.dispose();
				this.pendingQuestions.delete(key);
				this.host.invalidateRequestCallbacks(sessionId, request.requestId);
				void this.finishInteraction(state, mutation.round.id, reason === 'remote' && value
					? l10n.t('Answered: {0}', value.answer) : l10n.t('Question answered locally or expired'), 'completed');
				resolve(value);
			};
			this.pendingQuestions.set(key, { identity: state.identity, sessionId, requestId: request.requestId, roundId: mutation.round.id, messageId, allowFreeform: request.allowFreeform, resolve: complete });
			cancellation = token.onCancellationRequested(() => complete(undefined, 'cancelled'));
			if (token.isCancellationRequested) {
				complete(undefined, 'cancelled');
			}
		});
	}

	async handleCallback(update: TelegramUpdate, identity: TelegramPairedIdentity): Promise<boolean> {
		const context = this.host.consumeCallback(update);
		if (!context) {
			return false;
		}
		if (this.planInteractionHandler && await this.planInteractionHandler.handlePlanCallback(update, identity, context)) {
			return true;
		}
		if (context.action !== 'permission.approveOnce' && context.action !== 'permission.deny' && context.action !== 'input.choice') {
			return false;
		}
		const callbackId = update.callback_query?.id;
		const messageId = update.callback_query?.message?.message_id;
		if (!callbackId || messageId === undefined || context.chatId !== identity.chatId) {
			return false;
		}
		if (context.action === 'permission.approveOnce' || context.action === 'permission.deny') {
			const pending = this.pendingPermissions.get(interactionKey(context.sessionId, context.requestId));
			if (!pending || pending.messageId !== messageId || !sameIdentity(pending.identity, identity)) {
				await this.safeAnswer(callbackId, { text: l10n.t('This permission control is stale.'), showAlert: true });
				return true;
			}
			pending.resolve(context.action === 'permission.approveOnce' ? { kind: 'approve-once' } : { kind: 'denied-interactively-by-user' }, 'remote');
			await this.safeAnswer(callbackId, { text: context.action === 'permission.approveOnce' ? l10n.t('Approved once.') : l10n.t('Denied.') });
			return true;
		}
		const pending = this.pendingQuestions.get(interactionKey(context.sessionId, context.requestId));
		if (!pending || pending.messageId !== messageId || !sameIdentity(pending.identity, identity) || context.value === undefined) {
			await this.safeAnswer(callbackId, { text: l10n.t('This answer control is stale.'), showAlert: true });
			return true;
		}
		pending.resolve({ answer: context.value, wasFreeform: false }, 'remote');
		await this.safeAnswer(callbackId, { text: l10n.t('Answer sent.') });
		return true;
	}

	async resolveReply(update: TelegramUpdate, identity: TelegramPairedIdentity): Promise<TelegramActivityReplyResolution> {
		if (this.planInteractionHandler) {
			const planReply = await this.planInteractionHandler.resolvePlanReply(update, identity);
			if (planReply.kind !== 'none') {
				return planReply;
			}
		}
		const replyMessageId = update.message?.reply_to_message?.message_id;
		const text = update.message?.text?.trim();
		if (replyMessageId === undefined || !text) {
			return { kind: 'none' };
		}
		for (const pending of this.pendingQuestions.values()) {
			if (pending.messageId === replyMessageId && pending.allowFreeform && sameIdentity(pending.identity, identity)) {
				pending.resolve({ answer: text, wasFreeform: true }, 'remote');
				return { kind: 'handled' };
			}
		}
		this.purgeCorrelations();
		const correlation = this.correlations.get(correlationKey(identity.chatId, replyMessageId));
		if (!correlation) {
			return { kind: 'none' };
		}
		const state = this.activeState;
		const delivery = state?.rounds.get(correlation.roundId);
		if (!state || state.generation !== correlation.generation || state.sessionId !== correlation.sessionId || state.complete
			|| delivery?.messageId !== replyMessageId || !delivery.round.steerable || !sameIdentity(state.identity, identity)) {
			return { kind: 'stale' };
		}
		return { kind: 'steer', sessionId: correlation.sessionId, requestId: correlation.requestId, activityRoundId: correlation.roundId };
	}

	private async ensureInteractiveState(sessionId: string): Promise<TimelineState | undefined> {
		const authorized = await this.getAuthorizedSession(sessionId);
		if (!authorized) {
			return undefined;
		}
		let state = this.activeState;
		if (!state || state.sessionId !== sessionId || state.complete || !sameIdentity(state.identity, authorized.identity)) {
			this.reset();
			state = this.createState(authorized, undefined);
			this.activeState = state;
		}
		return state;
	}

	private createState(authorized: AuthorizedActivitySession, requestId: string | undefined): TimelineState {
		return {
			generation: ++this.generation,
			identity: authorized.identity,
			sessionId: authorized.item.id,
			scopeFingerprint: authorized.scope.fingerprint,
			aggregator: new ActivityAggregator(authorized.item.id, requestId, () => this.scheduler.now()),
			rounds: new Map(),
			requestId,
			requestStarted: requestId === undefined,
			complete: false,
			connectionClosed: false,
			terminalNotified: false,
		};
	}

	private async publishMutation(state: TimelineState, mutation: ActivityRoundMutation, replyMarkup?: TelegramInlineKeyboardMarkup, urgent = false): Promise<void> {
		if (this.activeState !== state) {
			return;
		}
		let delivery = state.rounds.get(mutation.round.id);
		if (!delivery) {
			delivery = { round: mutation.round, replyMarkup, lastFlushAt: 0, dirty: true };
			state.rounds.set(mutation.round.id, delivery);
		} else {
			delivery.round = mutation.round;
			delivery.replyMarkup = replyMarkup ?? delivery.replyMarkup;
			delivery.dirty = true;
		}
		// Assistant text is provisional until a tool boundary or terminal event tells
		// us whether it was a tool preface or the final answer. Holding it here avoids
		// a short-lived, content-free "Agent response" bubble.
		if (mutation.isNew && mutation.round.type === 'answer' && mutation.round.status === 'running') {
			return;
		}
		if (mutation.isNew || urgent) {
			await this.enqueueFlush(state, delivery);
		} else {
			this.scheduleFlush(state, delivery);
		}
	}

	private scheduleFlush(state: TimelineState, delivery: RoundDelivery): void {
		if (delivery.flushTimer) {
			return;
		}
		const delay = Math.max(0, delivery.lastFlushAt + minimumEditIntervalMs - this.scheduler.now());
		delivery.flushTimer = this.scheduler.schedule(async () => {
			delivery.flushTimer = undefined;
			await this.enqueueFlush(state, delivery);
		}, delay);
	}

	private enqueueFlush(state: TimelineState, delivery: RoundDelivery): Promise<void> {
		const result = this.deliveryQueue.then(() => this.flush(state, delivery));
		this.deliveryQueue = result.catch(() => { });
		return result;
	}

	private async flush(state: TimelineState, delivery: RoundDelivery): Promise<void> {
		const authorized = state.connectionClosed ? await this.getDrainingSession(state) : await this.getAuthorizedSession(state.sessionId);
		if (this.activeState !== state || !delivery.dirty || !authorized) {
			return;
		}
		const richMessage = renderTelegramActivityRound(delivery.round, this.getActivityDetail());
		const signature = JSON.stringify({ richMessage, replyMarkup: delivery.replyMarkup });
		try {
			if (delivery.messageId === undefined) {
				const message = await this.host.sendRichMessage(state.identity.chatId, richMessage, { disableNotification: delivery.round.status === 'running', replyMarkup: delivery.replyMarkup });
				delivery.messageId = message.message_id;
				this.rememberCorrelation(state, delivery);
			} else if (delivery.lastSignature !== signature) {
				try {
					await this.host.editRichMessage(state.identity.chatId, delivery.messageId, richMessage, { replyMarkup: delivery.replyMarkup });
				} catch (error) {
					if (error instanceof TelegramBotApiError && error.apiFailureReason === 'message-not-modified') {
						delivery.lastSignature = signature;
						delivery.dirty = false;
						return;
					}
					const replacement = await this.host.sendRichMessage(state.identity.chatId, richMessage, {
						replyMarkup: delivery.replyMarkup,
						replyParameters: { message_id: delivery.messageId, allow_sending_without_reply: true },
					});
					delivery.messageId = replacement.message_id;
					this.rememberCorrelation(state, delivery);
					this.logService.warn('[TelegramRemote] Rich activity edit failed; sent a replacement message.');
				}
			}
			delivery.lastSignature = signature;
			delivery.lastFlushAt = this.scheduler.now();
			delivery.dirty = false;
		} catch (error) {
			this.logService.warn('[TelegramRemote] Failed to publish a Telegram Rich activity message.');
			const retryAfterMs = error instanceof TelegramBotApiError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1_000 : 2_000;
			delivery.flushTimer?.dispose();
			delivery.flushTimer = this.scheduler.schedule(async () => {
				delivery.flushTimer = undefined;
				await this.enqueueFlush(state, delivery);
			}, retryAfterMs);
		}
	}

	private rememberCorrelation(state: TimelineState, delivery: RoundDelivery): void {
		if (delivery.messageId === undefined) {
			return;
		}
		const correlation: ActivityCorrelation = {
			chatId: state.identity.chatId,
			messageId: delivery.messageId,
			generation: state.generation,
			sessionId: state.sessionId,
			requestId: state.requestId,
			roundId: delivery.round.id,
			createdAt: this.scheduler.now(),
		};
		this.correlations.set(correlationKey(correlation.chatId, correlation.messageId), correlation);
		this.purgeCorrelations();
		while (this.correlations.size > maximumCorrelations) {
			this.correlations.delete(this.correlations.keys().next().value!);
		}
	}

	private purgeCorrelations(): void {
		const cutoff = this.scheduler.now() - correlationLifetimeMs;
		for (const [key, correlation] of this.correlations) {
			if (correlation.createdAt < cutoff) {
				this.correlations.delete(key);
			}
		}
	}

	private async finishInteraction(state: TimelineState, roundId: string, summary: string, status: 'completed' | 'failed'): Promise<void> {
		const mutation = state.aggregator.completeInteractive(roundId, summary, status);
		const delivery = state.rounds.get(roundId);
		if (!mutation || !delivery) {
			return;
		}
		delivery.replyMarkup = emptyInlineKeyboard;
		await this.publishMutation(state, mutation, emptyInlineKeyboard, true);
	}

	private async removeStopControl(state: TimelineState | undefined): Promise<void> {
		if (!state?.startRoundId) {
			return;
		}
		const delivery = state.rounds.get(state.startRoundId);
		if (!delivery || !containsControls(delivery.replyMarkup)) {
			return;
		}
		delivery.replyMarkup = emptyInlineKeyboard;
		if (delivery.messageId === undefined) {
			return;
		}
		try {
			await this.host.editMessageReplyMarkup(state.identity.chatId, delivery.messageId, emptyInlineKeyboard);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to remove a stale Telegram Stop control.');
		}
	}

	private async safeAnswer(callbackQueryId: string, options: TelegramAnswerCallbackQueryOptions): Promise<void> {
		try {
			await this.host.answerCallbackQuery(callbackQueryId, options);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to answer a Telegram activity callback.');
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
		return item && scope && this.sessionState.getSelectedSessionScopeFingerprint(identity) === scope.fingerprint ? { identity, item, scope } : undefined;
	}

	private async getDrainingSession(state: TimelineState): Promise<AuthorizedActivitySession | undefined> {
		const item = await this.sessionService.getSessionItem(state.sessionId, CancellationToken.None);
		const scope = item && this.sessionScopePolicy.authorizeSession(item);
		return item && scope && scope.fingerprint === state.scopeFingerprint ? { identity: state.identity, item, scope } : undefined;
	}

	private notifyTerminal(state: TimelineState): void {
		if (!state.requestId || !state.terminalOutcome || state.terminalNotified) {
			return;
		}
		state.terminalNotified = true;
		this.terminalEmitter.fire({ identity: state.identity, sessionId: state.sessionId, requestId: state.requestId, outcome: state.terminalOutcome });
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
		for (const delivery of this.activeState?.rounds.values() ?? []) {
			delivery.flushTimer?.dispose();
		}
		for (const pending of this.pendingPermissions.values()) {
			void this.clearInteractionControls(pending);
			pending.resolve(undefined, 'cancelled');
		}
		for (const pending of this.pendingQuestions.values()) {
			void this.clearInteractionControls(pending);
			pending.resolve(undefined, 'cancelled');
		}
		this.pendingPermissions.clear();
		this.pendingQuestions.clear();
		this.activeState = undefined;
	}

	private async clearInteractionControls<T>(pending: PendingInteraction<T>): Promise<void> {
		try {
			await this.host.editMessageReplyMarkup(pending.identity.chatId, pending.messageId, emptyInlineKeyboard);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to remove stale Telegram interaction controls.');
		}
	}

	public override dispose(): void {
		this.dropActiveState(true);
		super.dispose();
	}
}

class DefaultTimelineScheduler implements TelegramActivityTimelineScheduler {
	now(): number {
		return Date.now();
	}

	schedule(callback: () => Promise<void>, delayMs: number): IDisposable {
		const handle = setTimeout(() => void callback(), delayMs);
		return toDisposable(() => clearTimeout(handle));
	}
}

function correlationKey(chatId: number, messageId: number): string {
	return `${chatId}:${messageId}`;
}

function interactionKey(sessionId: string, requestId: string): string {
	return `${sessionId}:${requestId}`;
}

function containsControls(markup: TelegramInlineKeyboardMarkup | undefined): boolean {
	return !!markup?.inline_keyboard.some(row => row.length > 0);
}

function sameIdentity(left: TelegramPairedIdentity, right: TelegramPairedIdentity): boolean {
	return left.pairingId === right.pairingId && left.userId === right.userId && left.chatId === right.chatId;
}

function isTerminalEvent(event: RemoteAgentEvent): boolean {
	return event.kind === 'session.task_complete' || event.kind === 'session.shutdown' || event.kind === 'session.error' || event.kind === 'abort' || event.kind === 'session.idle';
}

function isRequestActivityEvent(event: RemoteAgentEvent): boolean {
	return event.kind === 'assistant.turn_start'
		|| event.kind === 'assistant.intent'
		|| event.kind === 'assistant.reasoning'
		|| event.kind === 'assistant.reasoning_delta'
		|| event.kind === 'assistant.message'
		|| event.kind === 'assistant.message_delta'
		|| event.kind === 'tool.execution_start'
		|| event.kind === 'tool.execution_progress'
		|| event.kind === 'tool.execution_partial_result'
		|| event.kind === 'tool.execution_complete'
		|| event.kind === 'subagent.started'
		|| event.kind === 'subagent.completed'
		|| event.kind === 'subagent.failed';
}

function terminalOutcome(event: RemoteAgentEvent): 'completed' | 'failed' | 'cancelled' {
	if (event.kind === 'abort' || (event.kind === 'session.idle' && event.aborted)) {
		return 'cancelled';
	}
	if (event.kind === 'session.error' || event.kind === 'session.shutdown' || (event.kind === 'session.task_complete' && event.success === false)) {
		return 'failed';
	}
	return 'completed';
}

function isUrgent(event: RemoteAgentEvent, round: ActivityRound): boolean {
	return round.status === 'failed' || round.status === 'waiting' || isTerminalEvent(event) || event.kind === 'tool.execution_start' || event.kind === 'subagent.started';
}

function isAgentScopedStream(event: RemoteAgentEvent): boolean {
	return !!event.agentId && (event.kind === 'assistant.message' || event.kind === 'assistant.message_delta'
		|| event.kind === 'assistant.reasoning' || event.kind === 'assistant.reasoning_delta');
}
