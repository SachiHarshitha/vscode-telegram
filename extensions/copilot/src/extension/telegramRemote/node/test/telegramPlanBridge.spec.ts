/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteExitPlanModeRequest } from '../../common/remoteControlTypes';
import type { TelegramSessionScopePolicy } from '../../common/telegramSessionScope';
import type { TelegramAnswerCallbackQueryOptions, TelegramEditRichMessageOptions, TelegramInputRichMessage, TelegramMessage, TelegramSendRichMessageOptions, TelegramUpdate } from '../../common/telegramTypes';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramCallbackRegistry, type TelegramCallbackConstraints, type TelegramCallbackContext, type TelegramCallbackInput } from '../telegramCallbackRegistry';
import { TelegramPlanBridge, type TelegramPlanBridgeHost } from '../telegramPlanBridge';
import { TelegramSessionState } from '../telegramSessionState';
import { TestTelegramExtensionContext, telegramCallbackUpdate, telegramMessageUpdate } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };
const sessionScopeFingerprint = '1234567890abcdef12345678';
const session = { id: 'session-1', label: 'Session One', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;
const planRequest: IRemoteExitPlanModeRequest = {
	requestId: 'plan-1',
	toolCallId: 'tool-1',
	summary: 'Implement the requested feature',
	planContent: '1. Inspect\n2. Edit\n3. Test',
	actions: ['interactive', 'exit_only'],
	recommendedAction: 'interactive',
};

describe('TelegramPlanBridge', () => {
	it('offers only non-elevating actions and resolves a fully correlated callback', async () => {
		const test = await createBridge();
		const responsePromise = test.bridge.requestExitPlanMode(session.id, planRequest, CancellationToken.None);
		await vi.waitFor(() => expect(test.host.sendRichMessage).toHaveBeenCalledOnce());
		const replyMarkup = test.host.sendRichMessage.mock.calls[0][2]?.replyMarkup;
		const buttons = replyMarkup?.inline_keyboard.flat() ?? [];

		expect(buttons.map(button => button.text)).toEqual([
			'Implement Plan (Recommended)',
			'Approve Plan Only',
			'Reject Plan',
		]);
		expect(JSON.stringify({ message: test.host.sendRichMessage.mock.calls[0][1], buttons })).not.toContain('autopilot');

		const update = callbackUpdate(1, buttons[0].callback_data!, 1);
		await expect(test.handleCallback(update, identity)).resolves.toBe(true);
		await expect(responsePromise).resolves.toEqual({ approved: true, selectedAction: 'interactive' });
		expect(test.host.editRichMessage.mock.calls.at(-1)?.[3]?.replyMarkup).toEqual({ inline_keyboard: [] });
	});

	it('does not resolve for a wrong user, nonce, session, tool, or expired callback', async () => {
		const test = await createBridge();
		const cancellation = new CancellationTokenSource();
		let settled = false;
		const responsePromise = test.bridge.requestExitPlanMode(session.id, planRequest, cancellation.token).then(value => {
			settled = true;
			return value;
		});
		await vi.waitFor(() => expect(test.host.sendRichMessage).toHaveBeenCalledOnce());
		const messageId = 1;
		const callbackData = test.host.sendRichMessage.mock.calls[0][2]?.replyMarkup?.inline_keyboard[0][0].callback_data!;

		await expect(test.handleCallback(callbackUpdate(2, callbackData, messageId, 999), { ...identity, userId: 999 })).resolves.toBe(false);
		await expect(test.handleCallback(callbackUpdate(3, 'tr1:missing', messageId), identity)).resolves.toBe(false);
		const wrongSession = test.host.callbacks.register({ identity, sessionId: 'session-2', requestId: planRequest.requestId, toolCallId: planRequest.toolCallId, action: 'plan.interactive' });
		await expect(test.handleCallback(callbackUpdate(4, wrongSession.callbackData, messageId), identity)).resolves.toBe(true);
		const wrongTool = test.host.callbacks.register({ identity, sessionId: session.id, requestId: planRequest.requestId, toolCallId: 'tool-2', action: 'plan.interactive' });
		await expect(test.handleCallback(callbackUpdate(5, wrongTool.callbackData, messageId), identity)).resolves.toBe(true);
		test.host.now += 6 * 60_000;
		await expect(test.handleCallback(callbackUpdate(6, callbackData, messageId), identity)).resolves.toBe(false);

		expect(settled).toBe(false);
		cancellation.cancel();
		await expect(responsePromise).resolves.toBeUndefined();
		cancellation.dispose();
	});

	it('accepts bounded feedback only from a reply to the correlated plan message', async () => {
		const test = await createBridge();
		const responsePromise = test.bridge.requestExitPlanMode(session.id, planRequest, CancellationToken.None);
		await vi.waitFor(() => expect(test.host.sendRichMessage).toHaveBeenCalledOnce());

		await expect(test.bridge.resolvePlanReply(replyUpdate(7, 999, 'wrong message'), identity)).resolves.toEqual({ kind: 'none' });
		await expect(test.bridge.resolvePlanReply(replyUpdate(8, 1, 'Please add rollback tests.'), identity)).resolves.toEqual({ kind: 'handled' });
		await expect(responsePromise).resolves.toEqual({ approved: false, feedback: 'Please add rollback tests.' });
	});

	it('cancels pending controls immediately when remote access is blocked', async () => {
		const test = await createBridge();
		const responsePromise = test.bridge.requestExitPlanMode(session.id, planRequest, CancellationToken.None);
		await vi.waitFor(() => expect(test.host.sendRichMessage).toHaveBeenCalledOnce());

		test.host.block();

		await expect(responsePromise).resolves.toBeUndefined();
		expect(test.host.editRichMessage.mock.calls.at(-1)?.[3]?.replyMarkup).toEqual({ inline_keyboard: [] });
	});
});

class TestPlanHost implements TelegramPlanBridgeHost {
	private readonly blockedEmitter = new Emitter<void>();
	readonly onDidBlockRemoteAccess = this.blockedEmitter.event;
	private readonly identityEmitter = new Emitter<TelegramPairedIdentity | undefined>();
	readonly onDidChangePairedIdentity = this.identityEmitter.event;
	now = 0;
	readonly callbacks = new TelegramCallbackRegistry({ now: () => this.now });
	isAcceptingUpdates = true;
	pairedIdentity: TelegramPairedIdentity | undefined = identity;

	readonly sendRichMessage = vi.fn(async (chatId: number, _richMessage: TelegramInputRichMessage, _options?: TelegramSendRichMessageOptions): Promise<TelegramMessage> => ({
		message_id: this.sendRichMessage.mock.calls.length,
		date: 1,
		chat: { id: chatId, type: 'private' },
	}));
	readonly editRichMessage = vi.fn(async (_chatId: number, _messageId: number, _richMessage: TelegramInputRichMessage, _options?: TelegramEditRichMessageOptions): Promise<true> => true);
	readonly answerCallbackQuery = vi.fn(async (_callbackQueryId: string, _options?: TelegramAnswerCallbackQueryOptions): Promise<void> => { });

	registerCallback(input: TelegramCallbackInput) { return this.callbacks.register(input); }
	invalidateRequestCallbacks(sessionId: string, requestId: string): void { this.callbacks.invalidateRequest(sessionId, requestId); }
	consumeCallback(update: TelegramUpdate, callbackIdentity: TelegramPairedIdentity, constraints: TelegramCallbackConstraints = {}): TelegramCallbackContext | undefined {
		return update.callback_query?.data ? this.callbacks.consume(update.callback_query.data, callbackIdentity, constraints) : undefined;
	}
	block(): void {
		this.isAcceptingUpdates = false;
		this.blockedEmitter.fire();
	}
}

class TestSessionService extends mock<ICopilotCLISessionService>() {
	override readonly onDidDeleteSession = Event.None;
	override readonly onDidChangeSessions = Event.None;
	override readonly onDidChangeSession = Event.None;
	override readonly onDidCreateSession = Event.None;
	override readonly getSessionItem = vi.fn(async (sessionId: string) => sessionId === session.id ? session : undefined);
}

async function createBridge() {
	const context = new TestTelegramExtensionContext('C:\\telegram-plan-test');
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, { attachTransport: () => ({ dispose() { } }) } as never);
	await state.select(identity, session.id, sessionScopeFingerprint);
	const scopePolicy: TelegramSessionScopePolicy = {
		authorizeSession: item => item.id === session.id ? { fingerprint: sessionScopeFingerprint, workingDirectoryLabel: 'C:\\workspace' } : undefined,
	};
	const host = new TestPlanHost();
	const sessionService = new TestSessionService();
	const logService = new class extends mock<ILogService>() { override warn = vi.fn(); };
	const bridge = new TelegramPlanBridge(host, state, sessionService, scopePolicy, logService);
	const handleCallback = async (update: TelegramUpdate, callbackIdentity: TelegramPairedIdentity): Promise<boolean> => {
		const callbackContext = host.consumeCallback(update, callbackIdentity);
		return callbackContext ? bridge.handlePlanCallback(update, callbackIdentity, callbackContext) : false;
	};
	return { bridge, host, state, sessionService, logService, handleCallback };
}

function callbackUpdate(updateId: number, callbackData: string, messageId: number, userId = identity.userId): TelegramUpdate {
	const update = telegramCallbackUpdate(updateId, callbackData, userId, identity.chatId);
	return {
		...update,
		callback_query: update.callback_query ? {
			...update.callback_query,
			message: update.callback_query.message ? { ...update.callback_query.message, message_id: messageId } : undefined,
		} : undefined,
	};
}

function replyUpdate(updateId: number, replyToMessageId: number, text: string): TelegramUpdate {
	const update = telegramMessageUpdate(updateId, text, identity.userId, identity.chatId);
	return {
		...update,
		message: update.message ? {
			...update.message,
			reply_to_message: { message_id: replyToMessageId, date: 1, chat: update.message.chat },
		} : undefined,
	};
}
