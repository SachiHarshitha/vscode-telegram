/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { TelegramChatId } from '../../common/telegramTypes';
import { TelegramBotClient } from '../telegramBotClient';
import { TestTelegramFetcher } from './testTelegramFetcher';

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const sendTestMessage = process.env.TELEGRAM_REAL_TEST_SEND_MESSAGE === 'true';
const testChatId = parseChatId(process.env.TELEGRAM_TEST_CHAT_ID);

describe.skipIf(!botToken)('TelegramBotClient real bot smoke', () => {
	it('authenticates, performs a short poll, and optionally sends a test message', async () => {
		if (sendTestMessage && testChatId === undefined) {
			throw new Error('TELEGRAM_TEST_CHAT_ID is required when TELEGRAM_REAL_TEST_SEND_MESSAGE=true.');
		}
		const client = new TelegramBotClient(botToken!, undefined, new TestTelegramFetcher());

		const bot = await client.getMe();
		const updates = await client.getUpdates({ timeoutSeconds: 0, limit: 1, allowedUpdates: ['message', 'callback_query'] });
		const sent = sendTestMessage && testChatId !== undefined
			? await client.sendMessage(testChatId, `vscode-telegram Phase 2 smoke test succeeded at ${new Date().toISOString()}`)
			: undefined;

		expect({ isBot: bot.is_bot, hasIdentity: bot.id > 0 && !!bot.first_name, updatesValid: updates.every(update => Number.isSafeInteger(update.update_id)), sent: sent ? sent.message_id > 0 : undefined }).toEqual({
			isBot: true,
			hasIdentity: true,
			updatesValid: true,
			sent: sendTestMessage && testChatId !== undefined ? true : undefined,
		});
	});
});

function parseChatId(value: string | undefined): TelegramChatId | undefined {
	if (!value?.trim()) {
		return undefined;
	}
	const numeric = Number(value);
	return Number.isSafeInteger(numeric) ? numeric : value.trim();
}
