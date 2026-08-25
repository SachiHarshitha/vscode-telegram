/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IRemoteControlRegistry } from '../common/remoteControlTypes';
import type { TelegramModelSource } from '../common/telegramLanguageModelBridgeTypes';
import { TelegramPairedIdentity } from './telegramAuthorization';

const selectedSessionStateKey = 'vscode-telegram.telegram-remote.selected-sessions.v2';
const maximumStoredSelections = 8;
const maximumIdentifierLength = 512;
const maximumModelIdentifierLength = 1_024;
const maximumReasoningEffortLength = 128;

export interface TelegramPersistedModelPreference {
	readonly modelId: string;
	readonly modelSource: TelegramModelSource;
	readonly reasoningEffort?: string;
}

interface StoredTelegramSessionSelection {
	readonly pairingId: string;
	readonly userId: number;
	readonly chatId: number;
	readonly consentScopeFingerprint: string;
	readonly sessionId: string;
	readonly sessionScopeFingerprint: string;
	readonly selectedAt: number;
	readonly modelPreference?: TelegramPersistedModelPreference;
}

interface StoredTelegramSessionSelections {
	readonly version: 2 | 3;
	readonly selections: readonly StoredTelegramSessionSelection[];
}

export class TelegramSessionStateError extends Error {
	constructor() {
		super('Telegram selected-session state could not be updated.');
		this.name = 'TelegramSessionStateError';
	}
}

/** Owns durable, paired-identity-bound Telegram selection and its logical registry attachment. */
export class TelegramSessionState extends Disposable {
	private selections: Map<string, StoredTelegramSessionSelection>;
	private readonly attachments = new Map<string, IDisposable>();

	constructor(
		private readonly consentScopeFingerprint: string,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IRemoteControlRegistry private readonly registry: IRemoteControlRegistry,
	) {
		super();
		this.selections = parseStoredSelections(extensionContext.globalState.get<unknown>(selectedSessionStateKey));
	}

	getSelectedSessionId(identity: TelegramPairedIdentity): string | undefined {
		const selection = this.selections.get(identity.pairingId);
		return selection && this.matchesIdentityAndScope(selection, identity) ? selection.sessionId : undefined;
	}

	getSelectedSessionScopeFingerprint(identity: TelegramPairedIdentity): string | undefined {
		const selection = this.selections.get(identity.pairingId);
		return selection && this.matchesIdentityAndScope(selection, identity) ? selection.sessionScopeFingerprint : undefined;
	}

	getSelectedModelPreference(identity: TelegramPairedIdentity, sessionId: string): TelegramPersistedModelPreference | undefined {
		const selection = this.selections.get(identity.pairingId);
		if (!selection || !this.matchesIdentityAndScope(selection, identity) || selection.sessionId !== sessionId) {
			return undefined;
		}
		return selection.modelPreference;
	}

	async setSelectedModelPreference(identity: TelegramPairedIdentity, sessionId: string, preference: TelegramPersistedModelPreference): Promise<void> {
		const selection = this.selections.get(identity.pairingId);
		if (!selection || !this.matchesIdentityAndScope(selection, identity) || selection.sessionId !== sessionId || !isStoredModelPreference(preference)) {
			throw new TelegramSessionStateError();
		}
		const next = new Map(this.selections);
		next.set(identity.pairingId, { ...selection, modelPreference: preference });
		await this.replaceSelections(next);
	}

	async clearSelectedModelPreference(identity: TelegramPairedIdentity, sessionId: string): Promise<boolean> {
		const selection = this.selections.get(identity.pairingId);
		if (!selection || !this.matchesIdentityAndScope(selection, identity) || selection.sessionId !== sessionId || !selection.modelPreference) {
			return false;
		}
		const next = new Map(this.selections);
		next.set(identity.pairingId, { ...selection, modelPreference: undefined });
		await this.replaceSelections(next);
		return true;
	}

	/** Restores only the current paired identity and attaches it after metadata validation succeeds. */
	async restore(identity: TelegramPairedIdentity, validateSession: (sessionId: string, sessionScopeFingerprint: string) => Promise<boolean>): Promise<string | undefined> {
		const selection = this.selections.get(identity.pairingId);
		const stalePairingIds = [...this.selections.keys()].filter(pairingId => pairingId !== identity.pairingId);
		if (!selection || !this.matchesIdentityAndScope(selection, identity)) {
			if (stalePairingIds.length > 0 || selection) {
				await this.replaceSelections(new Map());
			}
			this.suspend();
			return undefined;
		}

		if (!await validateSession(selection.sessionId, selection.sessionScopeFingerprint)) {
			await this.deselect(identity);
			return undefined;
		}

		if (stalePairingIds.length > 0) {
			await this.replaceSelections(new Map([[identity.pairingId, selection]]));
		}
		this.attach(identity.pairingId, selection.sessionId);
		return selection.sessionId;
	}

	async select(identity: TelegramPairedIdentity, sessionId: string, sessionScopeFingerprint: string): Promise<void> {
		validateIdentityAndSession(identity, sessionId, sessionScopeFingerprint);
		const next = new Map(this.selections);
		const previous = next.get(identity.pairingId);
		const modelPreference = previous && this.matchesIdentityAndScope(previous, identity)
			&& previous.sessionId === sessionId && previous.sessionScopeFingerprint === sessionScopeFingerprint
			? previous.modelPreference
			: undefined;
		next.set(identity.pairingId, {
			pairingId: identity.pairingId,
			userId: identity.userId,
			chatId: identity.chatId,
			consentScopeFingerprint: this.consentScopeFingerprint,
			sessionId,
			sessionScopeFingerprint,
			selectedAt: Date.now(),
			modelPreference,
		});
		for (const pairingId of next.keys()) {
			if (pairingId !== identity.pairingId) {
				next.delete(pairingId);
			}
		}
		await this.replaceSelections(next);
		this.attach(identity.pairingId, sessionId);
	}

	async deselect(identity: TelegramPairedIdentity): Promise<boolean> {
		const selection = this.selections.get(identity.pairingId);
		if (!selection || !this.matchesIdentityAndScope(selection, identity)) {
			return false;
		}
		const next = new Map(this.selections);
		next.delete(identity.pairingId);
		await this.replaceSelections(next);
		this.detach(identity.pairingId);
		return true;
	}

	async clearIdentity(identity: TelegramPairedIdentity): Promise<void> {
		const next = new Map(this.selections);
		next.delete(identity.pairingId);
		await this.replaceSelections(next);
		this.detach(identity.pairingId);
	}

	async clearSession(sessionId: string): Promise<boolean> {
		const next = new Map(this.selections);
		const removedPairingIds: string[] = [];
		for (const [pairingId, selection] of next) {
			if (selection.sessionId === sessionId) {
				next.delete(pairingId);
				removedPairingIds.push(pairingId);
			}
		}
		if (removedPairingIds.length === 0) {
			return false;
		}
		await this.replaceSelections(next);
		for (const pairingId of removedPairingIds) {
			this.detach(pairingId);
		}
		return true;
	}

	/** Hides runtime controls while optionally retaining terminal-event delivery for one local turn. */
	suspend(preserveEventDelivery = false): void {
		if (preserveEventDelivery && this.attachments.size > 0) {
			this.registry.suspendTransport('telegram');
			return;
		}
		for (const attachment of this.attachments.values()) {
			attachment.dispose();
		}
		this.attachments.clear();
	}

	finishSuspendedDelivery(): void {
		this.suspend(false);
	}

	private attach(pairingId: string, sessionId: string): void {
		this.detach(pairingId);
		this.attachments.set(pairingId, this.registry.attachTransport(sessionId, 'telegram'));
	}

	private detach(pairingId: string): void {
		this.attachments.get(pairingId)?.dispose();
		this.attachments.delete(pairingId);
	}

	private async replaceSelections(next: Map<string, StoredTelegramSessionSelection>): Promise<void> {
		const value: StoredTelegramSessionSelections | undefined = next.size === 0
			? undefined
			: { version: 3, selections: [...next.values()] };
		try {
			await this.extensionContext.globalState.update(selectedSessionStateKey, value);
		} catch {
			throw new TelegramSessionStateError();
		}
		this.selections = next;
	}

	private matchesIdentityAndScope(selection: StoredTelegramSessionSelection, identity: TelegramPairedIdentity): boolean {
		return matchesIdentity(selection, identity) && selection.consentScopeFingerprint === this.consentScopeFingerprint;
	}

	public override dispose(): void {
		this.suspend();
		super.dispose();
	}
}

function parseStoredSelections(value: unknown): Map<string, StoredTelegramSessionSelection> {
	const result = new Map<string, StoredTelegramSessionSelection>();
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return result;
	}
	const record = value as Partial<StoredTelegramSessionSelections>;
	if ((record.version !== 2 && record.version !== 3) || !Array.isArray(record.selections) || record.selections.length > maximumStoredSelections) {
		return result;
	}
	for (const selection of record.selections) {
		if (!isStoredSelection(selection) || result.has(selection.pairingId)) {
			return new Map();
		}
		result.set(selection.pairingId, selection);
	}
	return result;
}

function isStoredSelection(value: unknown): value is StoredTelegramSessionSelection {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const record = value as Partial<StoredTelegramSessionSelection>;
	return isBoundedString(record.pairingId) && isPositiveSafeInteger(record.userId) && isPositiveSafeInteger(record.chatId)
		&& isConsentScopeFingerprint(record.consentScopeFingerprint)
		&& isBoundedString(record.sessionId) && isConsentScopeFingerprint(record.sessionScopeFingerprint) && typeof record.selectedAt === 'number'
		&& Number.isSafeInteger(record.selectedAt) && record.selectedAt >= 0
		&& (record.modelPreference === undefined || isStoredModelPreference(record.modelPreference));
}

function isStoredModelPreference(value: unknown): value is TelegramPersistedModelPreference {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const record = value as Partial<TelegramPersistedModelPreference>;
	return typeof record.modelId === 'string' && record.modelId.length > 0 && record.modelId.length <= maximumModelIdentifierLength
		&& (record.modelSource === 'copilotcli' || record.modelSource === 'vscode-lm')
		&& (record.reasoningEffort === undefined || (typeof record.reasoningEffort === 'string' && record.reasoningEffort.length > 0 && record.reasoningEffort.length <= maximumReasoningEffortLength));
}

function matchesIdentity(selection: StoredTelegramSessionSelection, identity: TelegramPairedIdentity): boolean {
	return selection.pairingId === identity.pairingId && selection.userId === identity.userId && selection.chatId === identity.chatId;
}

function validateIdentityAndSession(identity: TelegramPairedIdentity, sessionId: string, sessionScopeFingerprint: string): void {
	if (!isBoundedString(identity.pairingId) || !isPositiveSafeInteger(identity.userId) || !isPositiveSafeInteger(identity.chatId)
		|| !isBoundedString(sessionId) || !isConsentScopeFingerprint(sessionScopeFingerprint)) {
		throw new TelegramSessionStateError();
	}
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBoundedString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumIdentifierLength;
}

function isConsentScopeFingerprint(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
}
