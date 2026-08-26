/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TelegramReplyKeyboardMarkup, TelegramReplyKeyboardRemove } from '../common/telegramTypes';

export type TelegramControlState = 'idle' | 'running' | 'disconnected';

/** Builds the only persistent reply-keyboards used by Telegram Remote. */
export function buildControlKeyboard(state: TelegramControlState): TelegramReplyKeyboardMarkup {
	switch (state) {
		case 'idle':
			return keyboard([
				['/new', '/sessions', '/model'],
				['/status', '/files', '/help'],
			], 'Ask Copilot...');
		case 'running':
			return keyboard([
				['/stop', '/steer', '/status'],
				['/files', '/help'],
			], 'Send instructions to Copilot...');
		case 'disconnected':
			return keyboard([
				['/reconnect', '/status'],
				['/settings'],
			]);
	}
}

export function removeControlKeyboard(): TelegramReplyKeyboardRemove {
	return { remove_keyboard: true };
}

function keyboard(rows: readonly (readonly string[])[], placeholder?: string): TelegramReplyKeyboardMarkup {
	return {
		keyboard: rows.map(row => row.map(text => ({ text }))),
		resize_keyboard: true,
		is_persistent: true,
		one_time_keyboard: false,
		input_field_placeholder: placeholder,
	};
}
