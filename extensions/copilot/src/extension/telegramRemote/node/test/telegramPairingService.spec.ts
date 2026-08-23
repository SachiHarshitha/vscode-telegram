/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { TelegramPairingService } from '../telegramPairingService';
import { telegramMessageUpdate } from './testTelegramSecurityState';

const tokenFingerprint = '0123456789abcdef01234567';

describe('TelegramPairingService', () => {
	it('accepts one valid private-chat challenge exactly once', () => {
		const pairing = createPairingService();
		const challenge = pairing.begin(tokenFingerprint);
		const paired = pairing.handleUpdate(telegramMessageUpdate(1, challenge.command), tokenFingerprint);

		expect(paired).toEqual({
			kind: 'paired',
			identity: expect.objectContaining({ userId: 101, chatId: 202, username: 'first_handle' }),
		});
		expect(pairing.handleUpdate(telegramMessageUpdate(2, challenge.command), tokenFingerprint)).toEqual(expect.objectContaining({ kind: 'rejected', reason: 'no-active-challenge' }));
	});

	it('rejects expired and token-mismatched challenges', () => {
		let now = 1_000;
		const pairing = createPairingService({ now: () => now, challengeLifetimeMs: 100 });
		const challenge = pairing.begin(tokenFingerprint);
		now = challenge.expiresAt;
		expect(pairing.handleUpdate(telegramMessageUpdate(1, challenge.command), tokenFingerprint)).toEqual(expect.objectContaining({ kind: 'rejected', reason: 'expired' }));

		const replacement = pairing.begin(tokenFingerprint);
		expect(pairing.handleUpdate(telegramMessageUpdate(2, replacement.command), 'abcdef0123456789abcdef01')).toEqual(expect.objectContaining({ kind: 'rejected', reason: 'invalid-challenge' }));
	});

	it('throttles repeated failed challenges per numeric user and chat', () => {
		let now = 1_000;
		const pairing = createPairingService({ now: () => now, maximumAttempts: 3, attemptWindowMs: 100 });
		pairing.begin(tokenFingerprint);

		expect(pairing.handleUpdate(telegramMessageUpdate(1, '/pair wrong'), tokenFingerprint)).toEqual(expect.objectContaining({ reason: 'invalid-challenge' }));
		expect(pairing.handleUpdate(telegramMessageUpdate(2, '/pair wrong'), tokenFingerprint)).toEqual(expect.objectContaining({ reason: 'invalid-challenge' }));
		expect(pairing.handleUpdate(telegramMessageUpdate(3, '/pair wrong'), tokenFingerprint)).toEqual(expect.objectContaining({ reason: 'rate-limited' }));
		expect(pairing.handleUpdate(telegramMessageUpdate(4, '/pair wrong'), tokenFingerprint)).toEqual(expect.objectContaining({ reason: 'rate-limited' }));
		expect(pairing.handleUpdate(telegramMessageUpdate(5, '/pair wrong', 999, 202), tokenFingerprint)).toEqual(expect.objectContaining({ reason: 'invalid-challenge' }));
		now += 100;
		expect(pairing.handleUpdate(telegramMessageUpdate(6, '/pair wrong'), tokenFingerprint)).toEqual(expect.objectContaining({ reason: 'invalid-challenge' }));
	});

	it('only recognizes /pair messages from non-bot private chats', () => {
		const pairing = createPairingService();
		const challenge = pairing.begin(tokenFingerprint);

		expect(pairing.handleUpdate(telegramMessageUpdate(1, 'hello'), tokenFingerprint)).toEqual({ kind: 'ignored' });
		expect(pairing.handleUpdate(telegramMessageUpdate(2, challenge.command, 101, -202, 'group'), tokenFingerprint)).toEqual({ kind: 'rejected', reason: 'invalid-identity' });
		expect(pairing.handleUpdate(telegramMessageUpdate(3, challenge.command, 101, 202, 'private', true), tokenFingerprint)).toEqual({ kind: 'rejected', reason: 'invalid-identity' });
		expect(pairing.handleUpdate({ update_id: 4, message: { message_id: 4, date: 1, chat: { id: 202, type: 'private' }, text: challenge.command } }, tokenFingerprint)).toEqual({ kind: 'rejected', reason: 'invalid-identity' });
	});
});

function createPairingService(options: ConstructorParameters<typeof TelegramPairingService>[0] = {}): TelegramPairingService {
	return new TelegramPairingService({
		createRandomBytes: size => Buffer.alloc(size, 7),
		...options,
	});
}
