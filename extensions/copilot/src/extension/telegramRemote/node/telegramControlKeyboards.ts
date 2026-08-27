/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TelegramReplyKeyboardMarkup, TelegramReplyKeyboardRemove } from '../common/telegramTypes';
import { TelegramReplyKeyboardLabel } from './telegramBotActions';

export type TelegramControlState = 'idle' | 'running' | 'disconnected';

/** Builds the only persistent reply-keyboards used by Telegram Remote. */
export function buildControlKeyboard(state: TelegramControlState): TelegramReplyKeyboardMarkup {
	switch (state) {
		case 'idle':
			return keyboard([
				[TelegramReplyKeyboardLabel.NewSession, TelegramReplyKeyboardLabel.Sessions, TelegramReplyKeyboardLabel.Model],
				[TelegramReplyKeyboardLabel.Status, TelegramReplyKeyboardLabel.Files, TelegramReplyKeyboardLabel.Help],
			], 'Ask Copilot...');
		case 'running':
			return keyboard([
				[TelegramReplyKeyboardLabel.Stop, TelegramReplyKeyboardLabel.Steer, TelegramReplyKeyboardLabel.Status],
				[TelegramReplyKeyboardLabel.Files, TelegramReplyKeyboardLabel.Help],
			], 'Send instructions to Copilot...');
		case 'disconnected':
			return keyboard([
				[TelegramReplyKeyboardLabel.Reconnect, TelegramReplyKeyboardLabel.Status],
				[TelegramReplyKeyboardLabel.Settings],
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
