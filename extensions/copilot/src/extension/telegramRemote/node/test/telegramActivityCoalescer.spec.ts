/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter } from '../../../../util/vs/base/common/event';
import type { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import type { ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlSessionEvent, IRemoteControlTransport } from '../../common/remoteControlTypes';
import type { TelegramEditMessageTextOptions, TelegramMessage, TelegramSendMessageOptions } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';
import { TelegramActivityCoalescer, type TelegramActivityHost, type TelegramActivityScheduler } from '../telegramActivityCoalescer';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramSessionState } from '../telegramSessionState';
import { TestTelegramExtensionContext } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };

describe('TelegramActivityCoalescer', () => {
	it('coalesces high-frequency deltas, caps actions, edits, memory, and Bot API chunks', async () => {
		const test = await createCoalescer('session-1');
		for (let index = 0; index < 20; index++) {
			await test.coalescer.publish('session-1', event(`tool-${index}`, 'tool.execution_start', { toolCallId: `tool-${index}`, toolName: `tool_${index}` }));
		}
		for (let index = 0; index < 100; index++) {
			await test.coalescer.publish('session-1', event(`delta-${index}`, 'assistant.message_delta', { messageId: 'message-1', deltaContent: 'chunk_' }));
		}

		expect(test.scheduler.pendingCount).toBe(1);
		await test.scheduler.runNext();
		expect({ sends: test.host.sendMessage.mock.calls.length, edits: test.host.editMessageText.mock.calls.length, dueTimes: test.scheduler.runTimes }).toEqual({ sends: 1, edits: 0, dueTimes: [250] });
		const firstText = test.host.sendMessage.mock.calls[0][1];
		expect(firstText).toContain('tool\\_19');
		expect(firstText).not.toContain('tool\\_0');

		for (let index = 0; index < 50; index++) {
			await test.coalescer.publish('session-1', event(`later-${index}`, 'assistant.message_delta', { messageId: 'message-1', deltaContent: 'more_' }));
		}
		await test.scheduler.runNext();
		expect({ sends: test.host.sendMessage.mock.calls.length, edits: test.host.editMessageText.mock.calls.length, dueTimes: test.scheduler.runTimes }).toEqual({ sends: 1, edits: 1, dueTimes: [250, 1250] });

		await test.coalescer.publish('session-1', event('final', 'assistant.message', { messageId: 'message-1', content: '#'.repeat(20_000) }));
		await test.coalescer.publish('session-1', event('idle', 'session.idle', { aborted: false }));
		await test.scheduler.runNext();
		const allTexts = [
			...test.host.sendMessage.mock.calls.map(call => call[1]),
			...test.host.editMessageText.mock.calls.map(call => call[2]),
		];
		expect({
			sends: test.host.sendMessage.mock.calls.length,
			edits: test.host.editMessageText.mock.calls.length,
			dueTimes: test.scheduler.runTimes,
			maximumLength: Math.max(...allTexts.map(text => text.length)),
			parseModes: [
				...test.host.sendMessage.mock.calls.map(call => call[2]?.parseMode),
				...test.host.editMessageText.mock.calls.map(call => call[3]?.parseMode),
			],
		}).toEqual({
			sends: 4,
			edits: 2,
			dueTimes: [250, 1250, 2250],
			maximumLength: 4096,
			parseModes: ['MarkdownV2', 'MarkdownV2', 'MarkdownV2', 'MarkdownV2', 'MarkdownV2', 'MarkdownV2'],
		});
	});

	it('clears old activity on session switch and ignores stale or unsupported events', async () => {
		const test = await createCoalescer('session-1');
		await test.coalescer.publish('session-1', event('old', 'assistant.message_delta', { messageId: 'old-message', deltaContent: 'old text' }));
		await test.state.select(identity, 'session-2');
		await test.coalescer.publish('session-1', event('stale', 'assistant.message_delta', { messageId: 'old-message', deltaContent: 'stale text' }));
		await test.coalescer.publish('session-2', event('interactive', 'permission.requested', { requestId: 'permission-1' }));
		await test.coalescer.publish('session-2', event('new', 'assistant.message_delta', { messageId: 'new-message', deltaContent: 'new text' }));
		await test.scheduler.runAll();

		expect(test.host.sendMessage).toHaveBeenCalledOnce();
		expect(test.host.sendMessage.mock.calls[0][1]).toContain('new text');
		expect(test.host.sendMessage.mock.calls[0][1]).not.toContain('old text');
	});

	it('cancels pending output when local access is blocked and contains API failures', async () => {
		const blocked = await createCoalescer('session-1');
		await blocked.coalescer.publish('session-1', event('pending', 'assistant.intent', { intent: 'Pending' }));
		blocked.host.block();
		await blocked.scheduler.runAll();
		expect(blocked.host.sendMessage).not.toHaveBeenCalled();

		const failing = await createCoalescer('session-1');
		failing.host.sendMessage.mockRejectedValueOnce(new Error('secret remote description'));
		await failing.coalescer.publish('session-1', event('error', 'session.error', { message: 'Agent failed' }));
		await failing.scheduler.runAll();
		expect(failing.logService.warn).toHaveBeenCalledWith('[TelegramRemote] Failed to publish a Telegram activity update.');
		expect(String(failing.logService.warn.mock.calls[0])).not.toContain('secret remote description');
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

	block(): void {
		this.isAcceptingUpdates = false;
		this.blockedEmitter.fire();
	}
}

class TestScheduler implements TelegramActivityScheduler {
	private currentTime = 0;
	private readonly entries: { readonly dueAt: number; readonly callback: () => Promise<void>; active: boolean }[] = [];
	readonly runTimes: number[] = [];

	get pendingCount(): number {
		return this.entries.filter(entry => entry.active).length;
	}

	now(): number {
		return this.currentTime;
	}

	schedule(callback: () => Promise<void>, delayMs: number): IDisposable {
		const entry = { dueAt: this.currentTime + delayMs, callback, active: true };
		this.entries.push(entry);
		return { dispose: () => entry.active = false };
	}

	async runNext(): Promise<void> {
		const entry = this.entries.filter(candidate => candidate.active).sort((left, right) => left.dueAt - right.dueAt)[0];
		if (!entry) {
			throw new Error('No scheduled activity flush.');
		}
		entry.active = false;
		this.currentTime = entry.dueAt;
		this.runTimes.push(this.currentTime);
		await entry.callback();
	}

	async runAll(): Promise<void> {
		while (this.pendingCount > 0) {
			await this.runNext();
		}
	}
}

class TestSessionService extends mock<ICopilotCLISessionService>() {
	override readonly getSessionItem = vi.fn(async (sessionId: string) => ({ id: sessionId, label: `Session ${sessionId}`, timing: undefined, workingDirectory: undefined }));
}

async function createCoalescer(sessionId: string) {
	const context = new TestTelegramExtensionContext('C:\\telegram-activity-test');
	const logService = new class extends mock<ILogService>() { override warn = vi.fn(); };
	const registry = new RemoteControlRegistry(logService);
	registry.registerTransport({ id: 'telegram', label: 'Telegram', themeIcon: 'radio-tower', publish: () => { }, dispose: () => { } } satisfies IRemoteControlTransport);
	const state = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
	await state.select(identity, sessionId);
	const host = new TestActivityHost();
	const scheduler = new TestScheduler();
	const coalescer = new TelegramActivityCoalescer(host, state, new TestSessionService(), {
		workstationLabel: 'workstation-1',
		workspaceLabel: 'C:\\workspace',
	}, scheduler, logService);
	return { coalescer, state, host, scheduler, logService };
}

function event(id: string, type: string, data: unknown): IRemoteControlSessionEvent {
	return { id, timestamp: '2026-08-23T12:00:00.000Z', parentId: null, type, data };
}
