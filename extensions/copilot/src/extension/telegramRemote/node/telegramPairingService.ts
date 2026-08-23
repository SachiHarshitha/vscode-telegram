/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TelegramUpdate } from '../common/telegramTypes';
import { getTelegramPrivateChatIdentity, TelegramPrivateChatIdentity } from './telegramAuthorization';

const defaultChallengeLifetimeMs = 5 * 60_000;
const defaultAttemptWindowMs = 60_000;
const defaultMaximumAttempts = 5;
const maximumTrackedAttemptIdentities = 128;
const challengeBytes = 16;

interface ActivePairingChallenge {
	readonly value: string;
	readonly tokenFingerprint: string;
	readonly expiresAt: number;
}

interface PairingAttemptState {
	readonly startedAt: number;
	readonly attempts: number;
}

export interface TelegramPairingServiceOptions {
	readonly now?: () => number;
	readonly createRandomBytes?: (size: number) => Buffer;
	readonly challengeLifetimeMs?: number;
	readonly attemptWindowMs?: number;
	readonly maximumAttempts?: number;
}

export interface TelegramPairingChallenge {
	readonly command: string;
	readonly expiresAt: number;
}

export type TelegramPairingRejectionReason = 'invalid-identity' | 'no-active-challenge' | 'expired' | 'invalid-challenge' | 'rate-limited';

export type TelegramPairingResult =
	| { readonly kind: 'ignored' }
	| { readonly kind: 'rejected'; readonly reason: TelegramPairingRejectionReason; readonly identity?: TelegramPrivateChatIdentity }
	| { readonly kind: 'paired'; readonly identity: TelegramPrivateChatIdentity };

/** Owns one cryptographically random, expiring and attempt-throttled pairing challenge. */
export class TelegramPairingService {
	private readonly now: () => number;
	private readonly createRandomBytes: (size: number) => Buffer;
	private readonly challengeLifetimeMs: number;
	private readonly attemptWindowMs: number;
	private readonly maximumAttempts: number;
	private readonly attempts = new Map<string, PairingAttemptState>();
	private activeChallenge: ActivePairingChallenge | undefined;

	constructor(options: TelegramPairingServiceOptions = {}) {
		this.now = options.now ?? Date.now;
		this.createRandomBytes = options.createRandomBytes ?? randomBytes;
		this.challengeLifetimeMs = validatePositiveOption(options.challengeLifetimeMs, defaultChallengeLifetimeMs);
		this.attemptWindowMs = validatePositiveOption(options.attemptWindowMs, defaultAttemptWindowMs);
		this.maximumAttempts = validatePositiveOption(options.maximumAttempts, defaultMaximumAttempts);
	}

	get hasActiveChallenge(): boolean {
		return !!this.activeChallenge && this.activeChallenge.expiresAt > this.now();
	}

	begin(tokenFingerprint: string): TelegramPairingChallenge {
		if (!/^[a-f0-9]{24}$/.test(tokenFingerprint)) {
			throw new Error('Telegram pairing requires a valid token fingerprint.');
		}
		const value = this.createRandomBytes(challengeBytes).toString('base64url');
		if (!value) {
			throw new Error('Telegram pairing challenge generation failed.');
		}
		const expiresAt = this.now() + this.challengeLifetimeMs;
		this.activeChallenge = { value, tokenFingerprint, expiresAt };
		this.attempts.clear();
		return { command: `/pair ${value}`, expiresAt };
	}

	cancel(): void {
		this.activeChallenge = undefined;
		this.attempts.clear();
	}

	handleUpdate(update: TelegramUpdate, tokenFingerprint: string): TelegramPairingResult {
		const command = parsePairCommand(update.message?.text);
		if (!command.recognized) {
			return { kind: 'ignored' };
		}
		const identity = getTelegramPrivateChatIdentity(update);
		if (!identity) {
			return { kind: 'rejected', reason: 'invalid-identity' };
		}
		const challenge = this.activeChallenge;
		if (!challenge) {
			return { kind: 'rejected', reason: 'no-active-challenge', identity };
		}
		const now = this.now();
		if (challenge.expiresAt <= now) {
			this.cancel();
			return { kind: 'rejected', reason: 'expired', identity };
		}
		const attemptKey = `${identity.userId}:${identity.chatId}`;
		if (this.isRateLimited(attemptKey, now)) {
			return { kind: 'rejected', reason: 'rate-limited', identity };
		}
		if (challenge.tokenFingerprint !== tokenFingerprint || !securelyEqual(command.challenge, challenge.value)) {
			const rateLimited = this.recordFailedAttempt(attemptKey, now);
			return { kind: 'rejected', reason: rateLimited ? 'rate-limited' : 'invalid-challenge', identity };
		}

		this.cancel();
		return { kind: 'paired', identity };
	}

	private isRateLimited(attemptKey: string, now: number): boolean {
		const state = this.attempts.get(attemptKey);
		if (!state) {
			return false;
		}
		if (now - state.startedAt >= this.attemptWindowMs) {
			this.attempts.delete(attemptKey);
			return false;
		}
		return state.attempts >= this.maximumAttempts;
	}

	private recordFailedAttempt(attemptKey: string, now: number): boolean {
		const current = this.attempts.get(attemptKey);
		const next = !current || now - current.startedAt >= this.attemptWindowMs
			? { startedAt: now, attempts: 1 }
			: { startedAt: current.startedAt, attempts: current.attempts + 1 };
		this.attempts.set(attemptKey, next);
		while (this.attempts.size > maximumTrackedAttemptIdentities) {
			this.attempts.delete(this.attempts.keys().next().value!);
		}
		return next.attempts >= this.maximumAttempts;
	}
}

function parsePairCommand(text: string | undefined): { readonly recognized: boolean; readonly challenge: string } {
	if (!text) {
		return { recognized: false, challenge: '' };
	}
	const match = /^\/pair(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/.exec(text.trim());
	if (!match) {
		return { recognized: false, challenge: '' };
	}
	const challenge = match[1]?.trim() ?? '';
	return { recognized: true, challenge: challenge.length <= 128 && !/\s/.test(challenge) ? challenge : '' };
}

function securelyEqual(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual, 'utf8');
	const expectedBytes = Buffer.from(expected, 'utf8');
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function validatePositiveOption(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
