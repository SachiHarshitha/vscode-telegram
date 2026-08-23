/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter } from '../../../../util/vs/base/common/event';
import type { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import type { ICopilotCLISessionItem, ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlSessionEvent, IRemoteControlTransport } from '../../common/remoteControlTypes';
import type { TelegramSessionScopePolicy } from '../../common/telegramSessionScope';
import type { TelegramEditMessageTextOptions, TelegramInlineKeyboardMarkup, TelegramMessage, TelegramSendMessageOptions } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';
import { TelegramActivityCoalescer, type TelegramActivityHost, type TelegramActivityScheduler } from '../telegramActivityCoalescer';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import type { TelegramActivityDetail } from '../telegramEventRenderer';
import { TelegramSessionState } from '../telegramSessionState';
import { TestTelegramExtensionContext } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };
const sessionScopeFingerprint = '1234567890abcdef12345678';
const stopMarkup: TelegramInlineKeyboardMarkup = { inline_keyboard: [[{ text: 'Stop', callback_data: 'tr1:stop' }]] };

describe('TelegramActivityCoalescer', () => {
	it('keeps compact mode semantic and correlates tool names without raw output or reasoning', async () => {
		const test = await createCoalescer('compact');
		await test.coalescer.beginRequest(identity, test.session, 'request-1', stopMarkup);
		await test.coalescer.publish(test.session.id, event('start', 'tool.execution_start', { toolCallId: 'tool-1', toolName: 'run_in_terminal' }));
		await test.coalescer.publish(test.session.id, event('partial', 'tool.execution_partial_result', { toolCallId: 'tool-1', partialOutput: 'diff --git a/private.ts\n+token=super-secret-value' }));
		await test.coalescer.publish(test.session.id, event('reasoning', 'assistant.reasoning', { reasoningId: 'reasoning-1', content: 'hidden repository analysis' }));
		await test.coalescer.publish(test.session.id, event('complete', 'tool.execution_complete', { toolCallId: 'tool-1', success: true, output: 'raw stdout from private repository' }));
		await test.scheduler.runAll();

		const activity = lastActivityText(test.host);
		expect({
			semantic: activity.includes('Run in terminal — completed'),
			diff: activity.includes('diff --git'),
			token: activity.includes('super-secret-value'),
			stdout: activity.includes('raw stdout'),
			reasoning: activity.includes('hidden repository analysis'),
			parseMode: lastActivityOptions(test.host)?.parseMode,
		}).toEqual({ semantic: true, diff: false, token: false, stdout: false, reasoning: false, parseMode: 'HTML' });
	});

	it('shows only bounded current-tool detail in an expandable blockquote for detailed mode', async () => {
		const test = await createCoalescer('detailed');
		await test.coalescer.beginRequest(identity, test.session, 'request-1', stopMarkup);
		await test.coalescer.publish(test.session.id, event('start-1', 'tool.execution_start', { toolCallId: 'tool-1', toolName: 'read_file' }));
		await test.coalescer.publish(test.session.id, event('partial-1', 'tool.execution_partial_result', { toolCallId: 'tool-1', partialOutput: 'first detail' }));
		await test.coalescer.publish(test.session.id, event('start-2', 'tool.execution_start', { toolCallId: 'tool-2', toolName: 'grep_search' }));
		await test.coalescer.publish(test.session.id, event('partial-2', 'tool.execution_partial_result', { toolCallId: 'tool-2', partialOutput: 'second detail password=hunter2' }));
		await test.scheduler.runAll();

		const activity = lastActivityText(test.host);
		expect(activity).toContain('<blockquote expandable>second detail password=redacted</blockquote>');
		expect(activity).not.toContain('first detail');
		expect(activity.length).toBeLessThanOrEqual(4_096);
	});

	it('requires debug mode for bounded diagnostic reasoning and still redacts credentials', async () => {
		const test = await createCoalescer('debug');
		await test.coalescer.beginRequest(identity, test.session, 'request-1', stopMarkup);
		await test.coalescer.publish(test.session.id, event('reasoning', 'assistant.reasoning', {
			reasoningId: 'reasoning-1',
			content: `Diagnostic token=super-secret-value ${'x'.repeat(2_000)}`,
		}));
		await test.scheduler.runAll();

		const activity = lastActivityText(test.host);
		expect(activity).toContain('Diagnostic exposed reasoning');
		expect(activity).toContain('token=redacted');
		expect(activity).not.toContain('super-secret-value');
		expect(activity.length).toBeLessThanOrEqual(4_096);
	});

	it('isolates replay from a new Telegram request generation', async () => {
		const test = await createCoalescer('compact');
		await test.coalescer.publish(test.session.id, replayEvent('old-turn', 'assistant.turn_start', { turnId: 'old-turn' }));
		await test.coalescer.publish(test.session.id, replayEvent('old-tool', 'tool.execution_start', { toolCallId: 'old-tool', toolName: 'apply_patch' }));
		await test.coalescer.publish(test.session.id, replayEvent('old-output', 'tool.execution_complete', { toolCallId: 'old-tool', success: true, output: 'old diff content' }));
		await test.coalescer.publish(test.session.id, replayEvent('old-answer', 'assistant.message', { messageId: 'old-answer', content: 'old final response' }));
		expect(test.host.sendMessage).not.toHaveBeenCalled();

		await test.coalescer.beginRequest(identity, test.session, 'request-new', stopMarkup);
		const activity = lastActivityText(test.host);
		expect(activity).toContain('Prompt accepted');
		expect(activity).not.toContain('old diff content');
		expect(activity).not.toContain('old final response');
		expect(activity).not.toContain('Updating files');
	});

	it('removes Stop and delivers the final Markdown answer separately and exactly once', async () => {
		const test = await createCoalescer('compact');
		const terminal = vi.fn();
		test.coalescer.onDidReachTerminal(terminal);
		const request = await test.coalescer.beginRequest(identity, test.session, 'request-1', stopMarkup);
		expect(request).toEqual({ generation: expect.any(Number), messageId: 1 });
		expect(test.coalescer.isStopControl(test.session.id, 'request-1', request!.generation, 1)).toBe(true);

		await test.coalescer.publish(test.session.id, event('answer', 'assistant.message', {
			messageId: 'answer-1',
			content: '**Done** with [safe](https://example.com) and [unsafe](javascript:alert(1)).',
		}));
		await test.coalescer.publish(test.session.id, event('complete', 'session.task_complete', { success: true, summary: 'Done' }));
		await test.scheduler.runAll();
		await test.coalescer.publish(test.session.id, event('idle-again', 'session.idle', { aborted: false }));
		await test.scheduler.runAll();

		expect(test.host.editMessageReplyMarkup).toHaveBeenCalledWith(identity.chatId, 1, { inline_keyboard: [] });
		expect(test.coalescer.isStopControl(test.session.id, 'request-1', request!.generation, 1)).toBe(false);
		const finalMessages = test.host.sendMessage.mock.calls.filter(call => call[2]?.parseMode === 'HTML' && !call[2]?.disableNotification);
		expect(finalMessages).toHaveLength(1);
		expect(finalMessages[0][1]).toContain('<b>Done</b>');
		expect(finalMessages[0][1]).toContain('<a href="https://example.com/">safe</a>');
		expect(finalMessages[0][1]).not.toContain('javascript:');
		expect(lastActivityText(test.host)).not.toContain('Done');
		expect(lastActivityText(test.host)).toContain('Request completed');
		expect(terminal).toHaveBeenCalledOnce();
	});

	it('keeps a stopped remote connection drain-only until the correlated SDK terminal event', async () => {
		const test = await createCoalescer('compact');
		const terminal = vi.fn();
		test.coalescer.onDidReachTerminal(terminal);
		await test.coalescer.beginRequest(identity, test.session, 'request-1', stopMarkup);
		await test.coalescer.publish(test.session.id, event('answer', 'assistant.message', { messageId: 'answer-1', content: 'The local task finished.' }));

		test.host.isAcceptingUpdates = false;
		expect(test.coalescer.closeRemoteConnection()).toBe(test.session.id);
		test.state.suspend(true);
		await test.scheduler.runAll();
		expect(test.host.preserveDeliveryClient).toHaveBeenCalledOnce();
		expect(lastActivityText(test.host)).toContain('Remote connection closed; task may continue locally');
		expect(lastActivityOptions(test.host)?.replyMarkup).toEqual({ inline_keyboard: [] });
		expect(terminal).not.toHaveBeenCalled();

		await test.coalescer.publish(test.session.id, event('complete', 'session.task_complete', { success: true, summary: 'Done' }));
		await test.scheduler.runAll();

		expect(lastActivityText(test.host)).toContain('Request completed');
		expect(test.host.sendMessage.mock.calls.some(call => call[1].includes('The local task finished.'))).toBe(true);
		expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: test.session.id, requestId: 'request-1', outcome: 'completed' }));
		expect(test.host.clearDeliveryClient).toHaveBeenCalledOnce();
	});

	it('revalidates scope before activity and final delivery and contains Bot API errors', async () => {
		const test = await createCoalescer('compact');
		await test.coalescer.beginRequest(identity, test.session, 'request-1', stopMarkup);
		test.host.editMessageReplyMarkup.mockRejectedValueOnce(new Error('secret remote detail'));
		test.scopeAuthorized.value = false;
		await test.coalescer.publish(test.session.id, event('answer', 'assistant.message', { messageId: 'answer-1', content: 'must not leave this machine' }));
		await test.coalescer.completeRequest(identity, test.session.id, 'request-1', 'completed');
		await test.scheduler.runAll();

		expect(JSON.stringify(test.host.sendMessage.mock.calls)).not.toContain('must not leave this machine');
		expect(JSON.stringify(test.logService.warn.mock.calls)).not.toContain('secret remote detail');
	});
});

class TestActivityHost implements TelegramActivityHost {
	private readonly blockedEmitter = new Emitter<void>();
	private readonly identityEmitter = new Emitter<TelegramPairedIdentity | undefined>();
	readonly onDidBlockRemoteAccess = this.blockedEmitter.event;
	readonly onDidChangePairedIdentity = this.identityEmitter.event;
	isAcceptingUpdates = true;
	pairedIdentity: TelegramPairedIdentity | undefined = identity;

	readonly sendMessage = vi.fn(async (chatId: number, text: string, _options?: TelegramSendMessageOptions): Promise<TelegramMessage> => ({
		message_id: this.sendMessage.mock.calls.length,
		date: 1,
		chat: { id: chatId, type: 'private' },
		text,
	}));
	readonly editMessageText = vi.fn(async (_chatId: number, _messageId: number, _text: string, _options?: TelegramEditMessageTextOptions): Promise<true> => true);
	readonly editMessageReplyMarkup = vi.fn(async (_chatId: number, _messageId: number, _replyMarkup?: TelegramInlineKeyboardMarkup): Promise<true> => true);
	readonly preserveDeliveryClient = vi.fn();
	readonly clearDeliveryClient = vi.fn();
}

class TestScheduler implements TelegramActivityScheduler {
	private currentTime = 0;
	private readonly entries: { readonly dueAt: number; readonly callback: () => Promise<void>; active: boolean }[] = [];

	get pendingCount(): number { return this.entries.filter(entry => entry.active).length; }
	now(): number { return this.currentTime; }
	schedule(callback: () => Promise<void>, delayMs: number): IDisposable {
		const entry = { dueAt: this.currentTime + delayMs, callback, active: true };
		this.entries.push(entry);
		return { dispose: () => entry.active = false };
	}
	async runAll(): Promise<void> {
		while (this.pendingCount > 0) {
			const entry = this.entries.filter(candidate => candidate.active).sort((left, right) => left.dueAt - right.dueAt)[0];
			entry.active = false;
			this.currentTime = entry.dueAt;
			await entry.callback();
		}
	}
}

class TestSessionService extends mock<ICopilotCLISessionService>() {
	constructor(private readonly session: ICopilotCLISessionItem) { super(); }
	override readonly getSessionItem = vi.fn(async (sessionId: string) => sessionId === this.session.id ? this.session : undefined);
}

async function createCoalescer(detail: TelegramActivityDetail) {
	const context = new TestTelegramExtensionContext('C:\\telegram-activity-test');
	const logService = new class extends mock<ILogService>() { override warn = vi.fn(); };
	const registry = new RemoteControlRegistry(logService);
	registry.registerTransport({ id: 'telegram', label: 'Telegram', themeIcon: 'radio-tower', publish: () => { }, dispose: () => { } } satisfies IRemoteControlTransport);
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
	const session = { id: 'session-1', label: 'Session One', timing: undefined, workingDirectory: undefined } satisfies ICopilotCLISessionItem;
	await state.select(identity, session.id, sessionScopeFingerprint);
	const scopeAuthorized = { value: true };
	const scopePolicy: TelegramSessionScopePolicy = {
		authorizeSession: () => scopeAuthorized.value ? { fingerprint: sessionScopeFingerprint, workingDirectoryLabel: 'C:\\authorized-workspace' } : undefined,
	};
	const host = new TestActivityHost();
	const scheduler = new TestScheduler();
	const coalescer = new TelegramActivityCoalescer(host, state, new TestSessionService(session), {
		workstationLabel: 'workstation-1',
	}, scopePolicy, () => detail, scheduler, logService);
	return { coalescer, state, host, scheduler, logService, session, scopeAuthorized };
}

function event(id: string, type: string, data: unknown): IRemoteControlSessionEvent {
	return { id, timestamp: '2026-08-23T12:00:00.000Z', parentId: null, type, data };
}

function replayEvent(id: string, type: string, data: unknown): IRemoteControlSessionEvent {
	return { ...event(id, type, data), replay: true };
}

function lastActivityText(host: TestActivityHost): string {
	return host.editMessageText.mock.calls.at(-1)?.[2] ?? findLastActivitySend(host)?.[1] ?? '';
}

function lastActivityOptions(host: TestActivityHost): TelegramEditMessageTextOptions | TelegramSendMessageOptions | undefined {
	return host.editMessageText.mock.calls.at(-1)?.[3] ?? findLastActivitySend(host)?.[2];
}

function findLastActivitySend(host: TestActivityHost): [chatId: number, text: string, options?: TelegramSendMessageOptions] | undefined {
	for (let index = host.sendMessage.mock.calls.length - 1; index >= 0; index--) {
		if (host.sendMessage.mock.calls[index][2]?.disableNotification) {
			return host.sendMessage.mock.calls[index];
		}
	}
	return undefined;
}
