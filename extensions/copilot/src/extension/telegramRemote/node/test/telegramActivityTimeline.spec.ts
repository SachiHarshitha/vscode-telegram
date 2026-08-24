/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import type { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { mock } from '../../../../util/common/test/simpleMock';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlSessionEvent, IRemotePermissionRequest } from '../../common/remoteControlTypes';
import type { TelegramSessionScopePolicy } from '../../common/telegramSessionScope';
import { TelegramBotApiError, type TelegramAnswerCallbackQueryOptions, type TelegramEditRichMessageOptions, type TelegramInlineKeyboardMarkup, type TelegramInputRichMessage, type TelegramMessage, type TelegramSendRichMessageOptions, type TelegramUpdate } from '../../common/telegramTypes';
import { TelegramActivityTimeline, type TelegramActivityTimelineHost, type TelegramActivityTimelineScheduler } from '../telegramActivityTimeline';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramCallbackRegistry, type TelegramCallbackConstraints, type TelegramCallbackInput } from '../telegramCallbackRegistry';
import { TelegramSessionState } from '../telegramSessionState';
import { TestTelegramExtensionContext, telegramCallbackUpdate, telegramMessageUpdate } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };
const sessionScopeFingerprint = '1234567890abcdef12345678';
const session = { id: 'session-1', label: 'Session One', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;
const stopMarkup: TelegramInlineKeyboardMarkup = { inline_keyboard: [[{ text: 'Stop', callback_data: 'tr1:stop' }]] };

describe('TelegramActivityTimeline', () => {
	it('edits a command start into completion on the same Rich Message', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		await test.timeline.publish(session.id, event('start', 'tool.execution_start', {
			toolCallId: 'tool-1', toolName: 'run_in_terminal', arguments: { command: 'npm test', cwd: 'C:\\workspace' },
		}));
		const commandSend = test.host.sendRichMessage.mock.calls.at(-1)!;
		const commandMessageId = test.host.sendRichMessage.mock.calls.length;
		expect(JSON.stringify(commandSend[1])).toContain('npm test');

		await test.timeline.publish(session.id, event('complete', 'tool.execution_complete', {
			toolCallId: 'tool-1', success: true, result: { detailedContent: '347 passed' },
		}));
		await test.scheduler.runAll();

		expect(test.host.editRichMessage).toHaveBeenCalledWith(identity.chatId, commandMessageId, expect.anything(), expect.anything());
		expect(JSON.stringify(test.host.editRichMessage.mock.calls.at(-1)?.[2])).toContain('npm test');
		expect(JSON.stringify(test.host.editRichMessage.mock.calls.at(-1)?.[2])).toContain('347 passed');
	});

	it('sends a reply-linked replacement when editing a Rich Message fails', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		await test.timeline.publish(session.id, event('start', 'tool.execution_start', {
			toolCallId: 'tool-1', toolName: 'run_in_terminal', arguments: { command: 'npm test' },
		}));
		const originalMessageId = test.host.sendRichMessage.mock.calls.length;
		test.host.editRichMessage.mockRejectedValueOnce(new TelegramBotApiError('api', 'message was deleted'));

		await test.timeline.publish(session.id, event('complete', 'tool.execution_complete', {
			toolCallId: 'tool-1', success: false, error: { message: 'Test failed' },
		}));
		await test.scheduler.runAll();

		const replacementOptions = test.host.sendRichMessage.mock.calls.at(-1)?.[2];
		expect(replacementOptions?.replyParameters).toEqual({ message_id: originalMessageId, allow_sending_without_reply: true });
		expect(JSON.stringify(test.host.sendRichMessage.mock.calls.at(-1)?.[1])).toContain('npm test failed');
	});

	it('correlates a reply with a live round and makes it stale after completion', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		await test.timeline.publish(session.id, event('reasoning', 'assistant.reasoning', {
			reasoningId: 'reasoning-1', content: 'Reviewing the request routing',
		}));
		const reasoningMessageId = test.host.sendRichMessage.mock.calls.length;
		const reply = replyUpdate(5, reasoningMessageId, 'Use a transport registry first');

		expect(await test.timeline.resolveReply(reply, identity)).toEqual(expect.objectContaining({
			kind: 'steer', sessionId: session.id, requestId: 'request-1',
		}));
		await test.timeline.completeRequest(identity, session.id, 'request-1', 'completed');
		expect(await test.timeline.resolveReply(reply, identity)).toEqual({ kind: 'stale' });
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
	});

	it('edits consecutive reasoning into one Thinking Rich Message', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		await test.timeline.publish(session.id, event('intent', 'assistant.intent', {
			intent: 'Inspect the native request path.',
		}));
		const reasoningMessageId = test.host.sendRichMessage.mock.calls.length;
		const sendsAfterFirstReasoning = test.host.sendRichMessage.mock.calls.length;

		await test.timeline.publish(session.id, event('reasoning', 'assistant.reasoning', {
			reasoningId: 'reasoning-1', content: 'The routing marker must stay internal.',
		}));
		await test.scheduler.runAll();

		expect(test.host.sendRichMessage).toHaveBeenCalledTimes(sendsAfterFirstReasoning);
		expect(test.host.editRichMessage).toHaveBeenCalledWith(identity.chatId, reasoningMessageId, expect.anything(), expect.anything());
		const richMessage = JSON.stringify(test.host.editRichMessage.mock.calls.at(-1)?.[2]);
		expect(richMessage).toContain('Thinking');
		expect(richMessage).toContain('Inspect the native request path.');
		expect(richMessage).toContain('The routing marker must stay internal.');
	});

	it('keeps Stop attached when a stale idle event arrives before the new turn starts', async () => {
		const test = await createTimeline();
		const request = await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);

		await test.timeline.publish(session.id, event('old-idle', 'session.idle', { aborted: false }));
		expect(test.timeline.isStopControl(session.id, 'request-1', request!.generation, request!.messageId)).toBe(true);
		expect(test.host.editMessageReplyMarkup).not.toHaveBeenCalled();

		await test.timeline.publish(session.id, event('turn', 'assistant.turn_start', { turnId: 'turn-1' }));
		await test.timeline.publish(session.id, event('idle', 'session.idle', { aborted: false }));
		expect(test.timeline.isStopControl(session.id, 'request-1', request!.generation, request!.messageId)).toBe(false);
		expect(test.host.editMessageReplyMarkup).toHaveBeenCalled();
	});

	it('holds provisional assistant text and publishes one expandable final answer with usage', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		const sendsAfterStart = test.host.sendRichMessage.mock.calls.length;

		await test.timeline.publish(session.id, event('answer', 'assistant.message', {
			messageId: 'answer-1', content: 'Result:\n\n- first\n- second',
		}));
		expect(test.host.sendRichMessage).toHaveBeenCalledTimes(sendsAfterStart);
		await test.timeline.publish(session.id, event('usage', 'assistant.usage', {
			model: 'gpt-test', inputTokens: 12, outputTokens: 8,
		}));
		await test.timeline.publish(session.id, event('idle', 'session.idle', { aborted: false }));

		const finalMessage = JSON.stringify(test.host.sendRichMessage.mock.calls.at(-1)?.[1]);
		expect(finalMessage).toContain('details');
		expect(finalMessage).toContain('• first');
		expect(finalMessage).toContain('Token usage');
		expect(finalMessage).toContain('20 total');
		expect(finalMessage).not.toContain('Agent response');
	});

	it('correlates permission callbacks, accepts one response, and rejects replay', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		const request: IRemotePermissionRequest = { requestId: 'permission-1', permissionRequest: { kind: 'shell', toolCallId: 'tool-1' } };
		const responsePromise = test.timeline.requestPermission(session.id, request, CancellationToken.None);
		await vi.waitFor(() => expect(test.host.sendRichMessage.mock.calls.length).toBeGreaterThan(1));
		const permissionCall = test.host.sendRichMessage.mock.calls.at(-1)!;
		const permissionMessageId = test.host.sendRichMessage.mock.calls.length;
		const approveCallback = permissionCall[2]?.replyMarkup?.inline_keyboard[0][0].callback_data!;
		const callback = callbackUpdate(6, approveCallback, permissionMessageId);

		expect(await test.timeline.handleCallback(callback, identity)).toBe(true);
		expect(await responsePromise).toEqual({ kind: 'approve-once' });
		expect(await test.timeline.handleCallback(callback, identity)).toBe(false);
		expect(test.host.answerCallbackQuery).toHaveBeenCalledTimes(1);
	});

	it('lets a local permission response cancel Telegram controls without approving', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		const cancellation = new CancellationTokenSource();
		const responsePromise = test.timeline.requestPermission(session.id, {
			requestId: 'permission-1', permissionRequest: { kind: 'write', toolCallId: 'tool-1' },
		}, cancellation.token);
		await vi.waitFor(() => expect(test.host.sendRichMessage.mock.calls.length).toBeGreaterThan(1));

		cancellation.cancel();
		expect(await responsePromise).toBeUndefined();
		await vi.waitFor(() => expect(test.host.editRichMessage).toHaveBeenCalled());
		expect(test.host.editRichMessage.mock.calls.at(-1)?.[3]?.replyMarkup).toEqual({ inline_keyboard: [] });
		cancellation.dispose();
	});

	it('binds a freeform answer to the specific question bubble', async () => {
		const test = await createTimeline();
		await test.timeline.beginRequest(identity, session, 'request-1', stopMarkup);
		const responsePromise = test.timeline.requestUserInput(session.id, {
			requestId: 'question-1', toolCallId: 'tool-1', question: 'Which approach?', choices: ['Registry', 'Direct'], allowFreeform: true,
		}, CancellationToken.None);
		await vi.waitFor(() => expect(test.host.sendRichMessage.mock.calls.length).toBeGreaterThan(1));
		const questionMessageId = test.host.sendRichMessage.mock.calls.length;

		expect(await test.timeline.resolveReply(replyUpdate(8, questionMessageId, 'Use a small generic registry'), identity)).toEqual({ kind: 'handled' });
		expect(await responsePromise).toEqual({ answer: 'Use a small generic registry', wasFreeform: true });
		await vi.waitFor(() => expect(test.host.editRichMessage).toHaveBeenCalled());
		expect(test.host.editRichMessage.mock.calls.at(-1)?.[3]?.replyMarkup).toEqual({ inline_keyboard: [] });
	});
});

class TestActivityHost implements TelegramActivityTimelineHost {
	private readonly identityEmitter = new Emitter<TelegramPairedIdentity | undefined>();
	readonly onDidChangePairedIdentity = this.identityEmitter.event;
	readonly callbacks = new TelegramCallbackRegistry();
	isAcceptingUpdates = true;
	pairedIdentity: TelegramPairedIdentity | undefined = identity;

	readonly sendRichMessage = vi.fn(async (chatId: number, _richMessage: TelegramInputRichMessage, _options?: TelegramSendRichMessageOptions): Promise<TelegramMessage> => ({
		message_id: this.sendRichMessage.mock.calls.length,
		date: 1,
		chat: { id: chatId, type: 'private' },
	}));
	readonly editRichMessage = vi.fn(async (_chatId: number, _messageId: number, _richMessage: TelegramInputRichMessage, _options?: TelegramEditRichMessageOptions): Promise<true> => true);
	readonly editMessageReplyMarkup = vi.fn(async (): Promise<true> => true);
	readonly answerCallbackQuery = vi.fn(async (_callbackQueryId: string, _options?: TelegramAnswerCallbackQueryOptions): Promise<void> => { });
	readonly preserveDeliveryClient = vi.fn();
	readonly clearDeliveryClient = vi.fn();

	registerCallback(input: TelegramCallbackInput) { return this.callbacks.register(input); }
	consumeCallback(update: TelegramUpdate, constraints: TelegramCallbackConstraints = {}) {
		return update.callback_query?.data ? this.callbacks.consume(update.callback_query.data, identity, constraints) : undefined;
	}
	invalidateRequestCallbacks(sessionId: string, requestId: string): void { this.callbacks.invalidateRequest(sessionId, requestId); }
}

class TestScheduler implements TelegramActivityTimelineScheduler {
	private currentTime = 0;
	private readonly entries: { dueAt: number; callback: () => Promise<void>; active: boolean }[] = [];
	now(): number { return this.currentTime; }
	schedule(callback: () => Promise<void>, delayMs: number): IDisposable {
		const entry = { dueAt: this.currentTime + delayMs, callback, active: true };
		this.entries.push(entry);
		return { dispose: () => entry.active = false };
	}
	async runAll(): Promise<void> {
		while (this.entries.some(entry => entry.active)) {
			const entry = this.entries.filter(candidate => candidate.active).sort((left, right) => left.dueAt - right.dueAt)[0];
			entry.active = false;
			this.currentTime = entry.dueAt;
			await entry.callback();
		}
	}
}

class TestSessionService extends mock<ICopilotCLISessionService>() {
	override readonly onDidDeleteSession = Event.None;
	override readonly onDidChangeSessions = Event.None;
	override readonly onDidChangeSession = Event.None;
	override readonly onDidCreateSession = Event.None;
	override readonly getSessionItem = vi.fn(async (sessionId: string) => sessionId === session.id ? session : undefined);
	override readonly getSession = vi.fn();
}

async function createTimeline() {
	const context = new TestTelegramExtensionContext('C:\\telegram-timeline-test');
	const logService = new class extends mock<ILogService>() { override warn = vi.fn(); };
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, { attachTransport: () => ({ dispose() { } }) } as never);
	await state.select(identity, session.id, sessionScopeFingerprint);
	const scopePolicy: TelegramSessionScopePolicy = {
		authorizeSession: item => item.id === session.id ? { fingerprint: sessionScopeFingerprint, workingDirectoryLabel: 'C:\\workspace' } : undefined,
	};
	const host = new TestActivityHost();
	const scheduler = new TestScheduler();
	const sessionService = new TestSessionService();
	const timeline = new TelegramActivityTimeline(host, state, sessionService, { workstationLabel: 'workstation-1' }, scopePolicy, () => 'detailed', scheduler, logService);
	return { timeline, host, state, scheduler, sessionService, logService };
}

function event(id: string, type: string, data: unknown): IRemoteControlSessionEvent {
	return { id, timestamp: '2026-08-23T12:00:00.000Z', parentId: null, type, data };
}

function replyUpdate(updateId: number, replyToMessageId: number, text: string): TelegramUpdate {
	const update = telegramMessageUpdate(updateId, text);
	return {
		...update,
		message: update.message ? {
			...update.message,
			reply_to_message: { message_id: replyToMessageId, date: 1, chat: update.message.chat },
		} : undefined,
	};
}

function callbackUpdate(updateId: number, callbackData: string, messageId: number): TelegramUpdate {
	const update = telegramCallbackUpdate(updateId, callbackData);
	return {
		...update,
		callback_query: update.callback_query ? {
			...update.callback_query,
			message: update.callback_query.message ? { ...update.callback_query.message, message_id: messageId } : undefined,
		} : undefined,
	};
}
