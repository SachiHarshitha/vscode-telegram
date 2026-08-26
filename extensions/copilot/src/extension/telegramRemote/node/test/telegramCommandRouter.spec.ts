/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { URI } from '../../../../util/vs/base/common/uri';
import { ChatSessionStatus } from '../../../../vscodeTypes';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlTransport } from '../../common/remoteControlTypes';
import type { TelegramWorkspaceFileBrowser } from '../../common/telegramFileBrowser';
import type { TelegramSessionScopePolicy } from '../../common/telegramSessionScope';
import type { TelegramAnswerCallbackQueryOptions, TelegramEditMessageTextOptions, TelegramInlineKeyboardMarkup, TelegramMessage, TelegramSendMessageOptions, TelegramUpdate } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramCallbackRegistry, type TelegramCallbackConstraints, type TelegramCallbackInput } from '../telegramCallbackRegistry';
import { TelegramCommandRouter, type TelegramActivityReplyResolution, type TelegramCommandHost, type TelegramPromptDispatcher, type TelegramRequestActivity, type TelegramRequestTerminalEvent, type TelegramSessionCreator } from '../telegramCommandRouter';
import { TelegramControlUiState } from '../telegramControlUiState';
import type { TelegramRequestPreferenceController } from '../telegramRequestPreferences';
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
		expect(lastSentText(test.host)).toContain('<b>🧭 Select a Copilot session</b>');
		expect(lastSentText(test.host)).toContain('<b>Workstation</b>: workstation-1');
		expect(lastSentText(test.host)).toContain('<b>Workspace</b>: C:\\workspace');
		expect(lastSendOptions(test.host).parseMode).toBe('HTML');
		const callbackData = picker.inline_keyboard[0][0].callback_data!;
		expect(callbackData).toMatch(/^tr1:/);
		expect(callbackData).not.toContain(firstSession.id);

		await test.host.deliver(callbackUpdate(2, callbackData, 1));
		expect(test.state.getSelectedSessionId(identity)).toBe(firstSession.id);
		expect(test.registry.getAttachedSessionIds('telegram')).toEqual([firstSession.id]);
		expect(test.host.sendMessage).toHaveBeenCalledTimes(1);
		expect(test.host.editMessageText).toHaveBeenCalledTimes(1);
		expect(lastSentText(test.host)).toContain('<b>Authorized workspace</b>: C:\\workspace');
	});

	it('fails closed when an empty window has no authorized sessions', async () => {
		const test = createRouter([firstSession], new Set());
		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));

		expect(lastSentText(test.host)).toBe('No Copilot sessions are available in the authorized workspace.');
		expect(JSON.stringify(test.host.sendMessage.mock.calls)).not.toContain(firstSession.label);
	});

	it('skips duplicate status rendering when text and controls are unchanged', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));

		await test.host.deliver(telegramMessageUpdate(1, '/status'));
		await test.host.deliver(telegramMessageUpdate(2, '/status'));

		expect(test.host.sendMessage).toHaveBeenCalledTimes(1);
		expect(test.host.editMessageText).not.toHaveBeenCalled();
		expect(test.logService.info).toHaveBeenCalledWith('[TelegramRemote] status-edit=skipped reason=unchanged');
	});

	it('shows the actual selected model and live mode in status when known', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.requestPreferences.getStatus.mockResolvedValue({ selectedModelId: 'gpt-fast', selectedModelLabel: 'GPT Fast', currentMode: 'plan' });

		await test.host.deliver(telegramMessageUpdate(1, '/status'));

		expect(lastSentText(test.host)).toContain('<b>📡 Telegram Remote</b>');
		expect(lastSentText(test.host)).toContain('<b>Model</b>: GPT Fast');
		expect(lastSentText(test.host)).toContain('<b>Mode</b>: plan');
		expect(lastSentText(test.host)).toContain('<b>State</b>: ⚪ Idle');
		expect(lastSentText(test.host)).toContain('\n\n<b>Permissions</b>:');
		expect(lastSentText(test.host)).toContain('<b>Commands</b>: /new, /sessions');
		expect(lastSendOptions(test.host).parseMode).toBe('HTML');
		expect(lastSendOptions(test.host).replyMarkup?.inline_keyboard[0].map(button => button.text)).toEqual(['Model', 'Mode']);
	});

	it('projects locally-started selected-session activity into the Telegram status card', async () => {
		const completed = { ...firstSession, status: ChatSessionStatus.Completed };
		const test = createRouter([completed], new Set([completed.id]));
		await test.state.select(identity, completed.id, sessionScopeFingerprint);
		await test.host.deliver(telegramMessageUpdate(1, '/status'));
		expect(lastSentText(test.host)).toContain('<b>State</b>: ⚪ Idle');

		const running = { ...completed, status: ChatSessionStatus.InProgress };
		test.sessionService.getSessionItem.mockResolvedValue(running);
		test.sessionService.changeSessionEmitter.fire(running);
		await vi.waitFor(() => expect(lastSentText(test.host)).toContain('<b>State</b>: 🟢 Running'));

		const waiting = { ...completed, status: ChatSessionStatus.NeedsInput };
		test.sessionService.getSessionItem.mockResolvedValue(waiting);
		test.sessionService.changeSessionEmitter.fire(waiting);
		await vi.waitFor(() => expect(lastSentText(test.host)).toContain('<b>State</b>: 🟠 Waiting for input'));

		const finished = { ...completed, status: ChatSessionStatus.Completed };
		test.sessionService.getSessionItem.mockResolvedValue(finished);
		test.sessionService.changeSessionEmitter.fire(finished);
		await vi.waitFor(() => expect(lastSentText(test.host)).toContain('<b>State</b>: ⚪ Idle'));
	});

	it('switches opted-in controls when the selected session starts locally', async () => {
		const completed = { ...firstSession, status: ChatSessionStatus.Completed };
		const test = createRouter([completed], new Set([completed.id]));
		await test.state.select(identity, completed.id, sessionScopeFingerprint);
		await test.host.deliver(telegramMessageUpdate(1, '/controls'));

		const running = { ...completed, status: ChatSessionStatus.InProgress };
		test.sessionService.getSessionItem.mockResolvedValue(running);
		test.sessionService.changeSessionEmitter.fire(running);
		await vi.waitFor(() => expect(firstReplyKeyboardRow(test.host)).toEqual([{ text: '/stop' }, { text: '/steer' }, { text: '/status' }]));

		const finished = { ...completed, status: ChatSessionStatus.Completed };
		test.sessionService.getSessionItem.mockResolvedValue(finished);
		test.sessionService.changeSessionEmitter.fire(finished);
		await vi.waitFor(() => expect(firstReplyKeyboardRow(test.host)).toEqual([{ text: '/new' }, { text: '/sessions' }, { text: '/model' }]));
	});

	it('escapes dynamic status-card values before enabling Telegram HTML', async () => {
		const specialSession = { ...firstSession, label: 'R&D <session>' };
		const test = createRouter([specialSession], new Set([specialSession.id]));
		await test.state.select(identity, specialSession.id, sessionScopeFingerprint);

		await test.host.deliver(telegramMessageUpdate(1, '/status'));

		expect(lastSentText(test.host)).toContain('<b>Session</b>: R&amp;D &lt;session&gt;');
		expect(lastSentText(test.host)).not.toContain('R&D <session>');
		expect(lastSendOptions(test.host).parseMode).toBe('HTML');
	});

	it('passes a validated one-request model, reasoning effort, and safe mode to native dispatch', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.requestPreferences.setModel.mockImplementation(async (_identity, _sessionId, modelId, reasoningEffort) => modelId === 'claude-sonnet high'
			? { kind: 'invalid', error: 'unsupported-model' }
			: { kind: 'valid', value: { modelId: 'claude-sonnet', reasoningEffort, mode: 'interactive' } });
		test.requestPreferences.consumeForDispatch.mockResolvedValue({ kind: 'valid', value: { modelId: 'claude-sonnet', reasoningEffort: 'high', mode: 'plan' } });

		await test.host.deliver(telegramMessageUpdate(1, '/model claude-sonnet high'));
		await test.host.deliver(telegramMessageUpdate(2, '/mode plan'));
		await test.host.deliver(telegramMessageUpdate(3, 'Create a safe implementation plan'));

		expect(test.requestPreferences.setModel).toHaveBeenCalledWith(identity, firstSession.id, 'claude-sonnet', 'high');
		expect(test.requestPreferences.setMode).toHaveBeenCalledWith(identity, firstSession.id, 'plan');
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith(
			firstSession.id,
			'Create a safe implementation plan',
			expect.objectContaining({ kind: 'remoteControl', transportId: 'telegram', mode: 'plan' }),
			{ modelId: 'claude-sonnet', reasoningEffort: 'high' },
		);
	});

	it('fails a stale model preference visibly before native dispatch', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.requestPreferences.consumeForDispatch.mockResolvedValue({ kind: 'invalid', error: 'unsupported-model' });

		await test.host.deliver(telegramMessageUpdate(1, 'Do not silently fall back'));

		expect(test.dispatcher.dispatch).not.toHaveBeenCalled();
		expect(lastSentText(test.host)).toContain('unsupported or no longer available');
		expect(lastSentText(test.host)).toContain('No prompt was dispatched');
	});

	it('rejects permission-elevating mode commands and offers only interactive or plan', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);

		await test.host.deliver(telegramMessageUpdate(1, '/mode autopilot'));
		expect(test.requestPreferences.setMode).not.toHaveBeenCalled();
		expect(lastSentText(test.host)).toContain('cannot be enabled from Telegram');

		await test.host.deliver(telegramMessageUpdate(2, '/mode'));
		expect(lastSendOptions(test.host).replyMarkup?.inline_keyboard.map(row => row[0].text)).toEqual(['Interactive', 'Plan']);
	});

	it('enumerates the upstream catalog through opaque model callbacks', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.requestPreferences.getModels.mockResolvedValue([{ id: 'gpt-fast', name: 'GPT Fast', provider: 'Copilot CLI', source: 'copilotcli', maxContextWindowTokens: 64_000 }]);
		test.requestPreferences.setModel.mockResolvedValue({ kind: 'valid', value: { modelId: 'gpt-fast', mode: 'interactive' } });

		await test.host.deliver(telegramMessageUpdate(1, '/models'));
		const button = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0];
		expect(lastSentText(test.host)).toContain('<b>🤖 Choose a model</b>');
		expect(lastSendOptions(test.host).parseMode).toBe('HTML');
		expect(button.text).toBe('GPT Fast');
		expect(button.callback_data).toMatch(/^tr1:/);
		expect(button.callback_data).not.toContain('gpt-fast');

		await test.host.deliver(callbackUpdate(2, button.callback_data!, 1));
		expect(test.requestPreferences.setModel).toHaveBeenCalledWith(identity, firstSession.id, 'gpt-fast', undefined);
	});

	it('paginates the complete model catalog so configured models beyond the first page remain visible', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.requestPreferences.getModels.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({
			id: `openai/model-${index + 1}`,
			name: `Configured ${index + 1}`,
			provider: 'openai',
			source: 'vscode-lm' as const,
			maxContextWindowTokens: 64_000,
		})));

		await test.host.deliver(telegramMessageUpdate(1, '/models'));
		const firstPage = lastSendOptions(test.host).replyMarkup!.inline_keyboard;
		expect(firstPage).toHaveLength(21);
		expect(firstPage.at(-1)?.map(button => button.text)).toEqual(['Next']);

		await test.host.deliver(callbackUpdate(2, firstPage.at(-1)![0].callback_data!, 1));
		const secondPage = lastSendOptions(test.host).replyMarkup!.inline_keyboard;
		expect(secondPage?.slice(0, 5).map(row => row[0].text)).toEqual([
			'Configured 21',
			'Configured 22',
			'Configured 23',
			'Configured 24',
			'Configured 25',
		]);
		expect(secondPage?.at(-1)?.map(button => button.text)).toEqual(['Previous']);
	});

	it('creates a session in the single authorized workspace and dispatches its first prompt', async () => {
		const test = createRouter([], new Set());

		await test.host.deliver(telegramMessageUpdate(1, '/new'));
		expect(test.sessionCreator.createSession).not.toHaveBeenCalled();
		expect(lastSentText(test.host)).toContain('Send its first prompt');

		await test.host.deliver(telegramMessageUpdate(2, 'Inspect the current changes'));
		expect(test.sessionCreator.createSession).toHaveBeenCalledWith(test.workspaceRoots[0], 'Inspect the current changes');
		expect(test.state.getSelectedSessionId(identity)).toBe('new-session-1');
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith('new-session-1', 'Inspect the current changes', expect.objectContaining({ kind: 'remoteControl', transportId: 'telegram', requestId: '2' }));
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
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith(firstSession.id, 'Please inspect the failing test', expect.objectContaining({ kind: 'remoteControl', transportId: 'telegram', requestId: '42' }));
		expect(test.activity.beginRequest.mock.invocationCallOrder[0]).toBeLessThan(test.dispatcher.dispatch.mock.invocationCallOrder[0]);
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
		expect(test.dispatcher.dispatch).toHaveBeenCalledWith(firstSession.id, 'Use the generic transport registry', expect.objectContaining({ kind: 'remoteControl', transportId: 'telegram', requestId: '43' }));
		expect(test.sessionService.getSession).not.toHaveBeenCalled();
	});

	it('binds Stop to the current activity message and rejects stale generations', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		const abort = vi.spyOn(test.registry, 'abort').mockResolvedValue(true);

		await test.host.deliver(telegramMessageUpdate(1, 'First prompt'));
		const oldStop = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		const oldMessageId = test.host.sendMessage.mock.results[0].value ? 1 : 1;
		test.dispatcher.prepare.mockReturnValueOnce({
			correlationId: 'request-2',
			start: () => ({ accepted: true, correlationId: 'request-2', completion: new Promise<void>(() => { }) }),
		});
		await test.host.deliver(telegramMessageUpdate(2, 'Steer with this'));
		const currentStop = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0].callback_data!;
		const currentMessageId = test.host.sendMessage.mock.calls.length;

		await test.host.deliver(callbackUpdate(3, oldStop, oldMessageId));
		expect(abort).not.toHaveBeenCalled();
		await test.host.deliver(callbackUpdate(4, currentStop, currentMessageId));
		expect(abort).toHaveBeenCalledOnce();
		expect(test.activity.completeRequest).toHaveBeenLastCalledWith(identity, firstSession.id, 'request-2', 'cancelled');
	});

	it('does not start the native prompt when activity-card creation fails', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		test.activity.beginRequest.mockRejectedValueOnce(new Error('offline with secret content'));
		const invalidateRequestCallbacks = vi.spyOn(test.host, 'invalidateRequestCallbacks');

		await expect(test.host.deliver(telegramMessageUpdate(7, 'One dispatch only'))).resolves.toBeUndefined();
		expect(test.dispatcher.prepare).toHaveBeenCalledOnce();
		expect(test.dispatcher.dispatch).not.toHaveBeenCalled();
		expect(invalidateRequestCallbacks).toHaveBeenCalledWith(firstSession.id, 'request-1');
		expect(test.logService.error).toHaveBeenCalledWith('[TelegramRemote] Authorized update routing failed; details were suppressed.');
		expect(JSON.stringify(test.logService.error.mock.calls)).not.toContain('secret content');
	});

	it('routes reply-keyboard labels through the same handlers as slash commands', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));

		await test.host.deliver(telegramMessageUpdate(1, '/sessions'));
		await test.host.deliver(telegramMessageUpdate(2, 'Sessions'));

		expect(test.sessionService.getAllSessions).toHaveBeenCalledTimes(2);
	});

	it('persists opt-in quick controls and removes them explicitly', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));

		await test.host.deliver(telegramMessageUpdate(1, '/controls'));
		expect(lastSendOptions(test.host).replyKeyboardMarkup).toEqual({
			keyboard: [
				[{ text: '/new' }, { text: '/sessions' }, { text: '/model' }],
				[{ text: '/status' }, { text: '/files' }, { text: '/help' }],
			],
			resize_keyboard: true,
			is_persistent: true,
			one_time_keyboard: false,
			input_field_placeholder: 'Ask Copilot...',
		});
		expect(test.controlUiState.isEnabled(identity)).toBe(true);
		expect(new TelegramControlUiState(test.context).isEnabled(identity)).toBe(true);
		expect(test.controlUiState.isEnabled({ ...identity, chatId: 303 })).toBe(false);

		await test.host.deliver(telegramMessageUpdate(2, '/controls_off'));
		expect(lastSendOptions(test.host).replyKeyboardMarkup).toEqual({ remove_keyboard: true });
		expect(test.controlUiState.isEnabled(identity)).toBe(false);
	});

	it('restores an opted-in keyboard after router reconstruction', async () => {
		const context = new TestTelegramExtensionContext('C:\\telegram-router-reload-test');
		const first = createRouter([firstSession], new Set([firstSession.id]), Promise.resolve(), [URI.file('C:\\workspace')], context);
		await first.host.deliver(telegramMessageUpdate(1, '/controls'));
		first.router.dispose();

		const restored = createRouter([firstSession], new Set([firstSession.id]), Promise.resolve(), [URI.file('C:\\workspace')], context);

		await vi.waitFor(() => expect(lastSendOptions(restored.host).replyKeyboardMarkup).toMatchObject({ is_persistent: true }));
		const restoredKeyboard = lastSendOptions(restored.host).replyKeyboardMarkup;
		expect(restoredKeyboard && 'keyboard' in restoredKeyboard ? restoredKeyboard.keyboard[0] : undefined).toEqual([{ text: '/new' }, { text: '/sessions' }, { text: '/model' }]);
	});

	it('changes an enabled control keyboard only at request lifecycle transitions', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
		await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
		await test.host.deliver(telegramMessageUpdate(1, '/controls'));

		await test.host.deliver(telegramMessageUpdate(2, 'First task'));
		await test.host.deliver(telegramMessageUpdate(3, 'Steer task'));
		const keyboardStates = () => test.host.sendMessage.mock.calls
			.map(call => call[2]?.replyKeyboardMarkup)
			.filter(markup => !!markup && 'keyboard' in markup);
		expect(keyboardStates()).toHaveLength(2);
		expect(keyboardStates().at(-1)?.keyboard[0]).toEqual([{ text: '/stop' }, { text: '/steer' }, { text: '/status' }]);

		test.activity.reachTerminal({ identity, sessionId: firstSession.id, requestId: 'request-1', outcome: 'completed' });
		await vi.waitFor(() => expect(keyboardStates()).toHaveLength(3));
		expect(keyboardStates().at(-1)?.keyboard[0]).toEqual([{ text: '/new' }, { text: '/sessions' }, { text: '/model' }]);
	});

	it('leaves an enabled disconnected keyboard when remote routing stops', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		await test.host.deliver(telegramMessageUpdate(1, '/controls'));

		test.host.isAcceptingUpdates = false;
		test.host.blockedEmitter.fire();

		await vi.waitFor(() => expect(lastSendOptions(test.host).replyKeyboardMarkup).toMatchObject({
			keyboard: [[{ text: '/reconnect' }, { text: '/status' }], [{ text: '/settings' }]],
		}));
	});

	it('routes slash and reply-keyboard Stop through the same registry abort', async () => {
		for (const stopAction of ['/stop', '■ Stop']) {
			const test = createRouter([firstSession], new Set([firstSession.id]), new Promise<void>(() => { }));
			await test.state.select(identity, firstSession.id, sessionScopeFingerprint);
			const abort = vi.spyOn(test.registry, 'abort').mockResolvedValue(true);
			await test.host.deliver(telegramMessageUpdate(1, 'Run task'));

			await test.host.deliver(telegramMessageUpdate(2, stopAction));

			expect(abort).toHaveBeenCalledWith(firstSession.id, 'telegram');
		}
	});

	it('allows an explicit Stop command to abort a selected task started in VS Code', async () => {
		const running = { ...firstSession, status: ChatSessionStatus.InProgress };
		const test = createRouter([running], new Set([running.id]));
		await test.state.select(identity, running.id, sessionScopeFingerprint);
		const abort = vi.spyOn(test.registry, 'abort').mockResolvedValue(true);

		await test.host.deliver(telegramMessageUpdate(1, '/stop'));

		expect(abort).toHaveBeenCalledWith(running.id, 'telegram');
		expect(test.activity.completeRequest).not.toHaveBeenCalled();
	});

	it('browses workspace files with opaque callbacks and edits the existing menu', async () => {
		const fileSession = { ...firstSession, workingDirectory: URI.file('C:\\workspace') };
		const test = createRouter([fileSession], new Set([fileSession.id]));
		await test.state.select(identity, fileSession.id, sessionScopeFingerprint);
		test.fileBrowser.listDirectory.mockResolvedValue({
			relativePath: '',
			entries: [{ id: 'src/index.ts', label: 'index.ts', kind: 'file' }],
		});
		test.fileBrowser.readFile.mockResolvedValue({ relativePath: 'src/index.ts', text: 'const value = 1 < 2;', truncated: false });

		await test.host.deliver(telegramMessageUpdate(1, '/files'));
		const fileButton = lastSendOptions(test.host).replyMarkup!.inline_keyboard[0][0];
		expect(fileButton.callback_data).toMatch(/^tr1:/);
		expect(fileButton.callback_data).not.toContain('index.ts');

		await test.host.deliver(callbackUpdate(2, fileButton.callback_data!, 1));
		expect(test.host.answerCallbackQuery).toHaveBeenCalledWith('callback-2', expect.objectContaining({ text: 'Opening file…' }));
		expect(test.host.sendMessage).toHaveBeenCalledTimes(1);
		expect(test.host.editMessageText).toHaveBeenCalledWith(identity.chatId, 1, expect.stringContaining('const value = 1 &lt; 2;'), expect.objectContaining({ parseMode: 'HTML' }));
	});

	it('rejects a routed update when the exact paired identity has changed', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		test.host.pairedIdentity = { ...identity, pairingId: 'replacement' };

		await test.host.deliver(telegramMessageUpdate(1, '/status'));

		expect(test.host.sendMessage).not.toHaveBeenCalled();
		expect(test.logService.warn).toHaveBeenCalledWith('[TelegramRemote] Authorized router rejected a stale identity.');
	});

	it('revalidates the numeric update principal inside the action router', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));

		await test.host.deliver(telegramMessageUpdate(1, 'Status', 999, identity.chatId));

		expect(test.host.sendMessage).not.toHaveBeenCalled();
		expect(test.sessionService.getAllSessions).not.toHaveBeenCalled();
	});

	it('answers a callback even when a downstream callback handler fails', async () => {
		const test = createRouter([firstSession], new Set([firstSession.id]));
		test.activity.handleCallback.mockRejectedValueOnce(new Error('downstream failure'));

		await test.host.deliver(callbackUpdate(1, 'tr1:unknown', 1));

		expect(test.host.answerCallbackQuery).toHaveBeenCalledWith('callback-1', {});
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
	readonly changeSessionEmitter = new Emitter<ICopilotCLISessionItem>();
	override readonly onDidDeleteSession = Event.None;
	override readonly onDidChangeSessions = Event.None;
	override readonly onDidChangeSession = this.changeSessionEmitter.event;
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
	context = new TestTelegramExtensionContext('C:\\telegram-router-test'),
) {
	const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
	registry.registerTransport({
		id: 'telegram',
		label: 'Telegram',
		themeIcon: 'radio-tower',
		capabilities: { submitPrompt: true, requestModes: ['interactive', 'plan'], abort: true },
		publish: () => { },
		dispose: () => { },
	} satisfies IRemoteControlTransport);
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
	const host = new TestCommandHost();
	const sessionService = new TestSessionService();
	sessionService.getAllSessions.mockResolvedValue(sessions);
	sessionService.getSessionItem.mockImplementation(async sessionId => sessions.find(session => session.id === sessionId));
	const dispatch = vi.fn<TelegramPromptDispatcher['dispatch']>(() => ({ accepted: true as const, correlationId: 'request-1', completion }));
	const dispatcher = {
		dispatch,
		prepare: vi.fn<TelegramPromptDispatcher['prepare']>((sessionId, prompt, origin, options) => ({
			correlationId: 'request-1',
			start: () => options ? dispatch(sessionId, prompt, origin, options) : dispatch(sessionId, prompt, origin),
		})),
	} satisfies TelegramPromptDispatcher;
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
	const requestPreferences = {
		getModels: vi.fn<TelegramRequestPreferenceController['getModels']>(async () => []),
		isReasoningEffortSelectionEnabled: vi.fn<TelegramRequestPreferenceController['isReasoningEffortSelectionEnabled']>(() => true),
		setModel: vi.fn<TelegramRequestPreferenceController['setModel']>(async () => ({ kind: 'invalid', error: 'unsupported-model' })),
		setMode: vi.fn<TelegramRequestPreferenceController['setMode']>((_identity, _sessionId, mode) => ({ mode })),
		consumeForDispatch: vi.fn<TelegramRequestPreferenceController['consumeForDispatch']>(async () => ({ kind: 'valid', value: { mode: 'interactive' } })),
		getStatus: vi.fn<TelegramRequestPreferenceController['getStatus']>(async () => ({})),
		clear: vi.fn<TelegramRequestPreferenceController['clear']>(),
	} satisfies TelegramRequestPreferenceController;
	const controlUiState = new TelegramControlUiState(context);
	const fileBrowser = {
		listDirectory: vi.fn<TelegramWorkspaceFileBrowser['listDirectory']>(async (_workspaceRoot, relativePath) => ({ relativePath, entries: [] })),
		readFile: vi.fn<TelegramWorkspaceFileBrowser['readFile']>(async (_workspaceRoot, relativePath) => ({ relativePath, text: '', truncated: false })),
	} satisfies TelegramWorkspaceFileBrowser;
	const logService = new class extends mock<ILogService>() { override warn = vi.fn(); override error = vi.fn(); override info = vi.fn(); };
	const router = new TelegramCommandRouter(host, state, sessionService, registry, dispatcher, sessionCreator, {
		workstationLabel: 'workstation-1', workspaceLabel: 'C:\\workspace', workspaceRoots, remotePermissionResponses: false,
	}, scopePolicy, activity, requestPreferences, controlUiState, fileBrowser, logService);
	return { router, host, state, registry, sessionService, dispatcher, sessionCreator, activity, requestPreferences, controlUiState, fileBrowser, logService, workspaceRoots, context };
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

function lastSentText(host: TestCommandHost): string {
	const sendOrder = host.sendMessage.mock.invocationCallOrder.at(-1) ?? 0;
	const editOrder = host.editMessageText.mock.invocationCallOrder.at(-1) ?? 0;
	return editOrder > sendOrder ? host.editMessageText.mock.calls.at(-1)?.[2] ?? '' : host.sendMessage.mock.calls.at(-1)?.[1] ?? '';
}
function lastSendOptions(host: TestCommandHost): TelegramSendMessageOptions {
	const sendOrder = host.sendMessage.mock.invocationCallOrder.at(-1) ?? 0;
	const editOrder = host.editMessageText.mock.invocationCallOrder.at(-1) ?? 0;
	return editOrder > sendOrder ? host.editMessageText.mock.calls.at(-1)?.[3] ?? {} : host.sendMessage.mock.calls.at(-1)?.[2] ?? {};
}
function firstReplyKeyboardRow(host: TestCommandHost) {
	const markup = lastSendOptions(host).replyKeyboardMarkup;
	return markup && 'keyboard' in markup ? markup.keyboard[0] : undefined;
}
function emptyInlineKeyboardForTest(): TelegramInlineKeyboardMarkup { return { inline_keyboard: [] }; }
