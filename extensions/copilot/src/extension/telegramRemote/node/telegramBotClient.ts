/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import {
	ITelegramBotClient,
	TelegramAnswerCallbackQueryOptions,
	TelegramBotApiError,
	TelegramChatId,
	TelegramEditMessageTextOptions,
	TelegramGetUpdatesOptions,
	TelegramMessage,
	TelegramSendMessageOptions,
	TelegramUpdate,
	TelegramUser,
	parseTelegramMessage,
	parseTelegramMessageOrTrue,
	parseTelegramUpdate,
	parseTelegramUser,
	validateTelegramBotToken,
} from '../common/telegramTypes';

const telegramBotApiOrigin = 'https://api.telegram.org';
const defaultLongPollTimeoutSeconds = 25;
const maximumMessageLength = 4096;

interface TelegramApiEnvelope {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error_code?: number;
	readonly description?: string;
	readonly parameters?: { readonly retry_after?: number };
}

/** Strict, dependency-free client for the Bot API subset used by Telegram Remote. */
export class TelegramBotClient implements ITelegramBotClient {
	readonly #apiBaseUrl: string;

	constructor(
		botToken: string,
		apiOrigin: string | undefined,
		@IFetcherService private readonly fetcherService: IFetcherService,
	) {
		validateTelegramBotToken(botToken);
		this.#apiBaseUrl = `${apiOrigin ?? telegramBotApiOrigin}/bot${botToken}`;
	}

	async getMe(signal?: TelegramGetUpdatesOptions['signal']): Promise<TelegramUser> {
		return this.call('getMe', {}, value => parseTelegramUser(value, true), signal);
	}

	async getUpdates(options: TelegramGetUpdatesOptions = {}): Promise<readonly TelegramUpdate[]> {
		const timeoutSeconds = options.timeoutSeconds ?? defaultLongPollTimeoutSeconds;
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) {
			throw new TelegramBotApiError('api', 'Telegram getUpdates timeout must be between 0 and 50 seconds.');
		}
		if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
			throw new TelegramBotApiError('api', 'Telegram getUpdates limit must be between 1 and 100.');
		}
		if (options.offset !== undefined && !Number.isSafeInteger(options.offset)) {
			throw new TelegramBotApiError('api', 'Telegram getUpdates offset must be a safe integer.');
		}

		return this.call('getUpdates', {
			offset: options.offset,
			limit: options.limit,
			timeout: timeoutSeconds,
			allowed_updates: options.allowedUpdates,
		}, value => {
			if (!Array.isArray(value)) {
				throw new TelegramBotApiError('invalid-response', 'Telegram getUpdates returned an invalid result.');
			}
			return value.map(parseTelegramUpdate);
		}, options.signal, (timeoutSeconds + 10) * 1000);
	}

	async sendMessage(chatId: TelegramChatId, text: string, options: TelegramSendMessageOptions = {}): Promise<TelegramMessage> {
		validateChatId(chatId);
		validateMessageText(text);
		return this.call('sendMessage', {
			chat_id: chatId,
			text,
			reply_markup: options.replyMarkup,
			disable_notification: options.disableNotification,
			parse_mode: options.parseMode,
		}, parseTelegramMessage);
	}

	async editMessageText(chatId: TelegramChatId, messageId: number, text: string, options: TelegramEditMessageTextOptions = {}): Promise<TelegramMessage | true> {
		validateChatId(chatId);
		validateMessageId(messageId);
		validateMessageText(text);
		return this.call('editMessageText', {
			chat_id: chatId,
			message_id: messageId,
			text,
			reply_markup: options.replyMarkup,
			parse_mode: options.parseMode,
		}, parseTelegramMessageOrTrue);
	}

	async editMessageReplyMarkup(chatId: TelegramChatId, messageId: number, replyMarkup?: TelegramSendMessageOptions['replyMarkup']): Promise<TelegramMessage | true> {
		validateChatId(chatId);
		validateMessageId(messageId);
		return this.call('editMessageReplyMarkup', {
			chat_id: chatId,
			message_id: messageId,
			reply_markup: replyMarkup ?? { inline_keyboard: [] },
		}, parseTelegramMessageOrTrue);
	}

	async answerCallbackQuery(callbackQueryId: string, options: TelegramAnswerCallbackQueryOptions = {}): Promise<true> {
		if (!callbackQueryId) {
			throw new TelegramBotApiError('api', 'Telegram callback query id is required.');
		}
		return this.call('answerCallbackQuery', {
			callback_query_id: callbackQueryId,
			text: options.text,
			show_alert: options.showAlert,
			cache_time: options.cacheTime,
		}, value => {
			if (value !== true) {
				throw new TelegramBotApiError('invalid-response', 'Telegram answerCallbackQuery returned an invalid result.');
			}
			return true;
		});
	}

	private async call<T>(
		method: string,
		body: Readonly<Record<string, unknown>>,
		parseResult: (value: unknown) => T,
		signal?: TelegramGetUpdatesOptions['signal'],
		timeout = 30_000,
	): Promise<T> {
		let response: Response;
		try {
			response = await this.fetcherService.fetch(`${this.#apiBaseUrl}/${method}`, {
				method: 'POST',
				json: withoutUndefinedValues(body),
				signal,
				timeout,
				expectJSON: true,
				callSite: `telegram-remote-${method}`,
			});
		} catch (error) {
			if (signal?.aborted || this.fetcherService.isAbortError(error)) {
				throw new TelegramBotApiError('aborted', 'Telegram Bot API request was cancelled.');
			}
			throw new TelegramBotApiError('network', 'Telegram Bot API network request failed.');
		}

		let envelope: TelegramApiEnvelope;
		try {
			envelope = parseEnvelope(JSON.parse(await response.text()));
		} catch (error) {
			if (error instanceof TelegramBotApiError) {
				throw error;
			}
			throw new TelegramBotApiError('invalid-response', 'Telegram Bot API returned malformed JSON.', response.status);
		}

		if (!response.ok || !envelope.ok) {
			throw toApiError(response.status, envelope);
		}
		return parseResult(envelope.result);
	}
}

function parseEnvelope(value: unknown): TelegramApiEnvelope {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TelegramBotApiError('invalid-response', 'Telegram Bot API returned an invalid envelope.');
	}
	const record = value as Record<string, unknown>;
	if (typeof record.ok !== 'boolean') {
		throw new TelegramBotApiError('invalid-response', 'Telegram Bot API response is missing its ok flag.');
	}
	const parameters = record.parameters && typeof record.parameters === 'object' && !Array.isArray(record.parameters)
		? record.parameters as Record<string, unknown>
		: undefined;
	return {
		ok: record.ok,
		result: record.result,
		error_code: typeof record.error_code === 'number' && Number.isInteger(record.error_code) ? record.error_code : undefined,
		description: typeof record.description === 'string' ? record.description : undefined,
		parameters: parameters && typeof parameters.retry_after === 'number' && Number.isSafeInteger(parameters.retry_after) && parameters.retry_after >= 0
			? { retry_after: parameters.retry_after }
			: undefined,
	};
}

function toApiError(httpStatus: number, envelope: TelegramApiEnvelope): TelegramBotApiError {
	const errorCode = envelope.error_code;
	const retryAfterSeconds = envelope.parameters?.retry_after;
	const kind = httpStatus === 401 || errorCode === 401 ? 'authentication'
		: httpStatus === 429 || errorCode === 429 ? 'rate-limit'
			: httpStatus >= 500 ? 'server'
				: 'api';
	const defaultMessage = kind === 'authentication' ? 'Telegram rejected the bot token.'
		: kind === 'rate-limit' ? 'Telegram rate limited the bot.'
			: kind === 'server' ? 'Telegram Bot API is temporarily unavailable.'
				: 'Telegram Bot API rejected the request.';
	// Bot API descriptions are remote-controlled text and may echo request data. Keep only the
	// structured status fields and a local message so credentials cannot reach errors or logs.
	return new TelegramBotApiError(kind, defaultMessage, httpStatus, errorCode, retryAfterSeconds);
}

function withoutUndefinedValues(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function validateChatId(chatId: TelegramChatId): void {
	if ((typeof chatId === 'number' && Number.isSafeInteger(chatId)) || (typeof chatId === 'string' && chatId.length > 0)) {
		return;
	}
	throw new TelegramBotApiError('api', 'Telegram chat id is invalid.');
}

function validateMessageId(messageId: number): void {
	if (!Number.isSafeInteger(messageId) || messageId <= 0) {
		throw new TelegramBotApiError('api', 'Telegram message id is invalid.');
	}
}

function validateMessageText(text: string): void {
	if (!text || text.length > maximumMessageLength) {
		throw new TelegramBotApiError('api', `Telegram message text must contain between 1 and ${maximumMessageLength} characters.`);
	}
}
