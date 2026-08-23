/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TelegramBotApiError } from '../../common/telegramTypes';
import { TelegramBotClient } from '../telegramBotClient';
import { TestTelegramFetcher } from './testTelegramFetcher';

const botToken = '123456:test-token-value';

interface MockResponse {
	readonly status: number;
	readonly body: string;
	readonly delayMs?: number;
}

interface RecordedRequest {
	readonly method: string;
	readonly body: Record<string, unknown>;
}

describe('TelegramBotClient', () => {
	let server: Server;
	let origin: string;
	let responses: MockResponse[];
	let requests: RecordedRequest[];

	beforeAll(async () => {
		server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(Buffer.from(chunk)));
			request.on('end', () => {
				const bodyText = Buffer.concat(chunks).toString('utf8');
				const method = request.url?.split('/').pop() ?? '';
				requests.push({ method, body: bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {} });
				const next = responses.shift() ?? { status: 500, body: JSON.stringify({ ok: false, description: 'No mock response.' }) };
				setTimeout(() => {
					response.writeHead(next.status, { 'content-type': 'application/json' });
					response.end(next.body);
				}, next.delayMs ?? 0);
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address() as AddressInfo;
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});

	beforeEach(() => {
		responses = [];
		requests = [];
	});

	it('rejects malformed bot tokens before making a request', () => {
		for (const malformedToken of ['', 'not-a-token', '123:bad/token', '123:bad token']) {
			expect(() => new TelegramBotClient(malformedToken, origin, new TestTelegramFetcher())).toThrow(TelegramBotApiError);
		}
		expect(requests).toEqual([]);
	});

	it('does not expose the token when the client is serialized for diagnostics', () => {
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());
		expect(JSON.stringify(client)).not.toContain(botToken);
	});

	it('validates getMe and handles an empty short poll', async () => {
		responses.push(
			ok({ id: 42, is_bot: true, first_name: 'Remote Bot', username: 'remote_bot' }),
			ok([]),
		);
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());

		const bot = await client.getMe();
		const updates = await client.getUpdates({ timeoutSeconds: 0, allowedUpdates: ['message', 'callback_query'] });

		expect({ bot, updates, requests }).toEqual({
			bot: { id: 42, is_bot: true, first_name: 'Remote Bot', username: 'remote_bot', language_code: undefined },
			updates: [],
			requests: [
				{ method: 'getMe', body: {} },
				{ method: 'getUpdates', body: { timeout: 0, allowed_updates: ['message', 'callback_query'] } },
			],
		});
	});

	it('validates updates and implements the outbound Bot API subset', async () => {
		const message = telegramMessage('hello');
		const callbackQuery = {
			id: 'callback-1',
			from: { id: 100, is_bot: false, first_name: 'Tester' },
			message,
			data: 'approve:request-1',
		};
		const replyMarkup = { inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:request-1' }]] } as const;
		responses.push(
			ok([{ update_id: 11, message }, { update_id: 12, callback_query: callbackQuery }]),
			ok(message),
			ok(true),
			ok(true),
			ok(true),
		);
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());

		const updates = await client.getUpdates({ offset: 11, limit: 10, timeoutSeconds: 0 });
		const sent = await client.sendMessage(99, 'hello', { replyMarkup, disableNotification: true, parseMode: 'MarkdownV2' });
		const edited = await client.editMessageText(99, 7, 'edited', { replyMarkup, parseMode: 'MarkdownV2' });
		const markup = await client.editMessageReplyMarkup(99, 7);
		const answered = await client.answerCallbackQuery('callback-1', { text: 'Done' });

		expect({ updates, sent, edited, markup, answered, requests }).toEqual({
			updates: [
				{ update_id: 11, message: { ...message, from: undefined }, callback_query: undefined },
				{
					update_id: 12,
					message: undefined,
					callback_query: {
						...callbackQuery,
						from: { ...callbackQuery.from, username: undefined, language_code: undefined },
						message: { ...message, from: undefined },
						inline_message_id: undefined,
					},
				},
			],
			sent: { ...message, from: undefined },
			edited: true,
			markup: true,
			answered: true,
			requests: [
				{ method: 'getUpdates', body: { offset: 11, limit: 10, timeout: 0 } },
				{ method: 'sendMessage', body: { chat_id: 99, text: 'hello', reply_markup: replyMarkup, disable_notification: true, parse_mode: 'MarkdownV2' } },
				{ method: 'editMessageText', body: { chat_id: 99, message_id: 7, text: 'edited', reply_markup: replyMarkup, parse_mode: 'MarkdownV2' } },
				{ method: 'editMessageReplyMarkup', body: { chat_id: 99, message_id: 7, reply_markup: { inline_keyboard: [] } } },
				{ method: 'answerCallbackQuery', body: { callback_query_id: 'callback-1', text: 'Done' } },
			],
		});
	});

	it('accepts the empty response returned when a long poll times out', async () => {
		responses.push({ ...ok([]), delayMs: 25 });
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());

		const updates = await client.getUpdates({ timeoutSeconds: 1 });

		expect({ updates, request: requests[0] }).toEqual({
			updates: [],
			request: { method: 'getUpdates', body: { timeout: 1 } },
		});
	});

	it.each([
		{ status: 401, errorCode: 401, expectedKind: 'authentication' },
		{ status: 429, errorCode: 429, expectedKind: 'rate-limit' },
		{ status: 503, errorCode: 503, expectedKind: 'server' },
	] as const)('maps HTTP $status without exposing the token', async ({ status, errorCode, expectedKind }) => {
		responses.push({
			status,
			body: JSON.stringify({ ok: false, error_code: errorCode, description: `Request rejected for ${botToken}.`, parameters: { retry_after: 3 } }),
		});
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());

		const error = await client.getMe().then(() => undefined, value => value);
		if (!(error instanceof TelegramBotApiError)) {
			throw new Error('Expected TelegramBotApiError.');
		}

		expect({ kind: error.kind, retryAfterSeconds: error.retryAfterSeconds, containsToken: error.message.includes(botToken) }).toEqual({
			kind: expectedKind,
			retryAfterSeconds: 3,
			containsToken: false,
		});
	});

	it('classifies an unchanged edit without retaining the Bot API description', async () => {
		responses.push({
			status: 400,
			body: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }),
		});
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());

		const error = await client.editMessageText(202, 1, 'unchanged').then(() => undefined, value => value);
		expect(error).toMatchObject({
			kind: 'api',
			httpStatus: 400,
			errorCode: 400,
			apiFailureReason: 'message-not-modified',
			message: 'Telegram Bot API rejected the request.',
		});
	});

	it('rejects malformed JSON and malformed update shapes', async () => {
		responses.push(
			{ status: 200, body: '{not-json' },
			ok([{ update_id: 'wrong' }]),
			ok([{ update_id: 13, message: telegramMessage('message'), callback_query: { id: 'callback-13', from: { id: 100, is_bot: false, first_name: 'Tester' }, message: telegramMessage('callback'), data: 'opaque' } }]),
		);
		const client = new TelegramBotClient(botToken, origin, new TestTelegramFetcher());

		await expect(client.getMe()).rejects.toMatchObject({ kind: 'invalid-response' });
		await expect(client.getUpdates({ timeoutSeconds: 0 })).rejects.toMatchObject({ kind: 'invalid-response' });
		await expect(client.getUpdates({ timeoutSeconds: 0 })).rejects.toMatchObject({ kind: 'invalid-response' });
	});

	it('aborts an in-flight long poll', async () => {
		responses.push({ status: 200, body: JSON.stringify({ ok: true, result: [] }), delayMs: 100 });
		const fetcher = new TestTelegramFetcher();
		const client = new TelegramBotClient(botToken, origin, fetcher);
		const controller = fetcher.makeAbortController();

		const polling = client.getUpdates({ timeoutSeconds: 0, signal: controller.signal });
		controller.abort();

		await expect(polling).rejects.toMatchObject({ kind: 'aborted' });
	});
});

function ok(result: unknown): MockResponse {
	return { status: 200, body: JSON.stringify({ ok: true, result }) };
}

function telegramMessage(text: string): Record<string, unknown> {
	return {
		message_id: 7,
		date: 1_700_000_000,
		chat: { id: 99, type: 'private', first_name: 'Tester' },
		text,
	};
}
