/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { TelegramAuthorization, TelegramSecurityStateError, getTelegramPrivateChatIdentity } from '../telegramAuthorization';
import { getTelegramBotTokenFingerprint } from '../telegramPollerLease';
import { TestMemento, TestSecretStorage, TestTelegramExtensionContext, telegramCallbackUpdate, telegramMessageUpdate } from './testTelegramSecurityState';

const botToken = '123456:phase3-secure-token';
const replacementToken = '654321:replacement-token';

describe('TelegramAuthorization', () => {
	it('stores the bot token only in SecretStorage and reloads non-secret pairing metadata', async () => {
		const globalState = new TestMemento();
		const secrets = new TestSecretStorage();
		const context = new TestTelegramExtensionContext('/tmp/telegram-auth', globalState, secrets);
		const authorization = new TelegramAuthorization(context, () => 'pairing-id');

		const tokenFingerprint = await authorization.storeBotToken(botToken);
		await authorization.pair(getTelegramPrivateChatIdentity(telegramMessageUpdate(1, '/pair challenge'))!, tokenFingerprint);
		const serializedGlobalState = JSON.stringify([...globalState.values]);

		expect(await authorization.getBotToken()).toBe(botToken);
		expect(serializedGlobalState).not.toContain(botToken);
		expect(serializedGlobalState).toContain(tokenFingerprint);
		expect(new TelegramAuthorization(new TestTelegramExtensionContext('/tmp/telegram-auth', globalState, secrets)).pairedIdentity).toEqual(expect.objectContaining({
			pairingId: 'pairing-id',
			userId: 101,
			chatId: 202,
		}));
	});

	it('authorizes immutable numeric user and private-chat ids despite username changes', async () => {
		const authorization = new TelegramAuthorization(new TestTelegramExtensionContext('/tmp/telegram-auth'), () => 'pairing-id');
		const fingerprint = await authorization.storeBotToken(botToken);
		await authorization.pair(getTelegramPrivateChatIdentity(telegramMessageUpdate(1, undefined))!, fingerprint);

		expect(authorization.authorizeUpdate(telegramMessageUpdate(2, 'hello', 101, 202, 'private', false, 'renamed'), fingerprint)).toEqual(expect.objectContaining({ pairingId: 'pairing-id' }));
		expect(authorization.authorizeUpdate(telegramCallbackUpdate(3, 'opaque', 101, 202), fingerprint)).toEqual(expect.objectContaining({ pairingId: 'pairing-id' }));
		expect(authorization.authorizeUpdate(telegramMessageUpdate(4, 'hello', 999, 202), fingerprint)).toBeUndefined();
		expect(authorization.authorizeUpdate(telegramMessageUpdate(5, 'hello', 101, 999), fingerprint)).toBeUndefined();
		expect(authorization.authorizeUpdate(telegramMessageUpdate(6, 'hello', 101, 202, 'group'), fingerprint)).toBeUndefined();
		expect(authorization.authorizeUpdate(telegramMessageUpdate(7, 'hello', 101, 202, 'private', true), fingerprint)).toBeUndefined();
		expect(authorization.authorizeUpdate({ update_id: 8 }, fingerprint)).toBeUndefined();
		expect(authorization.authorizeUpdate(telegramMessageUpdate(9, 'hello'), getTelegramBotTokenFingerprint(replacementToken))).toBeUndefined();
		expect(authorization.authorizeUpdate({
			...telegramMessageUpdate(10, 'ambiguous'),
			callback_query: telegramCallbackUpdate(10, 'opaque', 999, 202).callback_query,
		}, fingerprint)).toBeUndefined();
	});

	it('revokes a pairing on token rotation and forget removes both secret and identity', async () => {
		const context = new TestTelegramExtensionContext('/tmp/telegram-auth');
		const authorization = new TelegramAuthorization(context, () => 'pairing-id');
		const fingerprint = await authorization.storeBotToken(botToken);
		await authorization.pair(getTelegramPrivateChatIdentity(telegramMessageUpdate(1, undefined))!, fingerprint);

		await authorization.storeBotToken(replacementToken);
		expect(authorization.pairedIdentity).toBeUndefined();
		expect(await authorization.getBotToken()).toBe(replacementToken);

		await authorization.pair(getTelegramPrivateChatIdentity(telegramMessageUpdate(2, undefined))!, getTelegramBotTokenFingerprint(replacementToken));
		await authorization.forgetBotToken();
		expect(await authorization.getBotToken()).toBeUndefined();
		expect(authorization.pairedIdentity).toBeUndefined();
		expect(context.globalState.keys()).toEqual([]);
	});

	it('fails closed with redacted errors when secure storage operations fail', async () => {
		const secrets = new TestSecretStorage();
		secrets.store = vi.fn(async () => { throw new Error(`leaked ${botToken}`); });
		const authorization = new TelegramAuthorization(new TestTelegramExtensionContext('/tmp/telegram-auth', new TestMemento(), secrets));

		await expect(authorization.storeBotToken(botToken)).rejects.toEqual(expect.objectContaining<TelegramSecurityStateError>({
			name: 'TelegramSecurityStateError',
			message: 'Telegram secure state write failed.',
		}));
		await expect(authorization.storeBotToken(botToken)).rejects.not.toThrow(botToken);
	});

	it('still deletes the secret if durable pairing revocation fails', async () => {
		const context = new TestTelegramExtensionContext('/tmp/telegram-auth');
		const authorization = new TelegramAuthorization(context, () => 'pairing-id');
		const fingerprint = await authorization.storeBotToken(botToken);
		await authorization.pair(getTelegramPrivateChatIdentity(telegramMessageUpdate(1, undefined))!, fingerprint);
		context.globalState.update = vi.fn(async () => { throw new Error('global state unavailable'); });

		await expect(authorization.forgetBotToken()).rejects.toBeInstanceOf(TelegramSecurityStateError);
		expect(await authorization.getBotToken()).toBeUndefined();
		expect(authorization.pairedIdentity).toBeUndefined();
	});

	it('rejects malformed persisted identities instead of authorizing them', () => {
		const globalState = new TestMemento();
		globalState.values.set('vscode-telegram.telegram-remote.paired-identity.v1', {
			version: 1,
			tokenFingerprint: getTelegramBotTokenFingerprint(botToken),
			pairingId: '',
			userId: 101,
			chatId: 202,
			firstName: 'First',
			pairedAt: Date.now(),
		});

		expect(new TelegramAuthorization(new TestTelegramExtensionContext('/tmp/telegram-auth', globalState)).pairedIdentity).toBeUndefined();
	});
});
