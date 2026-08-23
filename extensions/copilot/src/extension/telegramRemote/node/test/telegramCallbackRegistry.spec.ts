/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramCallbackRegistry } from '../telegramCallbackRegistry';

const identity: TelegramPairedIdentity = {
	pairingId: 'pairing-1',
	userId: 101,
	chatId: 202,
	firstName: 'First',
	pairedAt: 1_000,
};

describe('TelegramCallbackRegistry', () => {
	it('issues Bot API-sized opaque data and consumes it exactly once', () => {
		const registry = createRegistry();
		const registration = registry.register(input());

		expect(Buffer.byteLength(registration.callbackData, 'utf8')).toBeLessThanOrEqual(64);
		expect(registration.callbackData).not.toContain('session-1');
		expect(registration.callbackData).not.toContain('approve');
		expect(registry.consume(registration.callbackData, identity)).toEqual(expect.objectContaining({
			sessionId: 'session-1',
			requestId: 'request-1',
			action: 'permission.approveOnce',
		}));
		expect(registry.consume(registration.callbackData, identity)).toBeUndefined();
	});

	it('rejects expired and unknown nonces', () => {
		let now = 1_000;
		const registry = createRegistry({ now: () => now, defaultLifetimeMs: 100 });
		const registration = registry.register(input());
		now = registration.expiresAt;

		expect(registry.consume(registration.callbackData, identity)).toBeUndefined();
		expect(registry.consume('tr1:unknown', identity)).toBeUndefined();
		expect(registry.size).toBe(0);
	});

	it('binds callbacks to pairing, user, chat, session, request, tool call and action', () => {
		const registry = createRegistry();
		const registration = registry.register(input({ toolCallId: 'tool-1' }));

		expect(registry.consume(registration.callbackData, { ...identity, pairingId: 'pairing-2' })).toBeUndefined();
		expect(registry.consume(registration.callbackData, { ...identity, userId: 999 })).toBeUndefined();
		expect(registry.consume(registration.callbackData, { ...identity, chatId: 999 })).toBeUndefined();
		expect(registry.consume(registration.callbackData, identity, { sessionId: 'session-2' })).toBeUndefined();
		expect(registry.consume(registration.callbackData, identity, { requestId: 'request-2' })).toBeUndefined();
		expect(registry.consume(registration.callbackData, identity, { toolCallId: 'tool-2' })).toBeUndefined();
		expect(registry.consume(registration.callbackData, identity, { action: 'permission.deny' })).toBeUndefined();
		expect(registry.consume(registration.callbackData, identity, {
			sessionId: 'session-1', requestId: 'request-1', toolCallId: 'tool-1', action: 'permission.approveOnce',
		})).toBeDefined();
	});

	it('invalidates request, session and all pending callbacks', () => {
		let nonce = 0;
		const registry = createRegistry({ createRandomBytes: size => Buffer.alloc(size, ++nonce) });
		const first = registry.register(input());
		const second = registry.register(input({ requestId: 'request-2' }));
		const third = registry.register(input({ sessionId: 'session-2', requestId: 'request-3' }));

		registry.invalidateRequest('session-1', 'request-1');
		expect(registry.consume(first.callbackData, identity)).toBeUndefined();
		registry.invalidateSession('session-1');
		expect(registry.consume(second.callbackData, identity)).toBeUndefined();
		expect(registry.size).toBe(1);
		registry.invalidateAll();
		expect(registry.consume(third.callbackData, identity)).toBeUndefined();
	});

	it('enforces a bounded pending registry by evicting the oldest callback', () => {
		let nonce = 0;
		const registry = createRegistry({ maximumPendingCallbacks: 2, createRandomBytes: size => Buffer.alloc(size, ++nonce) });
		const first = registry.register(input());
		const second = registry.register(input({ requestId: 'request-2' }));
		const third = registry.register(input({ requestId: 'request-3' }));

		expect(registry.consume(first.callbackData, identity)).toBeUndefined();
		expect(registry.consume(second.callbackData, identity)).toBeDefined();
		expect(registry.consume(third.callbackData, identity)).toBeDefined();
	});
});

function input(overrides: Partial<Parameters<TelegramCallbackRegistry['register']>[0]> = {}): Parameters<TelegramCallbackRegistry['register']>[0] {
	return {
		identity,
		sessionId: 'session-1',
		requestId: 'request-1',
		action: 'permission.approveOnce',
		...overrides,
	};
}

function createRegistry(options: ConstructorParameters<typeof TelegramCallbackRegistry>[0] = {}): TelegramCallbackRegistry {
	return new TelegramCallbackRegistry({
		now: () => 1_000,
		createRandomBytes: size => Buffer.alloc(size, 1),
		...options,
	});
}
