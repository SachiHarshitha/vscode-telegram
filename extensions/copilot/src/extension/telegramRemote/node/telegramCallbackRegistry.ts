/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import { TelegramPairedIdentity } from './telegramAuthorization';

const callbackDataPrefix = 'tr1:';
const callbackNonceBytes = 18;
const maximumCallbackDataBytes = 64;
const defaultCallbackLifetimeMs = 5 * 60_000;
const defaultMaximumPendingCallbacks = 500;
const allowedCallbackActions = new Set<TelegramCallbackAction>([
	'session.select',
	'session.create',
	'session.deselect',
	'session.stop',
	'permission.approveOnce',
	'permission.deny',
	'input.choice',
	'plan.interactive',
	'plan.exitOnly',
	'plan.deny',
	'model.select',
	'mode.select',
]);

export type TelegramCallbackAction =
	| 'session.select'
	| 'session.create'
	| 'session.deselect'
	| 'session.stop'
	| 'permission.approveOnce'
	| 'permission.deny'
	| 'input.choice'
	| 'plan.interactive'
	| 'plan.exitOnly'
	| 'plan.deny'
	| 'model.select'
	| 'mode.select';

export interface TelegramCallbackRegistration {
	readonly callbackData: string;
	readonly expiresAt: number;
}

export interface TelegramCallbackContext {
	readonly pairingId: string;
	readonly userId: number;
	readonly chatId: number;
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolCallId?: string;
	readonly action: TelegramCallbackAction;
	readonly value?: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface TelegramCallbackInput {
	readonly identity: TelegramPairedIdentity;
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolCallId?: string;
	readonly action: TelegramCallbackAction;
	readonly value?: string;
	readonly lifetimeMs?: number;
}

export interface TelegramCallbackConstraints {
	readonly sessionId?: string;
	readonly requestId?: string;
	readonly toolCallId?: string;
	readonly action?: TelegramCallbackAction;
}

export interface TelegramCallbackRegistryOptions {
	readonly now?: () => number;
	readonly createRandomBytes?: (size: number) => Buffer;
	readonly defaultLifetimeMs?: number;
	readonly maximumPendingCallbacks?: number;
}

/** Maps opaque Telegram callback data to bounded, identity-bound, one-shot server-side state. */
export class TelegramCallbackRegistry {
	private readonly now: () => number;
	private readonly createRandomBytes: (size: number) => Buffer;
	private readonly defaultLifetimeMs: number;
	private readonly maximumPendingCallbacks: number;
	private readonly pending = new Map<string, TelegramCallbackContext>();

	constructor(options: TelegramCallbackRegistryOptions = {}) {
		this.now = options.now ?? Date.now;
		this.createRandomBytes = options.createRandomBytes ?? randomBytes;
		this.defaultLifetimeMs = positiveIntegerOrDefault(options.defaultLifetimeMs, defaultCallbackLifetimeMs);
		this.maximumPendingCallbacks = positiveIntegerOrDefault(options.maximumPendingCallbacks, defaultMaximumPendingCallbacks);
	}

	get size(): number {
		this.purgeExpired();
		return this.pending.size;
	}

	register(input: TelegramCallbackInput): TelegramCallbackRegistration {
		validateInput(input);
		this.purgeExpired();
		while (this.pending.size >= this.maximumPendingCallbacks) {
			this.pending.delete(this.pending.keys().next().value!);
		}
		const callbackData = this.createCallbackData();
		const createdAt = this.now();
		const lifetimeMs = positiveIntegerOrDefault(input.lifetimeMs, this.defaultLifetimeMs);
		const context: TelegramCallbackContext = {
			pairingId: input.identity.pairingId,
			userId: input.identity.userId,
			chatId: input.identity.chatId,
			sessionId: input.sessionId,
			requestId: input.requestId,
			toolCallId: input.toolCallId,
			action: input.action,
			value: input.value,
			createdAt,
			expiresAt: createdAt + lifetimeMs,
		};
		this.pending.set(callbackData, context);
		return { callbackData, expiresAt: context.expiresAt };
	}

	consume(callbackData: string, identity: TelegramPairedIdentity, constraints: TelegramCallbackConstraints = {}): TelegramCallbackContext | undefined {
		if (!isValidCallbackData(callbackData)) {
			return undefined;
		}
		const context = this.pending.get(callbackData);
		if (!context) {
			return undefined;
		}
		if (context.expiresAt <= this.now()) {
			this.pending.delete(callbackData);
			return undefined;
		}
		if (context.pairingId !== identity.pairingId || context.userId !== identity.userId || context.chatId !== identity.chatId
			|| (constraints.sessionId !== undefined && context.sessionId !== constraints.sessionId)
			|| (constraints.requestId !== undefined && context.requestId !== constraints.requestId)
			|| (constraints.toolCallId !== undefined && context.toolCallId !== constraints.toolCallId)
			|| (constraints.action !== undefined && context.action !== constraints.action)) {
			return undefined;
		}
		this.pending.delete(callbackData);
		return context;
	}

	invalidateSession(sessionId: string): void {
		for (const [callbackData, context] of this.pending) {
			if (context.sessionId === sessionId) {
				this.pending.delete(callbackData);
			}
		}
	}

	invalidateRequest(sessionId: string, requestId: string): void {
		for (const [callbackData, context] of this.pending) {
			if (context.sessionId === sessionId && context.requestId === requestId) {
				this.pending.delete(callbackData);
			}
		}
	}

	invalidateAll(): void {
		this.pending.clear();
	}

	private createCallbackData(): string {
		for (let attempt = 0; attempt < 5; attempt++) {
			const callbackData = `${callbackDataPrefix}${this.createRandomBytes(callbackNonceBytes).toString('base64url')}`;
			if (isValidCallbackData(callbackData) && !this.pending.has(callbackData)) {
				return callbackData;
			}
		}
		throw new Error('Telegram callback nonce generation failed.');
	}

	private purgeExpired(): void {
		const now = this.now();
		for (const [callbackData, context] of this.pending) {
			if (context.expiresAt <= now) {
				this.pending.delete(callbackData);
			}
		}
	}
}

function validateInput(input: TelegramCallbackInput): void {
	if (!isBoundedString(input.identity.pairingId, 128) || !isPositiveSafeInteger(input.identity.userId) || !isPositiveSafeInteger(input.identity.chatId)
		|| !isBoundedString(input.sessionId, 512) || !isBoundedString(input.requestId, 512)
		|| (input.toolCallId !== undefined && !isBoundedString(input.toolCallId, 512))
		|| (input.value !== undefined && !isBoundedString(input.value, 1_024)) || !allowedCallbackActions.has(input.action)) {
		throw new Error('Telegram callback registration is invalid.');
	}
}

function isValidCallbackData(callbackData: string): boolean {
	const byteLength = Buffer.byteLength(callbackData, 'utf8');
	return callbackData.startsWith(callbackDataPrefix) && byteLength >= callbackDataPrefix.length + 1 && byteLength <= maximumCallbackDataBytes;
}

function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function isBoundedString(value: string, maximumLength: number): boolean {
	return value.length > 0 && value.length <= maximumLength;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
