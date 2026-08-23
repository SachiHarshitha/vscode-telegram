/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlTransport } from '../../common/remoteControlTypes';
import type { TelegramAnswerCallbackQueryOptions, TelegramMessage, TelegramSendMessageOptions, TelegramUpdate } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramCallbackRegistry, type TelegramCallbackConstraints, type TelegramCallbackInput } from '../telegramCallbackRegistry';
import { TelegramCommandRouter, type TelegramCommandHost, type TelegramPromptDispatcher } from '../telegramCommandRouter';
import { TelegramSessionState } from '../telegramSessionState';
import { TestTelegramExtensionContext, telegramCallbackUpdate, telegramMessageUpdate } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = {
	pairingId: 'pairing-1',
	userId: 101,
	chatId: 202,
	firstName: 'First',
	pairedAt: 1,
};
const firstSession = { id: 'session-1', label: 'First session', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;
const secondSession = { id: 'session-2', label: 'Second session', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;

describe('TelegramCommandRouter', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('lists metadata-only sessions and validates an opaque inline selection', async () => {
		const test = createRouter([firstSession, secondSession]);
		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));

		expect(test.sessionService.getAllSessions).toHaveBeenCalledOnce();
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
		const picker = lastMessageOptions(test.host).replyMarkup!;
		const callbackData = picker.inline_keyboard[0][0].callback_data!;
		expect(callbackData).toMatch(/^tr1:/);
		expect(callbackData).not.toContain(firstSession.id);

		await test.host.deliver(telegramCallbackUpdate(2, callbackData));
		expect(test.sessionService.getSessionItem).toHaveBeenCalledWith(firstSession.id, expect.anything());
		expect(test.state.getSelectedSessionId(identity)).toBe(firstSession.id);
		expect(test.registry.getAttachedSessionIds('telegram')).toEqual([firstSession.id]);
		expect(test.host.answerCallbackQuery).toHaveBeenCalledWith('callback-2', expect.objectContaining({ text: 'Session selected.' }));
	});

	it('rejects stale selection controls and deleted selection targets', async () => {
		const test = createRouter([firstSession]);
		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));
		const firstCallback = lastMessageOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		await test.host.deliver(telegramMessageUpdate(2, '/sessions'));

		await test.host.deliver(telegramCallbackUpdate(3, firstCallback));
		expect(test.state.getSelectedSessionId(identity)).toBeUndefined();
		expect(test.host.answerCallbackQuery).toHaveBeenLastCalledWith('callback-3', expect.objectContaining({ text: expect.stringContaining('stale') }));

		const currentCallback = lastPickerCallback(test.host);
		test.sessionService.getSessionItem.mockResolvedValue(undefined);
		await test.host.deliver(telegramCallbackUpdate(4, currentCallback));
		expect(lastMessageText(test.host)).toContain('deleted or closed');
		expect(test.registry.getAttachedSessionIds('telegram')).toEqual([]);
	});

	it('dispatches normal text through the correlated Telegram origin and immediately returns a Stop control', async () => {
		let finish!: () => void;
		const completion = new Promise<void>(resolve => finish = resolve);
		const test = createRouter([firstSession], completion);
		await test.state.select(identity, firstSession.id);

		await test.host.deliver(telegramMessageUpdate(42, 'Please inspect the failing test'));

		expect(test.dispatcher.dispatch).toHaveBeenCalledWith(firstSession.id, 'Please inspect the failing test', expect.objectContaining({
			kind: 'telegram',
			transportId: 'telegram',
			updateId: '42',
		}));
		expect(lastMessageText(test.host)).toContain('Prompt accepted');
		expect(lastMessageOptions(test.host).replyMarkup?.inline_keyboard[0][0].text).toBe('Stop');
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
		finish();
		await completion;
	});

	it('makes Stop one-shot and never opens a wrapper when no live control exists', async () => {
		const test = createRouter([firstSession], new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id);
		const abort = vi.spyOn(test.registry, 'abort').mockResolvedValueOnce(false);
		await test.host.deliver(telegramMessageUpdate(1, 'Run a long task'));
		const stopCallback = lastMessageOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;

		await test.host.deliver(telegramCallbackUpdate(2, stopCallback));
		expect(abort).toHaveBeenCalledOnce();
		expect(lastMessageText(test.host)).toContain('not reopened');
		expect(test.sessionService.getSession).not.toHaveBeenCalled();

		await test.host.deliver(telegramCallbackUpdate(3, stopCallback));
		expect(abort).toHaveBeenCalledOnce();
		expect(test.host.answerCallbackQuery).toHaveBeenLastCalledWith('callback-3', expect.objectContaining({ text: expect.stringContaining('stale') }));
	});

	it('aborts the currently bound wrapper once and rejects an older Stop after a newer dispatch', async () => {
		const test = createRouter([firstSession], new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id);
		const abort = vi.spyOn(test.registry, 'abort').mockResolvedValue(true);

		await test.host.deliver(telegramMessageUpdate(1, 'First prompt'));
		const oldStop = lastMessageOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		test.dispatcher.dispatch.mockReturnValueOnce({ accepted: true, correlationId: 'request-2', completion: new Promise<void>(() => { }) });
		await test.host.deliver(telegramMessageUpdate(2, 'Steer with this'));
		const currentStop = lastMessageOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;

		await test.host.deliver(telegramCallbackUpdate(3, oldStop));
		expect(abort).not.toHaveBeenCalled();
		await test.host.deliver(telegramCallbackUpdate(4, currentStop));
		expect(abort).toHaveBeenCalledOnce();
		expect(lastMessageText(test.host)).toContain('was stopped');
	});

	it('detaches and reports a selected session deletion without acquiring a wrapper', async () => {
		const test = createRouter([firstSession]);
		await test.state.select(identity, firstSession.id);
		test.host.authorize(identity);
		await vi.waitFor(() => expect(test.registry.getAttachedSessionIds('telegram')).toEqual([firstSession.id]));

		test.sessionService.fireDelete(firstSession.id);
		await vi.waitFor(() => expect(test.state.getSelectedSessionId(identity)).toBeUndefined());
		expect(test.registry.getAttachedSessionIds('telegram')).toEqual([]);
		expect(lastMessageText(test.host)).toContain('was deleted');
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
	});

	it('contains routing errors and does not retry an accepted prompt when its acknowledgement fails', async () => {
		const test = createRouter([firstSession], new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id);
		test.host.sendMessage.mockRejectedValueOnce(new Error('offline'));

		await expect(test.host.deliver(telegramMessageUpdate(7, 'One dispatch only'))).resolves.toBeUndefined();
		expect(test.dispatcher.dispatch).toHaveBeenCalledOnce();
		expect(test.logService.warn).toHaveBeenCalledWith('[TelegramRemote] Failed to send a Telegram command response.');
	});
});

class TestCommandHost implements TelegramCommandHost {
	readonly authorizedEmitter = new Emitter<TelegramPairedIdentity>();
	readonly blockedEmitter = new Emitter<void>();
	readonly identityEmitter = new Emitter<TelegramPairedIdentity | undefined>();
	readonly onDidAuthorizeConnection = this.authorizedEmitter.event;
	readonly onDidBlockRemoteAccess = this.blockedEmitter.event;
	readonly onDidChangePairedIdentity = this.identityEmitter.event;
	readonly callbacks = new TelegramCallbackRegistry();
	isAcceptingUpdates = true;
	pairedIdentity: TelegramPairedIdentity | undefined = identity;
	private handler: ((accepted: { readonly update: TelegramUpdate; readonly identity: TelegramPairedIdentity }) => Promise<void>) | undefined;

	readonly sendMessage = vi.fn(async (chatId: number, text: string, _options?: TelegramSendMessageOptions): Promise<TelegramMessage> => ({
		message_id: this.sendMessage.mock.calls.length,
		date: 1,
		chat: { id: chatId, type: 'private' },
		text,
	}));
	readonly answerCallbackQuery = vi.fn(async (_callbackQueryId: string, _options?: TelegramAnswerCallbackQueryOptions) => { });

	registerAuthorizedUpdateHandler(handler: (accepted: { readonly update: TelegramUpdate; readonly identity: TelegramPairedIdentity }) => Promise<void>) {
		this.handler = handler;
		return { dispose: () => { if (this.handler === handler) { this.handler = undefined; } } };
	}

	registerCallback(input: TelegramCallbackInput) {
		return this.callbacks.register(input);
	}

	consumeCallback(update: TelegramUpdate, constraints: TelegramCallbackConstraints = {}) {
		return update.callback_query?.data ? this.callbacks.consume(update.callback_query.data, identity, constraints) : undefined;
	}

	invalidateSessionCallbacks(sessionId: string): void { this.callbacks.invalidateSession(sessionId); }
	invalidateRequestCallbacks(sessionId: string, requestId: string): void { this.callbacks.invalidateRequest(sessionId, requestId); }
	invalidateAllCallbacks(): void { this.callbacks.invalidateAll(); }

	deliver(update: TelegramUpdate): Promise<void> {
		if (!this.handler) {
			throw new Error('Router is not registered.');
		}
		return this.handler({ update, identity });
	}

	authorize(value: TelegramPairedIdentity): void {
		this.pairedIdentity = value;
		this.authorizedEmitter.fire(value);
	}
}

class TestSessionService extends mock<ICopilotCLISessionService>() {
	private readonly deleteEmitter = new Emitter<string>();
	override readonly onDidDeleteSession = this.deleteEmitter.event;
	override readonly onDidChangeSessions = Event.None;
	override readonly onDidChangeSession = Event.None;
	override readonly onDidCreateSession = Event.None;
	override readonly getAllSessions = vi.fn<() => Promise<readonly ICopilotCLISessionItem[]>>();
	override readonly getSessionItem = vi.fn<(sessionId: string) => Promise<ICopilotCLISessionItem | undefined>>();
	override readonly getSession = vi.fn();

	fireDelete(sessionId: string): void {
		this.deleteEmitter.fire(sessionId);
	}
}

function createRouter(sessions: readonly ICopilotCLISessionItem[], completion = Promise.resolve()) {
	const context = new TestTelegramExtensionContext('C:\\telegram-router-test');
	const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
	registry.registerTransport({ id: 'telegram', label: 'Telegram', themeIcon: 'radio-tower', publish: () => { }, dispose: () => { } } satisfies IRemoteControlTransport);
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
	const host = new TestCommandHost();
	const sessionService = new TestSessionService();
	sessionService.getAllSessions.mockResolvedValue(sessions);
	sessionService.getSessionItem.mockImplementation(async sessionId => sessions.find(session => session.id === sessionId));
	const dispatcher = {
		dispatch: vi.fn(() => ({ accepted: true as const, correlationId: 'request-1', completion })),
	} satisfies TelegramPromptDispatcher;
	const logService = new class extends mock<ILogService>() {
		override warn = vi.fn();
		override error = vi.fn();
	};
	const router = new TelegramCommandRouter(host, state, sessionService, registry, dispatcher, {
		workstationLabel: 'workstation-1',
		workspaceLabel: 'C:\\workspace',
	}, logService);
	return { router, host, state, registry, sessionService, dispatcher, logService };
}

function lastMessageText(host: TestCommandHost): string {
	return host.sendMessage.mock.calls.at(-1)?.[1] ?? '';
}

function lastMessageOptions(host: TestCommandHost): TelegramSendMessageOptions {
	return host.sendMessage.mock.calls.at(-1)?.[2] ?? {};
}

function lastPickerCallback(host: TestCommandHost): string {
	for (let index = host.sendMessage.mock.calls.length - 1; index >= 0; index--) {
		const callbackData = host.sendMessage.mock.calls[index][2]?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
		if (callbackData) {
			return callbackData;
		}
	}
	throw new Error('No picker callback was sent.');
}
