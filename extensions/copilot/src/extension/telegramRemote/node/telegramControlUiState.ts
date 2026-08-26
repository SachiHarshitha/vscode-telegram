/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import type { TelegramPairedIdentity } from './telegramAuthorization';

const controlUiStateKey = 'vscode-telegram.telegram-remote.control-ui.v1';
const maximumStoredPreferences = 8;

interface StoredControlPreference {
	readonly pairingId: string;
	readonly userId: number;
	readonly chatId: number;
	readonly enabledAt: number;
}

interface StoredControlPreferences {
	readonly version: 1;
	readonly preferences: readonly StoredControlPreference[];
}

/** Persists reply-keyboard opt-in for the exact paired numeric identity/chat. */
export class TelegramControlUiState {
	private preferences: Map<string, StoredControlPreference>;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		this.preferences = parseStoredPreferences(extensionContext.globalState.get<unknown>(controlUiStateKey));
	}

	isEnabled(identity: TelegramPairedIdentity): boolean {
		const preference = this.preferences.get(identity.pairingId);
		return !!preference && matchesIdentity(preference, identity);
	}

	async setEnabled(identity: TelegramPairedIdentity, enabled: boolean): Promise<void> {
		const next = new Map(this.preferences);
		if (enabled) {
			next.set(identity.pairingId, {
				pairingId: identity.pairingId,
				userId: identity.userId,
				chatId: identity.chatId,
				enabledAt: Date.now(),
			});
			while (next.size > maximumStoredPreferences) {
				next.delete(next.keys().next().value!);
			}
		} else {
			next.delete(identity.pairingId);
		}
		await this.persist(next);
	}

	async clearIdentity(identity: TelegramPairedIdentity): Promise<void> {
		if (!this.preferences.has(identity.pairingId)) {
			return;
		}
		const next = new Map(this.preferences);
		next.delete(identity.pairingId);
		await this.persist(next);
	}

	private async persist(next: Map<string, StoredControlPreference>): Promise<void> {
		const stored: StoredControlPreferences = { version: 1, preferences: [...next.values()] };
		await this.extensionContext.globalState.update(controlUiStateKey, stored);
		this.preferences = next;
	}
}

function parseStoredPreferences(value: unknown): Map<string, StoredControlPreference> {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.preferences)) {
		return new Map();
	}
	const preferences = value.preferences
		.filter(isStoredPreference)
		.slice(-maximumStoredPreferences)
		.map(preference => [preference.pairingId, preference] as const);
	return new Map(preferences);
}

function isStoredPreference(value: unknown): value is StoredControlPreference {
	return isRecord(value)
		&& typeof value.pairingId === 'string' && value.pairingId.length > 0 && value.pairingId.length <= 128
		&& typeof value.userId === 'number' && Number.isSafeInteger(value.userId) && value.userId > 0
		&& typeof value.chatId === 'number' && Number.isSafeInteger(value.chatId) && value.chatId > 0
		&& typeof value.enabledAt === 'number' && Number.isSafeInteger(value.enabledAt) && value.enabledAt > 0;
}

function matchesIdentity(preference: StoredControlPreference, identity: TelegramPairedIdentity): boolean {
	return preference.pairingId === identity.pairingId && preference.userId === identity.userId && preference.chatId === identity.chatId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
