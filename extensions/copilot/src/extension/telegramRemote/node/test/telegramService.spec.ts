/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import type { IAbortSignal, IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Event } from '../../../../util/vs/base/common/event';
import {
	ITelegramBotClient,
	TelegramAnswerCallbackQueryOptions,
	TelegramBotApiError,
	TelegramChatId,
	TelegramEditMessageTextOptions,
	TelegramEditRichMessageOptions,
	TelegramGetUpdatesOptions,
	TelegramInputRichMessage,
	TelegramMessage,
	TelegramSendMessageOptions,
	TelegramSendRichMessageOptions,
	TelegramUpdate,
	TelegramUser,
} from '../../common/telegramTypes';
import { getTelegramBotTokenFingerprint, ITelegramPollerLease, TelegramPollerLeaseHeldError } from '../telegramPollerLease';
import { getTelegramPollingStatePath, ITelegramPollingRuntime, TelegramService } from '../telegramService';

const botToken = '123456:service-test-token';
const bot: TelegramUser = { id: 42, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };

class TestFetcher extends mock<IFetcherService>() {
	override makeAbortController(): AbortController {
		return new AbortController();
	}
}

class TestClient implements ITelegramBotClient {
	readonly getMe = vi.fn(async () => bot);
	readonly getUpdates = vi.fn((_options?: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]> => Promise.resolve([]));

	sendMessage(_chatId: TelegramChatId, _text: string, _options?: TelegramSendMessageOptions): Promise<TelegramMessage> {
		throw new Error('Not used in polling tests.');
	}
	sendRichMessage(_chatId: TelegramChatId, _richMessage: TelegramInputRichMessage, _options?: TelegramSendRichMessageOptions): Promise<TelegramMessage> {
		throw new Error('Not used in polling tests.');
	}
	sendRichMessageDraft(_chatId: number, _draftId: number, _richMessage: TelegramInputRichMessage): Promise<true> {
		throw new Error('Not used in polling tests.');
	}
	editMessageText(_chatId: TelegramChatId, _messageId: number, _text: string, _options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true> {
		throw new Error('Not used in polling tests.');
	}
	editRichMessage(_chatId: TelegramChatId, _messageId: number, _richMessage: TelegramInputRichMessage, _options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true> {
		throw new Error('Not used in polling tests.');
	}
	editMessageReplyMarkup(_chatId: TelegramChatId, _messageId: number): Promise<TelegramMessage | true> {
		throw new Error('Not used in polling tests.');
	}
	answerCallbackQuery(_callbackQueryId: string, _options?: TelegramAnswerCallbackQueryOptions): Promise<true> {
		throw new Error('Not used in polling tests.');
	}
}

class TestLease implements ITelegramPollerLease {
	readonly tokenFingerprint = getTelegramBotTokenFingerprint(botToken);
	readonly takeoverOccurred = false;
	readonly onDidLose = Event.None;
	readonly release = vi.fn(async () => { });
	dispose(): void { void this.release(); }
}

class TestRuntime implements ITelegramPollingRuntime {
	readonly lease = new TestLease();
	readonly delays: number[] = [];
	readonly createClient = vi.fn(() => this.client);
	readonly acquireLease = vi.fn(async () => this.lease as ITelegramPollerLease);

	constructor(readonly client: TestClient) { }

	async delay(milliseconds: number, _signal: IAbortSignal): Promise<void> {
		this.delays.push(milliseconds);
	}
}

describe('TelegramService', () => {
	let storageRoot: string;
	let logService: ILogService;

	beforeEach(async () => {
		storageRoot = await mkdtemp(join(tmpdir(), 'telegram-service-'));
		logService = new class extends mock<ILogService>() {
			override warn = vi.fn();
		};
	});

	afterEach(async () => {
		await rm(storageRoot, { recursive: true, force: true });
	});

	it('deduplicates updates, persists accepted offsets, and resumes after restart', async () => {
		const firstClient = new TestClient();
		firstClient.getUpdates
			.mockResolvedValueOnce([update(5), update(5), update(6)])
			.mockImplementation(options => waitForAbort(options?.signal));
		const firstRuntime = new TestRuntime(firstClient);
		const handled: number[] = [];
		const firstService = new TelegramService(storageRoot, firstRuntime, new TestFetcher(), logService);
		await firstService.start(botToken, async item => { handled.push(item.update_id); });
		await waitUntil(() => handled.length === 2);
		await firstService.stop();

		const statePath = getTelegramPollingStatePath(storageRoot, botToken);
		const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { nextOffset: number };
		const secondClient = new TestClient();
		secondClient.getUpdates
			.mockResolvedValueOnce([update(6), update(7)])
			.mockImplementation(options => waitForAbort(options?.signal));
		const secondRuntime = new TestRuntime(secondClient);
		const resumed: number[] = [];
		const secondService = new TelegramService(storageRoot, secondRuntime, new TestFetcher(), logService);
		await secondService.start(botToken, async item => { resumed.push(item.update_id); });
		await waitUntil(() => resumed.length === 1);
		await secondService.stop();

		expect({ handled, persisted: { nextOffset: persisted.nextOffset }, resumed, resumedOffset: secondClient.getUpdates.mock.calls[0][0]?.offset }).toEqual({
			handled: [5, 6],
			persisted: { nextOffset: 7 },
			resumed: [7],
			resumedOffset: 7,
		});
	});

	it('bounds the configured long-poll timeout before sending it to Telegram', async () => {
		const client = new TestClient();
		client.getUpdates.mockImplementation(options => waitForAbort(options?.signal));
		const service = new TelegramService(storageRoot, new TestRuntime(client), new TestFetcher(), logService);

		await service.start(botToken, async () => { }, undefined, { timeoutSeconds: 99 });
		await waitUntil(() => client.getUpdates.mock.calls.length === 1);
		await service.stop();

		expect(client.getUpdates.mock.calls[0][0]?.timeoutSeconds).toBe(50);
	});

	it('uses retry_after and bounded exponential backoff without spawning another poller', async () => {
		const client = new TestClient();
		client.getUpdates
			.mockRejectedValueOnce(new TelegramBotApiError('rate-limit', 'Limited.', 429, 429, 4))
			.mockRejectedValueOnce(new TelegramBotApiError('server', 'Unavailable.', 503))
			.mockImplementation(options => waitForAbort(options?.signal));
		const runtime = new TestRuntime(client);
		const statuses: string[] = [];
		const service = new TelegramService(storageRoot, runtime, new TestFetcher(), logService);
		service.onDidChangeStatus(status => statuses.push(status.state));

		await service.start(botToken, async () => { });
		await waitUntil(() => runtime.delays.length === 2);
		await service.stop();

		expect({ delays: runtime.delays, leaseCount: runtime.acquireLease.mock.calls.length, statuses }).toEqual({
			delays: [4_000, 2_000],
			leaseCount: 1,
			statuses: ['starting', 'connected', 'retrying', 'retrying', 'stopped'],
		});
	});

	it('does not advance a failed handler update until it is accepted', async () => {
		const client = new TestClient();
		client.getUpdates
			.mockResolvedValueOnce([update(20)])
			.mockResolvedValueOnce([update(20)])
			.mockImplementation(options => waitForAbort(options?.signal));
		const runtime = new TestRuntime(client);
		let attempts = 0;
		const service = new TelegramService(storageRoot, runtime, new TestFetcher(), logService);

		await service.start(botToken, async () => {
			if (++attempts === 1) {
				throw new Error('temporary handler failure');
			}
		});
		await waitUntil(() => attempts === 2);
		await service.stop();

		const state = JSON.parse(await readFile(getTelegramPollingStatePath(storageRoot, botToken), 'utf8')) as { nextOffset: number };
		expect({ attempts, offsetAfterFailure: client.getUpdates.mock.calls[1][0]?.offset, state: { nextOffset: state.nextOffset } }).toEqual({
			attempts: 2,
			offsetAfterFailure: undefined,
			state: { nextOffset: 21 },
		});
	});

	it('does not confirm an update when its offset cannot be persisted', async () => {
		const blockedStorageRoot = join(storageRoot, 'not-a-directory');
		await writeFile(blockedStorageRoot, 'blocks the state directory', 'utf8');
		const client = new TestClient();
		client.getUpdates
			.mockResolvedValueOnce([update(30)])
			.mockImplementation(options => waitForAbort(options?.signal));
		const runtime = new TestRuntime(client);
		const reasons: string[] = [];
		let handled = 0;
		const service = new TelegramService(blockedStorageRoot, runtime, new TestFetcher(), logService);
		service.onDidChangeStatus(status => {
			if (status.state === 'retrying') {
				reasons.push(status.reason);
			}
		});

		await service.start(botToken, async () => { handled++; });
		await waitUntil(() => client.getUpdates.mock.calls.length === 2);
		await service.stop();

		expect({ handled, retryOffset: client.getUpdates.mock.calls[1][0]?.offset, reasons }).toEqual({
			handled: 1,
			retryOffset: undefined,
			reasons: ['storage'],
		});
	});

	it('fails on a competing lease before validation or getUpdates and disposal aborts an active poll', async () => {
		const blockedClient = new TestClient();
		const blockedRuntime = new TestRuntime(blockedClient);
		blockedRuntime.acquireLease.mockRejectedValueOnce(new TelegramPollerLeaseHeldError(77));
		const blockedService = new TelegramService(storageRoot, blockedRuntime, new TestFetcher(), logService);

		await expect(blockedService.start(botToken, async () => { })).rejects.toBeInstanceOf(TelegramPollerLeaseHeldError);
		expect({ getMe: blockedClient.getMe.mock.calls.length, getUpdates: blockedClient.getUpdates.mock.calls.length }).toEqual({ getMe: 0, getUpdates: 0 });

		const activeClient = new TestClient();
		activeClient.getUpdates.mockImplementation(options => waitForAbort(options?.signal));
		const activeRuntime = new TestRuntime(activeClient);
		const activeService = new TelegramService(storageRoot, activeRuntime, new TestFetcher(), logService);
		await activeService.start(botToken, async () => { });
		await waitUntil(() => activeClient.getUpdates.mock.calls.length === 1);
		activeService.dispose();
		await waitUntil(() => activeRuntime.lease.release.mock.calls.length === 1);

		expect(activeRuntime.lease.release).toHaveBeenCalledOnce();
	});

	it('runs secure-state validation before polling and exposes only active-client response methods', async () => {
		const client = new TestClient();
		client.getUpdates.mockImplementation(options => waitForAbort(options?.signal));
		const sentMessage: TelegramMessage = { message_id: 1, date: 1, chat: { id: 202, type: 'private' }, text: 'paired' };
		const sendMessage = vi.spyOn(client, 'sendMessage').mockResolvedValue(sentMessage);
		const editMessageText = vi.spyOn(client, 'editMessageText').mockResolvedValue(true);
		const editMessageReplyMarkup = vi.spyOn(client, 'editMessageReplyMarkup').mockResolvedValue(true);
		const answerCallbackQuery = vi.spyOn(client, 'answerCallbackQuery').mockResolvedValue(true);
		const runtime = new TestRuntime(client);
		const service = new TelegramService(storageRoot, runtime, new TestFetcher(), logService);
		const validated = vi.fn(async () => {
			expect(client.getUpdates).not.toHaveBeenCalled();
		});

		await service.start(botToken, async () => { }, validated);
		await service.sendMessage(202, 'paired');
		await service.editMessageText(202, 1, 'activity', { parseMode: 'HTML' });
		await service.editMessageReplyMarkup(202, 1);
		await service.answerCallbackQuery('callback-1', { text: 'Done' });
		expect(validated).toHaveBeenCalledWith(bot);
		expect(sendMessage).toHaveBeenCalledWith(202, 'paired', undefined);
		expect(editMessageText).toHaveBeenCalledWith(202, 1, 'activity', { parseMode: 'HTML' });
		expect(editMessageReplyMarkup).toHaveBeenCalledWith(202, 1, undefined);
		expect(answerCallbackQuery).toHaveBeenCalledWith('callback-1', { text: 'Done' });
		await service.stop();
		await expect(service.sendMessage(202, 'stopped')).rejects.toMatchObject({ kind: 'api' });

		const failingClient = new TestClient();
		const failingRuntime = new TestRuntime(failingClient);
		const failingService = new TelegramService(storageRoot, failingRuntime, new TestFetcher(), logService);
		await expect(failingService.start(botToken, async () => { }, async () => { throw new Error('secure storage unavailable'); })).rejects.toThrow('secure storage unavailable');
		expect(failingClient.getUpdates).not.toHaveBeenCalled();
		expect(failingRuntime.lease.release).toHaveBeenCalledOnce();
	});

	it('retains outbound delivery after stop only for an explicitly draining local turn', async () => {
		const client = new TestClient();
		client.getUpdates.mockImplementation(options => waitForAbort(options?.signal));
		vi.spyOn(client, 'sendMessage').mockResolvedValue({ message_id: 1, date: 1, chat: { id: 202, type: 'private' } });
		const service = new TelegramService(storageRoot, new TestRuntime(client), new TestFetcher(), logService);
		await service.start(botToken, async () => { });

		service.preserveDeliveryClient();
		await service.stop();
		await expect(service.sendMessage(202, 'terminal')).resolves.toMatchObject({ message_id: 1 });
		service.clearDeliveryClient();
		await expect(service.sendMessage(202, 'closed')).rejects.toMatchObject({ kind: 'api' });
	});
});

function update(updateId: number): TelegramUpdate {
	return { update_id: updateId };
}

function waitForAbort(signal: IAbortSignal | undefined): Promise<readonly TelegramUpdate[]> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new TelegramBotApiError('aborted', 'Cancelled.'));
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort);
	});
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for Telegram service state.');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
