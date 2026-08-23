/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { FileHandle, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { clearInterval as clearNodeInterval, setInterval as setNodeInterval } from 'node:timers';
import type { IDisposable } from '../../../util/vs/base/common/lifecycle';

const telegramRemoteStateDirectory = 'telegram-remote';
const defaultHeartbeatIntervalMs = 5_000;
const defaultStaleAfterMs = 25_000;

interface TelegramPollerLeaseRecord {
	readonly version: 1;
	readonly tokenFingerprint: string;
	readonly processId: number;
	readonly nonce: string;
	readonly createdAt: number;
	readonly heartbeatAt: number;
}

export interface TelegramPollerLeaseOptions {
	readonly heartbeatIntervalMs?: number;
	readonly staleAfterMs?: number;
	readonly processId?: number;
	readonly now?: () => number;
	readonly isProcessAlive?: (processId: number) => boolean;
}

export interface ITelegramPollerLease extends IDisposable {
	readonly tokenFingerprint: string;
	release(): Promise<void>;
}

export class TelegramPollerLeaseHeldError extends Error {
	constructor(readonly ownerProcessId: number | undefined) {
		super('Another VS Code process already owns the Telegram bot poller lease.');
		this.name = 'TelegramPollerLeaseHeldError';
	}
}

/** Returns a non-reversible identifier suitable for state and lease file names. */
export function getTelegramBotTokenFingerprint(botToken: string): string {
	return createHash('sha256').update(botToken, 'utf8').digest('hex').slice(0, 24);
}

export function getTelegramPollerLeasePath(storageRoot: string, tokenFingerprint: string): string {
	return join(storageRoot, telegramRemoteStateDirectory, `poller-${tokenFingerprint}.lock`);
}

/** Acquires the single long-poll owner slot for a bot token. */
export async function acquireTelegramPollerLease(storageRoot: string, botToken: string, options: TelegramPollerLeaseOptions = {}): Promise<ITelegramPollerLease> {
	const tokenFingerprint = getTelegramBotTokenFingerprint(botToken);
	const leaseDirectory = join(storageRoot, telegramRemoteStateDirectory);
	const leasePath = getTelegramPollerLeasePath(storageRoot, tokenFingerprint);
	const now = options.now ?? Date.now;
	const processId = options.processId ?? process.pid;
	const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	await mkdir(leaseDirectory, { recursive: true });

	for (let attempt = 0; attempt < 3; attempt++) {
		const record: TelegramPollerLeaseRecord = {
			version: 1,
			tokenFingerprint,
			processId,
			nonce: randomUUID(),
			createdAt: now(),
			heartbeatAt: now(),
		};
		try {
			const handle = await open(leasePath, 'wx', 0o600);
			try {
				await writeRecord(handle, record);
				await handle.close();
			} catch (error) {
				await handle.close().catch(() => { });
				await unlink(leasePath).catch(() => { });
				throw error;
			}
			return new TelegramPollerLease(leasePath, record, options);
		} catch (error) {
			if (!hasErrorCode(error, 'EEXIST')) {
				throw error;
			}
		}

		const existing = await readExistingLease(leasePath);
		const ageMs = now() - existing.modifiedAt;
		if (ageMs <= staleAfterMs || (existing.record?.processId !== undefined && isProcessAlive(existing.record.processId))) {
			throw new TelegramPollerLeaseHeldError(existing.record?.processId);
		}

		const latest = await readExistingLease(leasePath);
		if (latest.modifiedAt !== existing.modifiedAt || latest.record?.nonce !== existing.record?.nonce) {
			throw new TelegramPollerLeaseHeldError(latest.record?.processId);
		}
		const stalePath = `${leasePath}.stale-${randomUUID()}`;
		try {
			await rename(leasePath, stalePath);
			await unlink(stalePath).catch(error => {
				if (!hasErrorCode(error, 'ENOENT')) {
					throw error;
				}
			});
		} catch (error) {
			if (hasErrorCode(error, 'ENOENT')) {
				continue;
			}
			throw new TelegramPollerLeaseHeldError(existing.record?.processId);
		}
	}

	throw new TelegramPollerLeaseHeldError(undefined);
}

class TelegramPollerLease implements ITelegramPollerLease {
	readonly tokenFingerprint: string;
	private readonly now: () => number;
	private readonly heartbeat: ReturnType<typeof setNodeInterval>;
	private heartbeatUpdate: Promise<void> | undefined;
	private released = false;

	constructor(
		private readonly leasePath: string,
		private readonly record: TelegramPollerLeaseRecord,
		options: TelegramPollerLeaseOptions,
	) {
		this.tokenFingerprint = record.tokenFingerprint;
		this.now = options.now ?? Date.now;
		this.heartbeat = setNodeInterval(() => {
			if (!this.heartbeatUpdate) {
				const update = this.updateHeartbeat().catch(() => { });
				this.heartbeatUpdate = update;
				void update.finally(() => {
					if (this.heartbeatUpdate === update) {
						this.heartbeatUpdate = undefined;
					}
				});
			}
		}, options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs);
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		clearNodeInterval(this.heartbeat);
		await this.heartbeatUpdate;
		const existing = await readLeaseRecord(this.leasePath);
		if (existing?.nonce !== this.record.nonce) {
			return;
		}
		await unlink(this.leasePath).catch(error => {
			if (!hasErrorCode(error, 'ENOENT')) {
				throw error;
			}
		});
	}

	dispose(): void {
		void this.release().catch(() => { });
	}

	private async updateHeartbeat(): Promise<void> {
		if (this.released) {
			return;
		}
		let handle: FileHandle | undefined;
		try {
			handle = await open(this.leasePath, 'r+');
			const existing = parseLeaseRecord(await handle.readFile({ encoding: 'utf8' }));
			if (existing?.nonce !== this.record.nonce) {
				this.released = true;
				clearNodeInterval(this.heartbeat);
				return;
			}
			await writeRecord(handle, { ...this.record, heartbeatAt: this.now() });
		} catch (error) {
			if (hasErrorCode(error, 'ENOENT')) {
				this.released = true;
				clearNodeInterval(this.heartbeat);
			}
		} finally {
			await handle?.close();
		}
	}
}

async function writeRecord(handle: FileHandle, record: TelegramPollerLeaseRecord): Promise<void> {
	await handle.truncate(0);
	await handle.write(JSON.stringify(record), 0, 'utf8');
	await handle.sync();
}

async function readExistingLease(leasePath: string): Promise<{ readonly modifiedAt: number; readonly record: TelegramPollerLeaseRecord | undefined }> {
	try {
		const [metadata, record] = await Promise.all([stat(leasePath), readLeaseRecord(leasePath)]);
		return { modifiedAt: metadata.mtimeMs, record };
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) {
			return { modifiedAt: 0, record: undefined };
		}
		throw error;
	}
}

async function readLeaseRecord(leasePath: string): Promise<TelegramPollerLeaseRecord | undefined> {
	try {
		return parseLeaseRecord(await readFile(leasePath, 'utf8'));
	} catch {
		return undefined;
	}
}

function parseLeaseRecord(content: string): TelegramPollerLeaseRecord | undefined {
	try {
		const value = JSON.parse(content) as Partial<TelegramPollerLeaseRecord>;
		return value.version === 1 && typeof value.tokenFingerprint === 'string' && Number.isSafeInteger(value.processId) && typeof value.nonce === 'string' && typeof value.createdAt === 'number' && typeof value.heartbeatAt === 'number'
			? value as TelegramPollerLeaseRecord
			: undefined;
	} catch {
		return undefined;
	}
}

function defaultIsProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return hasErrorCode(error, 'EPERM');
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
