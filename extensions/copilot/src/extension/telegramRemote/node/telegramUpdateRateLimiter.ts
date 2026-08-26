/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TelegramPairedIdentity } from './telegramAuthorization';

export type TelegramRateLimitedUpdateKind = 'message' | 'callback';

export interface TelegramUpdateRateLimiterOptions {
	readonly now?: () => number;
	readonly windowMs?: number;
	readonly maximumMessagesPerWindow?: number;
	readonly maximumCallbacksPerWindow?: number;
	readonly maximumTrackedIdentities?: number;
}

interface TelegramUpdateRateState {
	windowStartedAt: number;
	messages: number;
	callbacks: number;
}

/** Fixed-window admission control with bounded identity tracking and no message-content state. */
export class TelegramUpdateRateLimiter {
	private readonly now: () => number;
	private readonly windowMs: number;
	private readonly maximumMessagesPerWindow: number;
	private readonly maximumCallbacksPerWindow: number;
	private readonly maximumTrackedIdentities: number;
	private readonly states = new Map<string, TelegramUpdateRateState>();

	constructor(options: TelegramUpdateRateLimiterOptions = {}) {
		this.now = options.now ?? Date.now;
		this.windowMs = positiveIntegerOrDefault(options.windowMs, 10_000);
		this.maximumMessagesPerWindow = positiveIntegerOrDefault(options.maximumMessagesPerWindow, 20);
		this.maximumCallbacksPerWindow = positiveIntegerOrDefault(options.maximumCallbacksPerWindow, 40);
		this.maximumTrackedIdentities = positiveIntegerOrDefault(options.maximumTrackedIdentities, 128);
	}

	accept(identity: TelegramPairedIdentity, kind: TelegramRateLimitedUpdateKind): boolean {
		const key = `${identity.pairingId}:${identity.userId}:${identity.chatId}`;
		const now = this.now();
		let state = this.states.get(key);
		if (!state || now - state.windowStartedAt >= this.windowMs) {
			state = { windowStartedAt: now, messages: 0, callbacks: 0 };
		} else {
			this.states.delete(key);
		}
		this.states.set(key, state);
		while (this.states.size > this.maximumTrackedIdentities) {
			this.states.delete(this.states.keys().next().value!);
		}

		if (kind === 'message') {
			if (state.messages >= this.maximumMessagesPerWindow) {
				return false;
			}
			state.messages++;
			return true;
		}
		if (state.callbacks >= this.maximumCallbacksPerWindow) {
			return false;
		}
		state.callbacks++;
		return true;
	}

	clear(): void {
		this.states.clear();
	}
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
