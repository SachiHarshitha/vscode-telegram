/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { URI } from '../../../../util/vs/base/common/uri';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlTransport } from '../../common/remoteControlTypes';
import type { TelegramSessionScopePolicy } from '../../common/telegramSessionScope';
import type { TelegramAnswerCallbackQueryOptions, TelegramEditMessageTextOptions, TelegramInlineKeyboardMarkup, TelegramMessage, TelegramSendMessageOptions, TelegramUpdate } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramCallbackRegistry, type TelegramCallbackConstraints, type TelegramCallbackInput } from '../telegramCallbackRegistry';
import { TelegramCommandRouter, type TelegramActivityReplyResolution, type TelegramCommandHost, type TelegramPromptDispatcher, type TelegramRequestActivity, type TelegramRequestTerminalEvent, type TelegramSessionCreator } from '../telegramCommandRouter';
import { TelegramSessionState } from '../telegramSessionState';
import { TestTelegramExtensionContext, telegramCallbackUpdate, telegramMessageUpdate } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };
const sessionScopeFingerprint = '1234567890abcdef12345678';
const firstSession = { id: 'session-1', label: 'First session', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;
const secondSession = { id: 'session-2', label: 'Second session', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;

describe('TelegramCommandRouter', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('lists only authorized metadata and follows the picker with selected-session status', async () => {
		const foreign = { ...secondSession, label: 'Secret foreign session' };
		const test = createRouter([firstSession, foreign], new Set([firstSession.id]));
		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));

		const picker = lastSendOptions(test.host).replyMarkup!;
		expect({ rows: picker.inline_keyboard.length, text: lastSentText(test.host) }).toEqual({ rows: 1, text: expect.not.stringContaining('Secret foreign session') });
		const callbackData = picker.inline_keyboard[0][0].callback_data!;
		expect(callbackData).toMatch(/^tr1:/);
		expect(callbackData).not.toContain(firstSession.id);

		await test.host.deliver(callbackUpdate(2, callbackData, 1));
		expect(test.state.getSelectedSessionId(identity)).toBe(firstSession.id);
		expect(test.registry.getAttachedSessionIds('telegram')).toEqual([firstSession.id]);
		expect(test.host.sendMessage).toHaveBeenCalledTimes(2);
		expect(test.host.editMessageReplyMarkup).toHaveBeenCalledWith(identity.chatId, 1, { inline_keyboard: [] });
		expect(lastSentText(test.host)).toContain('Authorized workspace: C:\\workspace');
	});

	it('fails closed when an empty window has no authorized sessions', async () => {
		const test = createRouter([firstSession], new Set());
		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));

		expect(lastSentText(test.host)).toBe('No Copilot sessions are available in the authorized workspace.');
		expect(JSON.stringify(test.host.sendMessage.mock.calls)).not.toContain(firstSession.label);
	});

	it('sends command responses as separate messages instead of overwriting chat history', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));

		await test.host.deliver(telegramMessageUpdate(1, '/status'));
		await test.host.deliver(telegramMessageUpdate(2, '/status'));

		expect(test.host.sendMessage).toHaveBeenCalledTimes(2);
		expect(test.host.editMessageText).not.toHaveBeenCalled();
	});

	it('creates a session in the single authorized workspace and dispatches its first prompt', async () => {
		const test = createRouter([], new Set());

		await test.host.deliver(telegramMessageUpdate(1, '/new'));
		expect(test.sessionCreator.createSession).not.toHaveBeenCalled();
		expect(lastSentText(test.host)).toContain('Send its first prompt');

		await test.host.deliver(telegramMessageUpdate(2, 'Inspect the current changes'));
		expect(test.sessionCreator.createSession).toHaveBeenCalledWith(test.workspaceRoots[0], 'Inspect the current changes');
		expect(test.state.getSelectedSessionId(identity)).toBe('new-session-1');
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith('new-session-1', 'Inspect the current changes', expect.objectContaining({ kind: 'telegram', updateId: '2' }));
	});

	it('accepts the first prompt directly in /new', async () => {
		const test = createRouter([], new Set());

		await test.host.deliver(telegramMessageUpdate(1, '/new Review the repository'));

		expect(test.sessionCreator.createSession).toHaveBeenCalledWith(test.workspaceRoots[0], 'Review the repository');
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith('new-session-1', 'Review the repository', expect.anything());
	});

	it('asks which authorized workspace should own a new multi-root session', async () => {
		const workspaceRoots = [URI.file('C:\\workspace-one'), URI.file('C:\\workspace-two')];
		const test = createRouter([], new Set(), Promise.resolve(), workspaceRoots);

		await test.host.deliver(telegramMessageUpdate(1, '/new Run the tests'));
		const picker = lastSendOptions(test.host).replyMarkup!;
		expect(picker.inline_keyboard).toHaveLength(2);

		await test.host.deliver(callbackUpdate(2, picker.inline_keyboard[1][0].callback_data!, 1));
		expect(test.sessionCreator.createSession).toHaveBeenCalledWith(workspaceRoots[1], 'Run the tests');
		expect(test.host.editMessageReplyMarkup).toHaveBeenCalledWith(identity.chatId, 1, emptyInlineKeyboardForTest());
	});

	it('revalidates authorization at callback time without leaking the revoked session', async () => {
		const authorizedIds = new Set([firstSession.id]);
		const test = createRouter([firstSession], authorizedIds);
		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));
		const callbackData = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		authorizedIds.clear();

		await test.host.deliver(callbackUpdate(2, callbackData, 1));
		expect(test.state.getSelectedSessionId(identity)).toBeUndefined();
		expect(lastSentText(test.host)).toContain('unavailable in the authorized workspace');
		expect(test.host.answerCallbackQuery).toHaveBeenCalledWith('callback-2', expect.objectContaining({ showAlert: true }));
	});

	it('revalidates a persisted selection before dispatch, steering, and Stop', async () => {
		const authorizedIds = new Set([firstSession.id]);
		const test = createRouter([firstSession], authorizedIds, new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		authorizedIds.clear();

		await test.host.deliver(telegramMessageUpdate(7, 'Do not dispatch outside scope'));
		expect(test.dispatcher.dispatch).not.toHaveBeenCalled();
		expect(test.state.getSelectedSessionId(identity)).toBeUndefined();
	});

	it('dispatches through the native origin and places Stop on the single activity card', async () => {
		let finish!: () => void;
		const completion = new Promise<void>(resolve => finish = resolve);
		const test = createRouter([firstSession], new Set([firstSession.id]), completion);
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);

		await test.host.deliver(telegramMessageUpdate(42, 'Please inspect the failing test'));
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith(firstSession.id, 'Please inspect the failing test', expect.objectContaining({ kind: 'telegram', updateId: '42' }));
		expect(lastSentText(test.host)).toContain('Prompt accepted');
		expect(lastSendOptions(test.host).replyMarkup?.inline_keyboard[0][0].text).toBe('Stop');
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
		finish();
		await completion;
		expect(test.activity.completeRequest).not.toHaveBeenCalledWith(identity, firstSession.id, 'request-1', 'completed');
		test.activity.reachTerminal({ identity, sessionId: firstSession.id, requestId: 'request-1', outcome: 'completed' });
	});

	it('routes a reply to a live activity through the native prompt dispatcher', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.activity.resolveReply.mockResolvedValueOnce({
			kind: 'steer', sessionId: firstSession.id, requestId: 'request-1', activityRoundId: 'round-1',
		});
		const update = telegramMessageUpdate(43, 'Use the generic transport registry');
		const replyUpdate: TelegramUpdate = {
			...update,
			message: update.message ? {
				...update.message,
				reply_to_message: { message_id: 99, date: 1, chat: update.message.chat },
			} : undefined,
		};

		await test.host.deliver(replyUpdate);

		expect(test.activity.resolveReply).toHaveBeenCalledWith(replyUpdate, identity);
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith(firstSession.id, 'Use the generic transport registry', expect.objectContaining({ kind: 'telegram', updateId: '43' }));
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
	});

	it('binds Stop to the current activity message and rejects stale generations', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		const abort = vi.spyOn(test.registry, 'abort').mockResolvedValue(true);

		await test.host.deliver(telegramMessageUpdate(1, 'First prompt'));
		const oldStop = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		const oldMessageId = test.host.sendMessage.mock.results[0].value ? 1 : 1;
		test.dispatcher.dispatch.mockReturnValueOnce({ accepted: true, correlationId: 'request-2', completion: new Promise<void>(() => { }) });
		await test.host.deliver(telegramMessageUpdate(2, 'Steer with this'));
		const currentStop = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		const currentMessageId = test.host.sendMessage.mock.calls.length;

		await test.host.deliver(callbackUpdate(3, oldStop, oldMessageId));
		expect(abort).not.toHaveBeenCalled();
		await test.host.deliver(callbackUpdate(4, currentStop, currentMessageId));
		expect(abort).toHaveBeenCalledOnce();
		expect(test.activity.completeRequest).toHaveBeenLastCalledWith(identity, firstSession.id, 'request-2', 'cancelled');
	});

	it('does not retry an accepted native prompt when activity-card creation fails', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.activity.beginRequest.mockRejectedValueOnce(new Error('offline with secret content'));

		await expect(test.host.deliver(telegramMessageUpdate(7, 'One dispatch only'))).resolves.toBeUndefined();
		expect(test.dispatcher.dispatch).toHaveBeenCalledOnce();
		expect(test.logService.error).toHaveBeenCalledWith('[TelegramRemote] Authorized update routing failed; details were suppressed.');
		expect(JSON.stringify(test.logService.error.mock.calls)).not.toContain('secret content');
	});

	it('restores only a selection whose stored working-directory fingerprint is still current', async () => {
		const authorizedIds = new Set([firstSession.id]);
		const test = createRouter([firstSession], authorizedIds);
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.state.suspend();
		authorizedIds.clear();

		test.host.authorize(identity);
		await vi.waitFor(() => expect(test.state.getSelectedSessionId(identity)).toBeUndefined());
		expect(test.registry.getAttachedSessionIds('telegram')).toEqual([]);
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
	readonly editMessageText = vi.fn(async (_chatId: number, _messageId: number, _text: string, _options?: TelegramEditMessageTextOptions): Promise<true> => true);
	readonly editMessageReplyMarkup = vi.fn(async (_chatId: number, _messageId: number, _replyMarkup?: TelegramInlineKeyboardMarkup): Promise<true> => true);
	readonly answerCallbackQuery = vi.fn(async (_callbackQueryId: string, _options?: TelegramAnswerCallbackQueryOptions) => { });

	registerAuthorizedUpdateHandler(handler: (accepted: { readonly update: TelegramUpdate; readonly identity: TelegramPairedIdentity }) => Promise<void>) {
		this.handler = handler;
		return { dispose: () => { if (this.handler === handler) { this.handler = undefined; } } };
	}

	registerCallback(input: TelegramCallbackInput) { return this.callbacks.register(input); }
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
	override readonly onDidDeleteSession = Event.None;
	override readonly onDidChangeSessions = Event.None;
	override readonly onDidChangeSession = Event.None;
	override readonly onDidCreateSession = Event.None;
	override readonly getAllSessions = vi.fn<() => Promise<readonly ICopilotCLISessionItem[]>>();
	override readonly getSessionItem = vi.fn<(sessionId: string) => Promise<ICopilotCLISessionItem | undefined>>();
	override readonly getSession = vi.fn();
}

class TestRequestActivity implements TelegramRequestActivity {
	private generation = 0;
	private active: { readonly sessionId: string; readonly requestId: string; readonly generation: number; readonly messageId: number } | undefined;
	private readonly terminalEmitter = new Emitter<TelegramRequestTerminalEvent>();
	readonly onDidReachTerminal = this.terminalEmitter.event;

	constructor(private readonly host: TestCommandHost) { }

	readonly beginRequest = vi.fn(async (pairedIdentity: TelegramPairedIdentity, session: ICopilotCLISessionItem, requestId: string, replyMarkup: TelegramInlineKeyboardMarkup) => {
		const message = await this.host.sendMessage(pairedIdentity.chatId, `Prompt accepted for ${session.label}`, { replyMarkup, parseMode: 'HTML' });
		this.active = { sessionId: session.id, requestId, generation: ++this.generation, messageId: message.message_id };
		return { generation: this.active.generation, messageId: message.message_id };
	});
	readonly completeRequest = vi.fn(async (_identity: TelegramPairedIdentity, sessionId: string, requestId: string, _outcome: 'completed' | 'failed' | 'cancelled' | 'superseded') => {
		if (this.active?.sessionId === sessionId && this.active.requestId === requestId) {
			this.active = undefined;
		}
	});
	readonly handleCallback = vi.fn(async () => false);
	readonly resolveReply = vi.fn<(_update: TelegramUpdate, _identity: TelegramPairedIdentity) => Promise<TelegramActivityReplyResolution>>(async () => ({ kind: 'none' }));
	closeRemoteConnection(): string | undefined {
		return this.active?.sessionId;
	}
	reachTerminal(event: TelegramRequestTerminalEvent): void {
		this.active = undefined;
		this.terminalEmitter.fire(event);
	}
	isStopControl(sessionId: string, requestId: string, generation: number, messageId: number): boolean {
		return this.active?.sessionId === sessionId && this.active.requestId === requestId && this.active.generation === generation && this.active.messageId === messageId;
	}
}

function createRouter(
	sessions: readonly ICopilotCLISessionItem[],
	authorizedIds: Set<string>,
	completion = Promise.resolve(),
	workspaceRoots = [URI.file('C:\\workspace')],
) {
	const context = new TestTelegramExtensionContext('C:\\telegram-router-test');
	const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
	registry.registerTransport({ id: 'telegram', label: 'Telegram', themeIcon: 'radio-tower', publish: () => { }, dispose: () => { } } satisfies IRemoteControlTransport);
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
	const host = new TestCommandHost();
	const sessionService = new TestSessionService();
	sessionService.getAllSessions.mockResolvedValue(sessions);
	sessionService.getSessionItem.mockImplementation(async sessionId => sessions.find(session => session.id === sessionId));
	const dispatcher = { dispatch: vi.fn(() => ({ accepted: true as const, correlationId: 'request-1', completion })) } satisfies TelegramPromptDispatcher;
	let createdSessionCounter = 0;
	const sessionCreator = {
		createSession: vi.fn((workingDirectory, prompt) => {
			const item = {
				id: `new-session-${++createdSessionCounter}`,
				label: prompt,
				timing: undefined,
				workingDirectory,
			} satisfies ICopilotCLISessionItem;
			authorizedIds.add(item.id);
			return item;
		}),
	} satisfies TelegramSessionCreator;
	const scopePolicy: TelegramSessionScopePolicy = {
		authorizeSession: session => authorizedIds.has(session.id)
			? { fingerprint: sessionScopeFingerprint, workingDirectoryLabel: 'C:\\workspace' }
			: undefined,
	};
	const activity = new TestRequestActivity(host);
	const logService = new class extends mock<ILogService>() { override warn = vi.fn(); override error = vi.fn(); override info = vi.fn(); };
	const router = new TelegramCommandRouter(host, state, sessionService, registry, dispatcher, sessionCreator, {
		workstationLabel: 'workstation-1', workspaceLabel: 'C:\\workspace', workspaceRoots, remotePermissionResponses: false,
	}, scopePolicy, activity, logService);
	return { router, host, state, registry, sessionService, dispatcher, sessionCreator, activity, logService, workspaceRoots };
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

function lastSentText(host: TestCommandHost): string { return host.sendMessage.mock.calls.at(-1)?.[1] ?? ''; }
function lastSendOptions(host: TestCommandHost): TelegramSendMessageOptions { return host.sendMessage.mock.calls.at(-1)?.[2] ?? {}; }
function emptyInlineKeyboardForTest(): TelegramInlineKeyboardMarkup { return { inline_keyboard: [] }; }
