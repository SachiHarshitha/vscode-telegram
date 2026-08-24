/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ILogService } from '../../../platform/log/common/logService';
import { IAbortController, IAbortSignal, IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import {
	ITelegramBotClient,
	TelegramAnswerCallbackQueryOptions,
	TelegramBotApiError,
	TelegramEditMessageTextOptions,
	TelegramEditRichMessageOptions,
	TelegramInputRichMessage,
	TelegramMessage,
	TelegramPollingFailureKind,
	TelegramPollingStatus,
	TelegramSendMessageOptions,
	TelegramSendRichMessageOptions,
	TelegramUpdate,
	TelegramUser,
} from '../common/telegramTypes';
import { TelegramBotClient } from './telegramBotClient';
import { acquireTelegramPollerLease, getTelegramBotTokenFingerprint, ITelegramPollerLease, TelegramPollerLeaseHeldError } from './telegramPollerLease';

const defaultLongPollTimeoutSeconds = 25;
const minimumLongPollTimeoutSeconds = 1;
const maximumLongPollTimeoutSeconds = 50;
const maximumBackoffMs = 30_000;
const initialBackoffMs = 1_000;
const maximumRecentUpdateIds = 1_000;
const takeoverHandoffDelayMs = 6_000;

interface TelegramPollingStateFile {
	readonly version: 1;
	readonly tokenFingerprint: string;
	readonly nextOffset: number;
	readonly updatedAt: number;
}

interface TelegramPollingRun {
	readonly generation: number;
	readonly client: ITelegramBotClient;
	readonly lease: ITelegramPollerLease;
	readonly controller: IAbortController;
	readonly bot: TelegramUser;
	readonly recentUpdateIds: Set<number>;
	readonly recentUpdateIdOrder: number[];
	readonly leaseLossListener: IDisposable;
	readonly longPollTimeoutSeconds: number;
	requestedStop: boolean;
	nextOffset: number | undefined;
	promise: Promise<void>;
}

export interface ITelegramPollingRuntime {
	createClient(botToken: string): ITelegramBotClient;
	acquireLease(storageRoot: string, botToken: string, forceTakeover?: boolean): Promise<ITelegramPollerLease>;
	delay(milliseconds: number, signal: IAbortSignal): Promise<void>;
}

export type TelegramUpdateHandler = (update: TelegramUpdate) => Promise<void>;
export type TelegramValidatedHandler = (bot: TelegramUser) => Promise<void>;

export interface TelegramPollingOptions {
	readonly timeoutSeconds?: number;
	readonly forceLeaseTakeover?: boolean;
}

/** Owns one abortable, durable Telegram getUpdates loop. */
export class TelegramService extends Disposable {
	private readonly statusEmitter = this._register(new Emitter<TelegramPollingStatus>());
	readonly onDidChangeStatus: Event<TelegramPollingStatus> = this.statusEmitter.event;

	private readonly runtime: ITelegramPollingRuntime;
	private status: TelegramPollingStatus = { state: 'stopped' };
	private generation = 0;
	private startingController: IAbortController | undefined;
	private activeRun: TelegramPollingRun | undefined;
	private deliveryClient: ITelegramBotClient | undefined;
	private preserveDeliveryClientAfterStop = false;

	constructor(
		private readonly storageRoot: string,
		runtime: ITelegramPollingRuntime | undefined,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.runtime = runtime ?? new DefaultTelegramPollingRuntime(fetcherService);
	}

	get currentStatus(): TelegramPollingStatus {
		return this.status;
	}

	async start(botToken: string, handleUpdate: TelegramUpdateHandler, handleValidated?: TelegramValidatedHandler, options?: TelegramPollingOptions): Promise<TelegramUser> {
		await this.stop();
		this.clearDeliveryClient();
		const generation = ++this.generation;
		const controller = this.fetcherService.makeAbortController();
		this.startingController = controller;
		this.setStatus({ state: 'starting' });

		let lease: ITelegramPollerLease | undefined;
		try {
			lease = await this.runtime.acquireLease(this.storageRoot, botToken, options?.forceLeaseTakeover);
			if (generation !== this.generation) {
				await lease.release();
				throw new TelegramBotApiError('aborted', 'Telegram polling startup was cancelled.');
			}
			if (lease.takeoverOccurred) {
				this.logService.info('[TelegramRemote] Explicit reconnect took ownership of the Telegram poller; waiting for the previous owner to stop.');
				await this.runtime.delay(takeoverHandoffDelayMs, controller.signal);
				if (generation !== this.generation || controller.signal.aborted) {
					await lease.release();
					throw new TelegramBotApiError('aborted', 'Telegram polling startup was cancelled.');
				}
			}
			const client = this.runtime.createClient(botToken);
			const bot = await client.getMe(controller.signal);
			if (generation !== this.generation) {
				await lease.release();
				throw new TelegramBotApiError('aborted', 'Telegram polling startup was cancelled.');
			}
			await handleValidated?.(bot);
			if (generation !== this.generation) {
				await lease.release();
				throw new TelegramBotApiError('aborted', 'Telegram polling startup was cancelled.');
			}

			this.deliveryClient = client;
			const leaseLossListener = lease.onDidLose(() => this.handleLeaseLoss(generation, controller));
			const nextOffset = await this.loadOffset(lease.tokenFingerprint);
			if (generation !== this.generation || controller.signal.aborted) {
				leaseLossListener.dispose();
				await lease.release();
				throw new TelegramBotApiError('aborted', 'Telegram polling startup was cancelled.');
			}
			const run: TelegramPollingRun = {
				generation,
				client,
				lease,
				controller,
				bot,
				recentUpdateIds: new Set(),
				recentUpdateIdOrder: [],
				leaseLossListener,
				longPollTimeoutSeconds: normalizeLongPollTimeout(options?.timeoutSeconds),
				requestedStop: false,
				nextOffset,
				promise: Promise.resolve(),
			};
			this.startingController = undefined;
			this.activeRun = run;
			this.setStatus({ state: 'connected', bot });
			run.promise = this.poll(run, handleUpdate).finally(() => this.finishRun(run));
			return bot;
		} catch (error) {
			this.startingController = undefined;
			await lease?.release();
			if (generation === this.generation && !isCancellation(error)) {
				this.setStatus({ state: 'failed', reason: classifyPollingFailure(error) });
			}
			throw error;
		}
	}

	async sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram polling is not connected.');
		}
		return client.sendMessage(chatId, text, options);
	}

	async sendRichMessage(chatId: number, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageOptions): Promise<TelegramMessage> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram Remote is not connected.');
		}
		return client.sendRichMessage(chatId, richMessage, options);
	}

	async sendRichMessageDraft(chatId: number, draftId: number, richMessage: TelegramInputRichMessage): Promise<true> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram Remote is not connected.');
		}
		return client.sendRichMessageDraft(chatId, draftId, richMessage);
	}

	async editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram polling is not connected.');
		}
		return client.editMessageText(chatId, messageId, text, options);
	}

	async editRichMessage(chatId: number, messageId: number, richMessage: TelegramInputRichMessage, options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram Remote is not connected.');
		}
		return client.editRichMessage(chatId, messageId, richMessage, options);
	}

	async editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: TelegramSendMessageOptions['replyMarkup']): Promise<TelegramMessage | true> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram polling is not connected.');
		}
		return client.editMessageReplyMarkup(chatId, messageId, replyMarkup);
	}

	async answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void> {
		const client = this.activeRun?.client ?? this.deliveryClient;
		if (!client) {
			throw new TelegramBotApiError('api', 'Telegram polling is not connected.');
		}
		await client.answerCallbackQuery(callbackQueryId, options);
	}

	/** Keeps outbound delivery available while an already-started local turn reaches its terminal event. */
	preserveDeliveryClient(): void {
		this.deliveryClient = this.activeRun?.client ?? this.deliveryClient;
		this.preserveDeliveryClientAfterStop = this.deliveryClient !== undefined;
	}

	/** Releases the outbound-only client retained to finish a locally continuing activity. */
	clearDeliveryClient(): void {
		this.deliveryClient = undefined;
		this.preserveDeliveryClientAfterStop = false;
	}

	async stop(): Promise<void> {
		this.generation++;
		this.startingController?.abort();
		this.startingController = undefined;
		const run = this.activeRun;
		if (run) {
			run.requestedStop = true;
			run.controller.abort();
			await run.promise;
		}
		if (this.status.state !== 'stopped') {
			this.setStatus({ state: 'stopped' });
		}
		if (!this.preserveDeliveryClientAfterStop) {
			this.deliveryClient = undefined;
		}
	}

	private async poll(run: TelegramPollingRun, handleUpdate: TelegramUpdateHandler): Promise<void> {
		let failures = 0;
		while (this.isActive(run)) {
			try {
				const updates = await run.client.getUpdates({
					offset: run.nextOffset,
					limit: 100,
					timeoutSeconds: run.longPollTimeoutSeconds,
					allowedUpdates: ['message', 'callback_query'],
					signal: run.controller.signal,
				});
				failures = 0;
				if (this.isActive(run) && this.status.state === 'retrying') {
					this.setStatus({ state: 'connected', bot: run.bot });
				}
				for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
					if (!this.isActive(run)) {
						return;
					}
					if ((run.nextOffset !== undefined && update.update_id < run.nextOffset) || run.recentUpdateIds.has(update.update_id)) {
						continue;
					}
					await handleUpdate(update);
					const nextOffset = Math.max(run.nextOffset ?? 0, update.update_id + 1);
					await this.saveOffset(run.lease.tokenFingerprint, nextOffset);
					rememberUpdateId(run, update.update_id);
					run.nextOffset = nextOffset;
				}
			} catch (error) {
				if (!this.isActive(run) || isCancellation(error)) {
					return;
				}
				const reason = classifyPollingFailure(error);
				if (reason === 'authentication') {
					this.setStatus({ state: 'failed', reason });
					return;
				}
				failures++;
				const retryInMs = getRetryDelay(error, failures);
				this.logService.warn(`[TelegramRemote] Telegram polling failed (${reason}); retrying in ${retryInMs}ms.`);
				this.setStatus({ state: 'retrying', retryInMs, attempt: failures, reason });
				await this.runtime.delay(retryInMs, run.controller.signal);
			}
		}
	}

	private async finishRun(run: TelegramPollingRun): Promise<void> {
		run.leaseLossListener.dispose();
		await run.lease.release().catch(() => {
			this.logService.warn('[TelegramRemote] Failed to release the Telegram poller lease.');
		});
		if (this.activeRun === run) {
			this.activeRun = undefined;
			if (run.requestedStop && this.status.state !== 'stopped') {
				this.setStatus({ state: 'stopped' });
			}
		}
	}

	private handleLeaseLoss(generation: number, controller: IAbortController): void {
		if (generation !== this.generation) {
			return;
		}
		this.logService.warn('[TelegramRemote] Telegram poller ownership was transferred to another VS Code window.');
		this.setStatus({ state: 'failed', reason: 'lease' });
		controller.abort();
	}

	private isActive(run: TelegramPollingRun): boolean {
		return this.activeRun === run && run.generation === this.generation && !run.controller.signal.aborted;
	}

	private async loadOffset(tokenFingerprint: string): Promise<number | undefined> {
		try {
			const parsed = JSON.parse(await readFile(getStatePath(this.storageRoot, tokenFingerprint), 'utf8')) as Partial<TelegramPollingStateFile>;
			const offset = parsed.version === 1 && parsed.tokenFingerprint === tokenFingerprint && Number.isSafeInteger(parsed.nextOffset) && (parsed.nextOffset ?? -1) >= 0
				? parsed.nextOffset
				: undefined;
			if (offset === undefined) {
				this.logService.warn('[TelegramRemote] Ignoring an invalid Telegram polling offset file.');
			}
			return offset;
		} catch (error) {
			if (!hasErrorCode(error, 'ENOENT')) {
				this.logService.warn('[TelegramRemote] Unable to read the Telegram polling offset file; updates may be replayed.');
			}
			return undefined;
		}
	}

	private async saveOffset(tokenFingerprint: string, nextOffset: number): Promise<void> {
		const statePath = getStatePath(this.storageRoot, tokenFingerprint);
		const temporaryPath = `${statePath}.${process.pid}-${randomUUID()}.tmp`;
		try {
			await mkdir(dirname(statePath), { recursive: true });
			const state: TelegramPollingStateFile = { version: 1, tokenFingerprint, nextOffset, updatedAt: Date.now() };
			await writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			await rename(temporaryPath, statePath);
		} catch {
			await unlink(temporaryPath).catch(() => { });
			throw new TelegramPollingStorageError();
		}
	}

	private setStatus(status: TelegramPollingStatus): void {
		this.status = status;
		this.statusEmitter.fire(status);
	}

	public override dispose(): void {
		void this.stop();
		super.dispose();
	}
}

class DefaultTelegramPollingRuntime implements ITelegramPollingRuntime {
	constructor(private readonly fetcherService: IFetcherService) { }

	createClient(botToken: string): ITelegramBotClient {
		return new TelegramBotClient(botToken, undefined, this.fetcherService);
	}

	acquireLease(storageRoot: string, botToken: string, forceTakeover?: boolean): Promise<ITelegramPollerLease> {
		return acquireTelegramPollerLease(storageRoot, botToken, { forceTakeover });
	}

	delay(milliseconds: number, signal: IAbortSignal): Promise<void> {
		if (signal.aborted) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			const onAbort = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				resolve();
			};
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, milliseconds);
			signal.addEventListener('abort', onAbort);
			if (signal.aborted) {
				onAbort();
			}
		});
	}
}

function getStatePath(storageRoot: string, tokenFingerprint: string): string {
	return join(storageRoot, 'telegram-remote', `poller-state-${tokenFingerprint}.json`);
}

function rememberUpdateId(run: TelegramPollingRun, updateId: number): void {
	run.recentUpdateIds.add(updateId);
	run.recentUpdateIdOrder.push(updateId);
	while (run.recentUpdateIdOrder.length > maximumRecentUpdateIds) {
		run.recentUpdateIds.delete(run.recentUpdateIdOrder.shift()!);
	}
}

function normalizeLongPollTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return defaultLongPollTimeoutSeconds;
	}
	return Math.min(maximumLongPollTimeoutSeconds, Math.max(minimumLongPollTimeoutSeconds, Math.trunc(value)));
}

function getRetryDelay(error: unknown, failureCount: number): number {
	const rateLimitDelay = error instanceof TelegramBotApiError && error.retryAfterSeconds !== undefined
		? Math.max(initialBackoffMs, error.retryAfterSeconds * 1000)
		: initialBackoffMs * 2 ** Math.min(failureCount - 1, 5);
	return Math.min(maximumBackoffMs, rateLimitDelay);
}

function classifyPollingFailure(error: unknown): TelegramPollingFailureKind {
	if (error instanceof TelegramPollerLeaseHeldError) {
		return 'lease';
	}
	if (error instanceof TelegramBotApiError) {
		return error.kind;
	}
	if (error instanceof TelegramPollingStorageError) {
		return 'storage';
	}
	return 'handler';
}

function isCancellation(error: unknown): boolean {
	return error instanceof TelegramBotApiError && error.kind === 'aborted';
}

export function getTelegramPollingStatePath(storageRoot: string, botToken: string): string {
	return getStatePath(storageRoot, getTelegramBotTokenFingerprint(botToken));
}

class TelegramPollingStorageError extends Error {
	constructor() {
		super('Telegram polling offset could not be persisted.');
		this.name = 'TelegramPollingStorageError';
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
