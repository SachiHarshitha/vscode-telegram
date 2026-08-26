/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramUpdateRateLimiter } from '../telegramUpdateRateLimiter';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };

describe('TelegramUpdateRateLimiter', () => {
	it('limits messages and callbacks independently and resets the bounded window', () => {
		let now = 1_000;
		const limiter = new TelegramUpdateRateLimiter({
			now: () => now,
			windowMs: 100,
			maximumMessagesPerWindow: 2,
			maximumCallbacksPerWindow: 1,
		});

		expect([
			limiter.accept(identity, 'message'),
			limiter.accept(identity, 'message'),
			limiter.accept(identity, 'message'),
			limiter.accept(identity, 'callback'),
			limiter.accept(identity, 'callback'),
		]).toEqual([true, true, false, true, false]);

		now += 100;
		expect([limiter.accept(identity, 'message'), limiter.accept(identity, 'callback')]).toEqual([true, true]);
	});

	it('keeps identities isolated and evicts old tracking state at the configured bound', () => {
		const limiter = new TelegramUpdateRateLimiter({ maximumMessagesPerWindow: 1, maximumTrackedIdentities: 1 });
		const other = { ...identity, pairingId: 'pairing-2', userId: 303, chatId: 404 };

		expect([
			limiter.accept(identity, 'message'),
			limiter.accept(identity, 'message'),
			limiter.accept(other, 'message'),
			limiter.accept(identity, 'message'),
		]).toEqual([true, false, true, true]);
	});
});
