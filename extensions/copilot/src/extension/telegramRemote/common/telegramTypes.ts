/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAbortSignal } from '../../../platform/networking/common/fetcherService';

export type TelegramChatId = number | string;

export interface TelegramUser {
	readonly id: number;
	readonly is_bot: boolean;
	readonly first_name: string;
	readonly last_name?: string;
	readonly username?: string;
	readonly language_code?: string;
}

export interface TelegramChat {
	readonly id: number;
	readonly type: 'private' | 'group' | 'supergroup' | 'channel';
	readonly username?: string;
	readonly first_name?: string;
	readonly last_name?: string;
	readonly title?: string;
}

export interface TelegramMessage {
	readonly message_id: number;
	readonly date: number;
	readonly chat: TelegramChat;
	readonly from?: TelegramUser;
	readonly text?: string;
	readonly reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
	readonly id: string;
	readonly from: TelegramUser;
	readonly message?: TelegramMessage;
	readonly inline_message_id?: string;
	readonly data?: string;
}

export interface TelegramUpdate {
	readonly update_id: number;
	readonly message?: TelegramMessage;
	readonly callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineKeyboardButton {
	readonly text: string;
	readonly callback_data?: string;
	readonly url?: string;
}

export interface TelegramInlineKeyboardMarkup {
	readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export type TelegramRichText = string | readonly TelegramRichText[] | TelegramRichTextStyle;

export interface TelegramRichTextStyle {
	readonly type: 'bold' | 'italic' | 'code';
	readonly text: TelegramRichText;
}

export type TelegramInputRichBlock =
	| { readonly type: 'paragraph'; readonly text: TelegramRichText }
	| { readonly type: 'heading'; readonly text: TelegramRichText; readonly size: 1 | 2 | 3 | 4 | 5 | 6 }
	| { readonly type: 'pre'; readonly text: TelegramRichText; readonly language?: string }
	| { readonly type: 'divider' }
	| { readonly type: 'list'; readonly items: readonly TelegramInputRichBlockListItem[] }
	| { readonly type: 'details'; readonly summary: TelegramRichText; readonly blocks: readonly TelegramInputRichBlock[]; readonly is_open?: true }
	| { readonly type: 'thinking'; readonly text: TelegramRichText };

export interface TelegramInputRichBlockListItem {
	readonly blocks: readonly TelegramInputRichBlock[];
}

interface TelegramInputRichMessageOptions {
	readonly is_rtl?: boolean;
	readonly skip_entity_detection?: boolean;
}

/** Bot API InputRichMessage requires exactly one of blocks, html, or markdown. */
export type TelegramInputRichMessage = TelegramInputRichMessageOptions & (
	| { readonly blocks: readonly TelegramInputRichBlock[]; readonly html?: never; readonly markdown?: never }
	| { readonly html: string; readonly blocks?: never; readonly markdown?: never }
	| { readonly markdown: string; readonly blocks?: never; readonly html?: never }
);

export interface TelegramReplyParameters {
	readonly message_id: number;
	readonly allow_sending_without_reply?: boolean;
}

export interface TelegramGetUpdatesOptions {
	readonly offset?: number;
	readonly limit?: number;
	readonly timeoutSeconds?: number;
	readonly allowedUpdates?: readonly ('message' | 'callback_query')[];
	readonly signal?: IAbortSignal;
}

export interface TelegramSendMessageOptions {
	readonly replyMarkup?: TelegramInlineKeyboardMarkup;
	readonly disableNotification?: boolean;
	readonly parseMode?: 'MarkdownV2' | 'HTML';
	readonly replyParameters?: TelegramReplyParameters;
}

export interface TelegramEditMessageTextOptions {
	readonly replyMarkup?: TelegramInlineKeyboardMarkup;
	readonly parseMode?: 'MarkdownV2' | 'HTML';
}

export interface TelegramSendRichMessageOptions {
	readonly replyMarkup?: TelegramInlineKeyboardMarkup;
	readonly disableNotification?: boolean;
	readonly replyParameters?: TelegramReplyParameters;
}

export interface TelegramEditRichMessageOptions {
	readonly replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramAnswerCallbackQueryOptions {
	readonly text?: string;
	readonly showAlert?: boolean;
	readonly cacheTime?: number;
}

export interface ITelegramBotClient {
	getMe(signal?: IAbortSignal): Promise<TelegramUser>;
	getUpdates(options?: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]>;
	sendMessage(chatId: TelegramChatId, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage>;
	sendRichMessage(chatId: TelegramChatId, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageOptions): Promise<TelegramMessage>;
	sendRichMessageDraft(chatId: number, draftId: number, richMessage: TelegramInputRichMessage): Promise<true>;
	editMessageText(chatId: TelegramChatId, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true>;
	editRichMessage(chatId: TelegramChatId, messageId: number, richMessage: TelegramInputRichMessage, options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true>;
	editMessageReplyMarkup(chatId: TelegramChatId, messageId: number, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<TelegramMessage | true>;
	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<true>;
}

export type TelegramPollingStatus =
	| { readonly state: 'stopped' }
	| { readonly state: 'starting' }
	| { readonly state: 'connected'; readonly bot: TelegramUser }
	| { readonly state: 'retrying'; readonly retryInMs: number; readonly attempt: number; readonly reason: TelegramPollingFailureKind }
	| { readonly state: 'failed'; readonly reason: TelegramPollingFailureKind };

export type TelegramBotApiErrorKind = 'aborted' | 'authentication' | 'rate-limit' | 'server' | 'network' | 'invalid-response' | 'api';
export type TelegramPollingFailureKind = TelegramBotApiErrorKind | 'handler' | 'lease' | 'storage';
export type TelegramBotApiFailureReason = 'message-not-modified';

export class TelegramBotApiError extends Error {
	constructor(
		readonly kind: TelegramBotApiErrorKind,
		message: string,
		readonly httpStatus?: number,
		readonly errorCode?: number,
		readonly retryAfterSeconds?: number,
		readonly apiFailureReason?: TelegramBotApiFailureReason,
	) {
		super(message);
		this.name = 'TelegramBotApiError';
	}
}

export function parseTelegramUser(value: unknown, requireBot = false): TelegramUser {
	const record = asRecord(value, 'Telegram user');
	const user: TelegramUser = {
		id: asSafeInteger(record.id, 'Telegram user id'),
		is_bot: asBoolean(record.is_bot, 'Telegram user is_bot'),
		first_name: asString(record.first_name, 'Telegram user first_name'),
		last_name: asOptionalString(record.last_name, 'Telegram user last_name'),
		username: asOptionalString(record.username, 'Telegram user username'),
		language_code: asOptionalString(record.language_code, 'Telegram user language_code'),
	};
	if (requireBot && !user.is_bot) {
		throw new TelegramBotApiError('invalid-response', 'Telegram getMe returned a non-bot user.');
	}
	return user;
}

/** Rejects malformed bot tokens without ever including the token in an error. */
export function validateTelegramBotToken(botToken: string): void {
	if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken) || botToken.length > 256) {
		throw new TelegramBotApiError('authentication', 'The Telegram bot token is invalid.');
	}
}

export function parseTelegramMessage(value: unknown, includeReply = true): TelegramMessage {
	const record = asRecord(value, 'Telegram message');
	const reply = includeReply && record.reply_to_message !== undefined ? parseTelegramMessage(record.reply_to_message, false) : undefined;
	return {
		message_id: asSafeInteger(record.message_id, 'Telegram message id'),
		date: asSafeInteger(record.date, 'Telegram message date'),
		chat: parseTelegramChat(record.chat),
		from: record.from === undefined ? undefined : parseTelegramUser(record.from),
		text: asOptionalString(record.text, 'Telegram message text'),
		...(reply ? { reply_to_message: reply } : {}),
	};
}

export function parseTelegramUpdate(value: unknown): TelegramUpdate {
	const record = asRecord(value, 'Telegram update');
	const message = record.message === undefined ? undefined : parseTelegramMessage(record.message);
	const callbackQuery = record.callback_query === undefined ? undefined : parseTelegramCallbackQuery(record.callback_query);
	if (message && callbackQuery) {
		throw new TelegramBotApiError('invalid-response', 'Telegram update contains multiple payload types.');
	}
	return {
		update_id: asSafeInteger(record.update_id, 'Telegram update id'),
		message,
		callback_query: callbackQuery,
	};
}

export function parseTelegramMessageOrTrue(value: unknown): TelegramMessage | true {
	return value === true ? true : parseTelegramMessage(value);
}

function parseTelegramChat(value: unknown): TelegramChat {
	const record = asRecord(value, 'Telegram chat');
	const type = asString(record.type, 'Telegram chat type');
	if (type !== 'private' && type !== 'group' && type !== 'supergroup' && type !== 'channel') {
		throw new TelegramBotApiError('invalid-response', 'Telegram returned an unsupported chat type.');
	}
	return {
		id: asSafeInteger(record.id, 'Telegram chat id'),
		type,
		username: asOptionalString(record.username, 'Telegram chat username'),
		first_name: asOptionalString(record.first_name, 'Telegram chat first_name'),
		last_name: asOptionalString(record.last_name, 'Telegram chat last_name'),
		title: asOptionalString(record.title, 'Telegram chat title'),
	};
}

function parseTelegramCallbackQuery(value: unknown): TelegramCallbackQuery {
	const record = asRecord(value, 'Telegram callback query');
	return {
		id: asString(record.id, 'Telegram callback query id'),
		from: parseTelegramUser(record.from),
		message: record.message === undefined ? undefined : parseTelegramMessage(record.message),
		inline_message_id: asOptionalString(record.inline_message_id, 'Telegram callback inline_message_id'),
		data: asOptionalString(record.data, 'Telegram callback data'),
	};
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TelegramBotApiError('invalid-response', `${label} has an invalid shape.`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw new TelegramBotApiError('invalid-response', `${label} is invalid.`);
	}
	return value;
}

function asOptionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : asString(value, label);
}

function asBoolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') {
		throw new TelegramBotApiError('invalid-response', `${label} is invalid.`);
	}
	return value;
}

function asSafeInteger(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new TelegramBotApiError('invalid-response', `${label} is invalid.`);
	}
	return value;
}
