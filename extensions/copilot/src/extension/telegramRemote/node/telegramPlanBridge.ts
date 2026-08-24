/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import type { Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import type { ICopilotCLISessionService } from '../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteExitPlanModeRequest, IRemoteExitPlanModeResponse, RemoteExitPlanModeAction } from '../common/remoteControlTypes';
import type { TelegramSessionScopePolicy } from '../common/telegramSessionScope';
import type { TelegramAnswerCallbackQueryOptions, TelegramEditRichMessageOptions, TelegramInlineKeyboardMarkup, TelegramInputRichMessage, TelegramMessage, TelegramSendRichMessageOptions, TelegramUpdate } from '../common/telegramTypes';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import type { TelegramCallbackContext, TelegramCallbackInput, TelegramCallbackRegistration } from './telegramCallbackRegistry';
import type { TelegramActivityReplyResolution } from './telegramCommandRouter';
import { renderTelegramMarkdownRichText } from './telegramMarkdown';
import { TelegramSessionState } from './telegramSessionState';

const emptyInlineKeyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };
const maximumFeedbackLength = 4_096;

export interface TelegramPlanBridgeHost {
	readonly isAcceptingUpdates: boolean;
	readonly pairedIdentity: TelegramPairedIdentity | undefined;
	readonly onDidBlockRemoteAccess: Event<void>;
	readonly onDidChangePairedIdentity: Event<TelegramPairedIdentity | undefined>;
	registerCallback(input: TelegramCallbackInput): TelegramCallbackRegistration;
	invalidateRequestCallbacks(sessionId: string, requestId: string): void;
	sendRichMessage(chatId: number, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageOptions): Promise<TelegramMessage>;
	editRichMessage(chatId: number, messageId: number, richMessage: TelegramInputRichMessage, options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true>;
	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void>;
}

/** Callback/reply surface delegated by the activity timeline after one-shot callback consumption. */
export interface TelegramPlanInteractionHandler {
	handlePlanCallback(update: TelegramUpdate, identity: TelegramPairedIdentity, context: TelegramCallbackContext): Promise<boolean>;
	resolvePlanReply(update: TelegramUpdate, identity: TelegramPairedIdentity): Promise<TelegramActivityReplyResolution>;
}

interface PendingPlanRequest {
	readonly identity: TelegramPairedIdentity;
	readonly sessionId: string;
	readonly request: IRemoteExitPlanModeRequest;
	readonly messageId: number;
	readonly resolve: (value: IRemoteExitPlanModeResponse | undefined, reason: 'remote' | 'cancelled') => void;
}

/** Secure Telegram response bridge for the SDK exit-plan-mode interaction. */
export class TelegramPlanBridge extends Disposable implements TelegramPlanInteractionHandler {
	private readonly pending = new Map<string, PendingPlanRequest>();

	constructor(
		private readonly host: TelegramPlanBridgeHost,
		private readonly sessionState: TelegramSessionState,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly sessionScopePolicy: TelegramSessionScopePolicy,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(host.onDidBlockRemoteAccess(() => this.cancelAll()));
		this._register(host.onDidChangePairedIdentity(() => this.cancelAll()));
	}

	async requestExitPlanMode(sessionId: string, request: IRemoteExitPlanModeRequest, token: CancellationToken): Promise<IRemoteExitPlanModeResponse | undefined> {
		const identity = await this.getAuthorizedIdentity(sessionId);
		if (!identity || token.isCancellationRequested) {
			return undefined;
		}

		const key = planRequestKey(sessionId, request.requestId, request.toolCallId);
		this.pending.get(key)?.resolve(undefined, 'cancelled');
		try {
			const rows: Array<Array<{ text: string; callback_data: string }>> = [];
			const callbacks: readonly TelegramCallbackRegistration[] = request.actions.map(action => this.host.registerCallback({
				identity,
				sessionId,
				requestId: request.requestId,
				toolCallId: request.toolCallId,
				action: action === 'interactive' ? 'plan.interactive' : 'plan.exitOnly',
			}));
			request.actions.forEach((action, index) => rows.push([{
				text: planActionLabel(action, action === request.recommendedAction),
				callback_data: callbacks[index].callbackData,
			}]));
			const deny = this.host.registerCallback({
				identity,
				sessionId,
				requestId: request.requestId,
				toolCallId: request.toolCallId,
				action: 'plan.deny',
			});
			rows.push([{ text: l10n.t('Reject Plan'), callback_data: deny.callbackData }]);
			const message = await this.host.sendRichMessage(identity.chatId, renderPlanRequest(request), {
				replyMarkup: { inline_keyboard: rows },
			});
			const currentIdentity = await this.getAuthorizedIdentity(sessionId);
			if (token.isCancellationRequested || !currentIdentity || !sameIdentity(identity, currentIdentity)) {
				this.host.invalidateRequestCallbacks(sessionId, request.requestId);
				await this.finishRequest(identity, message.message_id, request, undefined, 'cancelled');
				return undefined;
			}
			return await new Promise(resolve => {
				let settled = false;
				let cancellationListener: IDisposable = Disposable.None;
				const complete = (value: IRemoteExitPlanModeResponse | undefined, reason: 'remote' | 'cancelled') => {
					if (settled) {
						return;
					}
					settled = true;
					cancellationListener.dispose();
					this.pending.delete(key);
					this.host.invalidateRequestCallbacks(sessionId, request.requestId);
					void this.finishRequest(identity, message.message_id, request, value, reason);
					resolve(value);
				};
				this.pending.set(key, { identity, sessionId, request, messageId: message.message_id, resolve: complete });
				cancellationListener = token.onCancellationRequested(() => complete(undefined, 'cancelled'));
				if (token.isCancellationRequested) {
					complete(undefined, 'cancelled');
				}
			});
		} catch {
			this.host.invalidateRequestCallbacks(sessionId, request.requestId);
			this.logService.warn('[TelegramRemote] Failed to publish a plan approval request.');
			return undefined;
		}
	}

	async handlePlanCallback(update: TelegramUpdate, identity: TelegramPairedIdentity, context: TelegramCallbackContext): Promise<boolean> {
		if (context.action !== 'plan.interactive' && context.action !== 'plan.exitOnly' && context.action !== 'plan.deny') {
			return false;
		}
		const callbackId = update.callback_query?.id;
		const messageId = update.callback_query?.message?.message_id;
		const pending = this.pending.get(planRequestKey(context.sessionId, context.requestId, context.toolCallId));
		if (!callbackId || messageId === undefined || !pending || pending.messageId !== messageId || !sameIdentity(pending.identity, identity)
			|| pending.request.toolCallId !== context.toolCallId || !await this.isStillAuthorized(pending)) {
			if (callbackId) {
				await this.safeAnswer(callbackId, { text: l10n.t('This plan control is stale.'), showAlert: true });
			}
			return true;
		}
		if (context.action === 'plan.deny') {
			pending.resolve({ approved: false }, 'remote');
			await this.safeAnswer(callbackId, { text: l10n.t('Plan rejected.') });
			return true;
		}
		const action: RemoteExitPlanModeAction = context.action === 'plan.interactive' ? 'interactive' : 'exit_only';
		if (!pending.request.actions.includes(action)) {
			await this.safeAnswer(callbackId, { text: l10n.t('This plan action is unavailable.'), showAlert: true });
			return true;
		}
		pending.resolve({ approved: true, selectedAction: action }, 'remote');
		await this.safeAnswer(callbackId, { text: l10n.t('Plan approved.') });
		return true;
	}

	async resolvePlanReply(update: TelegramUpdate, identity: TelegramPairedIdentity): Promise<TelegramActivityReplyResolution> {
		const replyMessageId = update.message?.reply_to_message?.message_id;
		const feedback = update.message?.text?.trim().slice(0, maximumFeedbackLength);
		if (replyMessageId === undefined || !feedback) {
			return { kind: 'none' };
		}
		const pending = [...this.pending.values()].find(candidate => candidate.messageId === replyMessageId && sameIdentity(candidate.identity, identity));
		if (!pending) {
			return { kind: 'none' };
		}
		if (!await this.isStillAuthorized(pending)) {
			return { kind: 'stale' };
		}
		pending.resolve({ approved: false, feedback }, 'remote');
		return { kind: 'handled' };
	}

	private async getAuthorizedIdentity(sessionId: string): Promise<TelegramPairedIdentity | undefined> {
		const identity = this.host.pairedIdentity;
		if (!this.host.isAcceptingUpdates || !identity || this.sessionState.getSelectedSessionId(identity) !== sessionId) {
			return undefined;
		}
		const item = await this.sessionService.getSessionItem(sessionId, CancellationToken.None);
		const scope = item && this.sessionScopePolicy.authorizeSession(item);
		return item && scope && this.sessionState.getSelectedSessionScopeFingerprint(identity) === scope.fingerprint ? identity : undefined;
	}

	private async isStillAuthorized(pending: PendingPlanRequest): Promise<boolean> {
		const identity = await this.getAuthorizedIdentity(pending.sessionId);
		return !!identity && sameIdentity(identity, pending.identity);
	}

	private async finishRequest(identity: TelegramPairedIdentity, messageId: number, request: IRemoteExitPlanModeRequest, response: IRemoteExitPlanModeResponse | undefined, reason: 'remote' | 'cancelled'): Promise<void> {
		try {
			await this.host.editRichMessage(identity.chatId, messageId, renderPlanResult(request, response, reason), { replyMarkup: emptyInlineKeyboard });
		} catch {
			this.logService.warn('[TelegramRemote] Failed to retire Telegram plan controls.');
		}
	}

	private async safeAnswer(callbackQueryId: string, options: TelegramAnswerCallbackQueryOptions): Promise<void> {
		try {
			await this.host.answerCallbackQuery(callbackQueryId, options);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to answer a Telegram plan callback.');
		}
	}

	private cancelAll(): void {
		for (const pending of [...this.pending.values()]) {
			pending.resolve(undefined, 'cancelled');
		}
	}

	public override dispose(): void {
		this.cancelAll();
		super.dispose();
	}
}

function renderPlanRequest(request: IRemoteExitPlanModeRequest): TelegramInputRichMessage {
	const plan = request.planContent?.trim() || request.summary;
	return {
		blocks: [
			{ type: 'heading', size: 3, text: l10n.t('Review Copilot Plan') },
			{ type: 'paragraph', text: renderTelegramMarkdownRichText(request.summary) },
			{ type: 'details', summary: l10n.t('Plan'), blocks: [{ type: 'paragraph', text: renderTelegramMarkdownRichText(plan) }], is_open: true },
			{ type: 'paragraph', text: l10n.t('Choose a safe action below, or reply to this message with feedback.') },
		],
		skip_entity_detection: true,
	};
}

function renderPlanResult(request: IRemoteExitPlanModeRequest, response: IRemoteExitPlanModeResponse | undefined, reason: 'remote' | 'cancelled'): TelegramInputRichMessage {
	const result = reason === 'cancelled' || !response
		? l10n.t('Plan answered locally or expired')
		: response.approved && response.selectedAction === 'interactive'
			? l10n.t('Plan approved for interactive implementation')
			: response.approved
				? l10n.t('Plan approved without implementation')
				: response.feedback
					? l10n.t('Plan feedback sent')
					: l10n.t('Plan rejected');
	return {
		blocks: [
			{ type: 'heading', size: 3, text: l10n.t('Copilot Plan') },
			{ type: 'paragraph', text: renderTelegramMarkdownRichText(request.summary) },
			{ type: 'paragraph', text: [{ type: 'bold', text: result }] },
		],
		skip_entity_detection: true,
	};
}

function planActionLabel(action: RemoteExitPlanModeAction, recommended: boolean): string {
	const label = action === 'interactive' ? l10n.t('Implement Plan') : l10n.t('Approve Plan Only');
	return recommended ? l10n.t('{0} (Recommended)', label) : label;
}

function planRequestKey(sessionId: string, requestId: string, toolCallId: string | undefined): string {
	return `${sessionId}:${requestId}:${toolCallId ?? ''}`;
}

function sameIdentity(left: TelegramPairedIdentity, right: TelegramPairedIdentity): boolean {
	return left.pairingId === right.pairingId && left.userId === right.userId && left.chatId === right.chatId;
}
