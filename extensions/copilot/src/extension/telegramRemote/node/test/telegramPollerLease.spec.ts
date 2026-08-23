/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireTelegramPollerLease, getTelegramBotTokenFingerprint, getTelegramPollerLeasePath, TelegramPollerLeaseHeldError } from '../telegramPollerLease';

const botToken = '123456:lease-test-token';

describe('Telegram poller lease', () => {
	let storageRoot: string;

	beforeEach(async () => {
		storageRoot = await mkdtemp(join(tmpdir(), 'telegram-poller-lease-'));
	});

	afterEach(async () => {
		await rm(storageRoot, { recursive: true, force: true });
	});

	it('uses an exclusive token fingerprint lease and releases only its own nonce', async () => {
		const first = await acquireTelegramPollerLease(storageRoot, botToken, { heartbeatIntervalMs: 60_000 });
		const leasePath = getTelegramPollerLeasePath(storageRoot, first.tokenFingerprint);

		await expect(acquireTelegramPollerLease(storageRoot, botToken, { heartbeatIntervalMs: 60_000 })).rejects.toBeInstanceOf(TelegramPollerLeaseHeldError);
		const content = await readFile(leasePath, 'utf8');
		expect({ fingerprint: first.tokenFingerprint, includesToken: content.includes(botToken) }).toEqual({
			fingerprint: getTelegramBotTokenFingerprint(botToken),
			includesToken: false,
		});

		await first.release();
		await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('conservatively refuses a stale-looking lease while its owner process is alive', async () => {
		const now = 1_800_000_000_000;
		const leasePath = getTelegramPollerLeasePath(storageRoot, getTelegramBotTokenFingerprint(botToken));
		await writeStaleLease(leasePath, now, 77);

		await expect(acquireTelegramPollerLease(storageRoot, botToken, {
			now: () => now,
			staleAfterMs: 1_000,
			isProcessAlive: processId => processId === 77,
		})).rejects.toMatchObject({ ownerProcessId: 77 });
	});

	it('recovers a stale lease only after confirming that its owner is gone', async () => {
		const now = 1_800_000_000_000;
		const leasePath = getTelegramPollerLeasePath(storageRoot, getTelegramBotTokenFingerprint(botToken));
		await writeStaleLease(leasePath, now, 88);

		const lease = await acquireTelegramPollerLease(storageRoot, botToken, {
			now: () => now,
			staleAfterMs: 1_000,
			isProcessAlive: () => false,
			heartbeatIntervalMs: 60_000,
		});

		expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ processId: process.pid, tokenFingerprint: lease.tokenFingerprint });
		await lease.release();
	});
});

async function writeStaleLease(leasePath: string, now: number, processId: number): Promise<void> {
	await mkdir(dirname(leasePath), { recursive: true });
	await writeFile(leasePath, JSON.stringify({
		version: 1,
		tokenFingerprint: getTelegramBotTokenFingerprint(botToken),
		processId,
		nonce: 'stale-nonce',
		createdAt: now - 10_000,
		heartbeatAt: now - 10_000,
	}), 'utf8');
	const oldTime = new Date(now - 10_000);
	await utimes(leasePath, oldTime, oldTime);
}
