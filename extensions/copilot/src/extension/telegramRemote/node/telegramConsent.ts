/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';

export const TELEGRAM_CONSENT_VERSION = 1;
const consentStateKey = 'vscode-telegram.telegram-remote.consent.v1';

interface StoredTelegramConsent {
	readonly version: typeof TELEGRAM_CONSENT_VERSION;
	readonly state: 'pending' | 'active';
	readonly tokenFingerprint: string;
	readonly scopeFingerprint: string;
	readonly acceptedAt: number;
}

export class TelegramConsentStateError extends Error {
	constructor(operation: 'write' | 'delete') {
		super(`Telegram consent state ${operation} failed.`);
		this.name = 'TelegramConsentStateError';
	}
}

/** Owns versioned, token-bound and workspace-bound acknowledgement state. */
export class TelegramConsent {
	private storedConsent: StoredTelegramConsent | undefined;

	constructor(private readonly extensionContext: IVSCodeExtensionContext) {
		this.storedConsent = parseStoredConsent(extensionContext.globalState.get<unknown>(consentStateKey));
	}

	get hasPendingConsent(): boolean {
		return this.storedConsent?.state === 'pending';
	}

	hasCurrentConsent(tokenFingerprint: string, scopeFingerprint: string): boolean {
		return this.storedConsent?.state === 'active'
			&& this.storedConsent.tokenFingerprint === tokenFingerprint
			&& this.storedConsent.scopeFingerprint === scopeFingerprint;
	}

	async begin(tokenFingerprint: string, scopeFingerprint: string): Promise<void> {
		validateFingerprint(tokenFingerprint);
		validateFingerprint(scopeFingerprint);
		const consent: StoredTelegramConsent = {
			version: TELEGRAM_CONSENT_VERSION,
			state: 'pending',
			tokenFingerprint,
			scopeFingerprint,
			acceptedAt: Date.now(),
		};
		await this.store(consent);
	}

	async commit(tokenFingerprint: string): Promise<void> {
		validateFingerprint(tokenFingerprint);
		const consent = this.storedConsent;
		if (!consent || consent.tokenFingerprint !== tokenFingerprint) {
			throw new TelegramConsentStateError('write');
		}
		if (consent.state === 'active') {
			return;
		}
		await this.store({ ...consent, state: 'active' });
	}

	async revoke(): Promise<void> {
		this.storedConsent = undefined;
		try {
			await this.extensionContext.globalState.update(consentStateKey, undefined);
		} catch {
			throw new TelegramConsentStateError('delete');
		}
	}

	private async store(consent: StoredTelegramConsent): Promise<void> {
		try {
			await this.extensionContext.globalState.update(consentStateKey, consent);
		} catch {
			throw new TelegramConsentStateError('write');
		}
		this.storedConsent = consent;
	}
}

/** Returns a non-reversible identifier for the exact machine/workspace consent scope. */
export function getTelegramConsentScopeFingerprint(machineId: string, workspaceIdentifiers: readonly string[]): string {
	const normalizedWorkspace = [...workspaceIdentifiers].map(identifier => identifier.trim()).filter(Boolean).sort();
	return createHash('sha256')
		.update(JSON.stringify({ machineId, workspace: normalizedWorkspace.length > 0 ? normalizedWorkspace : ['<empty-window>'] }))
		.digest('hex')
		.slice(0, 24);
}

function parseStoredConsent(value: unknown): StoredTelegramConsent | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const consent = value as Partial<StoredTelegramConsent>;
	if (consent.version !== TELEGRAM_CONSENT_VERSION || (consent.state !== 'pending' && consent.state !== 'active')
		|| typeof consent.tokenFingerprint !== 'string' || !isFingerprint(consent.tokenFingerprint)
		|| typeof consent.scopeFingerprint !== 'string' || !isFingerprint(consent.scopeFingerprint)
		|| typeof consent.acceptedAt !== 'number' || !Number.isSafeInteger(consent.acceptedAt) || consent.acceptedAt < 0) {
		return undefined;
	}
	return consent as StoredTelegramConsent;
}

function validateFingerprint(value: string): void {
	if (!isFingerprint(value)) {
		throw new TelegramConsentStateError('write');
	}
}

function isFingerprint(value: string): boolean {
	return /^[a-f0-9]{24}$/.test(value);
}
