/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { TelegramUpdate, validateTelegramBotToken } from '../common/telegramTypes';
import { getTelegramBotTokenFingerprint } from './telegramPollerLease';

const botTokenSecretKey = 'vscode-telegram.telegram-remote.bot-token.v1';
const pairedIdentityStateKey = 'vscode-telegram.telegram-remote.paired-identity.v1';
const maximumUsernameLength = 64;
const maximumNameLength = 128;

interface StoredTelegramPairedIdentity {
	readonly version: 1;
	readonly tokenFingerprint: string;
	readonly pairingId: string;
	readonly userId: number;
	readonly chatId: number;
	readonly username?: string;
	readonly firstName: string;
	readonly lastName?: string;
	readonly pairedAt: number;
}

export interface TelegramPrivateChatIdentity {
	readonly userId: number;
	readonly chatId: number;
	readonly username?: string;
	readonly firstName: string;
	readonly lastName?: string;
}

export interface TelegramPairedIdentity extends TelegramPrivateChatIdentity {
	readonly pairingId: string;
	readonly pairedAt: number;
}

export class TelegramSecurityStateError extends Error {
	constructor(operation: 'read' | 'write' | 'delete') {
		super(`Telegram secure state ${operation} failed.`);
		this.name = 'TelegramSecurityStateError';
	}
}

/** Owns the secret bot token and the non-secret, token-bound Telegram identity allowlist. */
export class TelegramAuthorization extends Disposable {
	private readonly pairedIdentityEmitter = this._register(new Emitter<TelegramPairedIdentity | undefined>());
	readonly onDidChangePairedIdentity: Event<TelegramPairedIdentity | undefined> = this.pairedIdentityEmitter.event;

	private storedIdentity: StoredTelegramPairedIdentity | undefined;

	constructor(
		private readonly extensionContext: IVSCodeExtensionContext,
		private readonly createPairingId: () => string = randomUUID,
	) {
		super();
		this.storedIdentity = parseStoredIdentity(extensionContext.globalState.get<unknown>(pairedIdentityStateKey));
	}

	get pairedIdentity(): TelegramPairedIdentity | undefined {
		return this.storedIdentity ? toPublicIdentity(this.storedIdentity) : undefined;
	}

	hasPairedIdentityForToken(tokenFingerprint: string): boolean {
		return this.storedIdentity?.tokenFingerprint === tokenFingerprint;
	}

	async getBotToken(): Promise<string | undefined> {
		let value: string | undefined;
		try {
			value = await this.extensionContext.secrets.get(botTokenSecretKey);
		} catch {
			throw new TelegramSecurityStateError('read');
		}
		if (!value) {
			return undefined;
		}
		try {
			validateTelegramBotToken(value);
			return value;
		} catch {
			return undefined;
		}
	}

	async storeBotToken(botToken: string): Promise<string> {
		validateTelegramBotToken(botToken);
		const tokenFingerprint = getTelegramBotTokenFingerprint(botToken);
		try {
			await this.extensionContext.secrets.store(botTokenSecretKey, botToken);
		} catch {
			throw new TelegramSecurityStateError('write');
		}
		if (this.storedIdentity && this.storedIdentity.tokenFingerprint !== tokenFingerprint) {
			await this.revokePairing();
		}
		return tokenFingerprint;
	}

	async pair(identity: TelegramPrivateChatIdentity, tokenFingerprint: string): Promise<TelegramPairedIdentity> {
		validatePrivateIdentity(identity);
		validateTokenFingerprint(tokenFingerprint);
		const storedIdentity: StoredTelegramPairedIdentity = {
			version: 1,
			tokenFingerprint,
			pairingId: this.createPairingId(),
			userId: identity.userId,
			chatId: identity.chatId,
			username: truncateOptional(identity.username, maximumUsernameLength),
			firstName: truncateRequired(identity.firstName, maximumNameLength),
			lastName: truncateOptional(identity.lastName, maximumNameLength),
			pairedAt: Date.now(),
		};
		try {
			await this.extensionContext.globalState.update(pairedIdentityStateKey, storedIdentity);
		} catch {
			throw new TelegramSecurityStateError('write');
		}
		this.storedIdentity = storedIdentity;
		const pairedIdentity = toPublicIdentity(storedIdentity);
		this.pairedIdentityEmitter.fire(pairedIdentity);
		return pairedIdentity;
	}

	authorizeUpdate(update: TelegramUpdate, tokenFingerprint: string): TelegramPairedIdentity | undefined {
		const storedIdentity = this.storedIdentity;
		if (!storedIdentity || storedIdentity.tokenFingerprint !== tokenFingerprint) {
			return undefined;
		}
		const stopped = update.stopped_message_generation;
		if (stopped) {
			return stopped.chat.type === 'private' && stopped.chat.id === storedIdentity.chatId ? toPublicIdentity(storedIdentity) : undefined;
		}
		const incomingIdentity = getTelegramPrivateChatIdentity(update);
		if (!incomingIdentity) {
			return undefined;
		}
		return incomingIdentity.userId === storedIdentity.userId && incomingIdentity.chatId === storedIdentity.chatId
			? toPublicIdentity(storedIdentity)
			: undefined;
	}

	async revokePairing(): Promise<void> {
		const hadIdentity = this.storedIdentity !== undefined;
		this.storedIdentity = undefined;
		if (hadIdentity) {
			this.pairedIdentityEmitter.fire(undefined);
		}
		try {
			await this.extensionContext.globalState.update(pairedIdentityStateKey, undefined);
		} catch {
			throw new TelegramSecurityStateError('delete');
		}
	}

	async forgetBotToken(): Promise<void> {
		let revokeError: unknown;
		try {
			await this.revokePairing();
		} catch (error) {
			revokeError = error;
		}
		try {
			await this.extensionContext.secrets.delete(botTokenSecretKey);
		} catch {
			throw new TelegramSecurityStateError('delete');
		}
		if (revokeError) {
			throw new TelegramSecurityStateError('delete');
		}
	}

	/** Deletes only the token and identity staged by an initial setup that never completed. */
	async discardStagedConfiguration(expectedTokenFingerprint: string): Promise<void> {
		validateTokenFingerprint(expectedTokenFingerprint);
		const botToken = await this.getBotToken();
		if (!botToken || getTelegramBotTokenFingerprint(botToken) !== expectedTokenFingerprint) {
			return;
		}
		let revokeError: unknown;
		try {
			await this.revokePairing();
		} catch (error) {
			revokeError = error;
		}
		try {
			await this.extensionContext.secrets.delete(botTokenSecretKey);
		} catch {
			throw new TelegramSecurityStateError('delete');
		}
		if (revokeError) {
			throw new TelegramSecurityStateError('delete');
		}
	}
}

/** Extracts an eligible non-bot identity only from a private message or private callback message. */
export function getTelegramPrivateChatIdentity(update: TelegramUpdate): TelegramPrivateChatIdentity | undefined {
	if (update.message && update.callback_query) {
		return undefined;
	}
	const user = update.message?.from ?? update.callback_query?.from;
	const chat = update.message?.chat ?? update.callback_query?.message?.chat;
	if (!user || user.is_bot || !Number.isSafeInteger(user.id) || user.id <= 0 || !chat || chat.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0) {
		return undefined;
	}
	return {
		userId: user.id,
		chatId: chat.id,
		username: user.username,
		firstName: user.first_name,
		lastName: user.last_name,
	};
}

function parseStoredIdentity(value: unknown): StoredTelegramPairedIdentity | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Partial<StoredTelegramPairedIdentity>;
	if (record.version !== 1 || typeof record.tokenFingerprint !== 'string' || !isTokenFingerprint(record.tokenFingerprint)
		|| !isBoundedRequiredString(record.pairingId, 128) || !isPositiveSafeInteger(record.userId)
		|| !isPositiveSafeInteger(record.chatId) || !isBoundedRequiredString(record.firstName, maximumNameLength)
		|| typeof record.pairedAt !== 'number' || !Number.isSafeInteger(record.pairedAt) || record.pairedAt < 0
		|| !isBoundedOptionalString(record.username, maximumUsernameLength) || !isBoundedOptionalString(record.lastName, maximumNameLength)) {
		return undefined;
	}
	return record as StoredTelegramPairedIdentity;
}

function toPublicIdentity(identity: StoredTelegramPairedIdentity): TelegramPairedIdentity {
	return {
		pairingId: identity.pairingId,
		userId: identity.userId,
		chatId: identity.chatId,
		username: identity.username,
		firstName: identity.firstName,
		lastName: identity.lastName,
		pairedAt: identity.pairedAt,
	};
}

function validatePrivateIdentity(identity: TelegramPrivateChatIdentity): void {
	if (!isPositiveSafeInteger(identity.userId) || !isPositiveSafeInteger(identity.chatId) || !identity.firstName) {
		throw new TelegramSecurityStateError('write');
	}
}

function validateTokenFingerprint(value: string): void {
	if (!isTokenFingerprint(value)) {
		throw new TelegramSecurityStateError('write');
	}
}

function isTokenFingerprint(value: string): boolean {
	return /^[a-f0-9]{24}$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBoundedRequiredString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isBoundedOptionalString(value: unknown, maximumLength: number): boolean {
	return value === undefined || (typeof value === 'string' && value.length <= maximumLength);
}

function truncateRequired(value: string, maximumLength: number): string {
	return value.slice(0, maximumLength);
}

function truncateOptional(value: string | undefined, maximumLength: number): string | undefined {
	return value?.slice(0, maximumLength);
}
