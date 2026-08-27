/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { parseTelegramBotAction, TELEGRAM_REPLY_KEYBOARD_COMMAND_ALIASES } from '../telegramBotActions';
import { buildControlKeyboard } from '../telegramControlKeyboards';

describe('Telegram bot actions', () => {
	it('maps every quick-control label to the same application action as its command', () => {
		expect([...TELEGRAM_REPLY_KEYBOARD_COMMAND_ALIASES]).toEqual([
			['New session', '/new'],
			['Sessions', '/sessions'],
			['Model', '/model'],
			['Status', '/status'],
			['Files', '/files'],
			['Help', '/help'],
			['Stop', '/stop'],
			['Steer', '/steer'],
			['Reconnect', '/reconnect'],
			['Settings', '/settings'],
		]);
		expect([
			['New session', parseTelegramBotAction('New session')],
			['Sessions', parseTelegramBotAction('Sessions')],
			['Model', parseTelegramBotAction('Model')],
			['Status', parseTelegramBotAction('Status')],
			['Files', parseTelegramBotAction('Files')],
			['Help', parseTelegramBotAction('Help')],
			['Stop', parseTelegramBotAction('Stop')],
			['Steer', parseTelegramBotAction('Steer')],
			['Reconnect', parseTelegramBotAction('Reconnect')],
			['Settings', parseTelegramBotAction('Settings')],
		]).toEqual([
			['New session', { action: 'new' }],
			['Sessions', { action: 'sessions' }],
			['Model', { action: 'model' }],
			['Status', { action: 'status' }],
			['Files', { action: 'files' }],
			['Help', { action: 'help' }],
			['Stop', { action: 'stop' }],
			['Steer', { action: 'steer' }],
			['Reconnect', { action: 'reconnect' }],
			['Settings', { action: 'settings' }],
		]);
	});

	it('does not reinterpret unknown or inexact ordinary text as a command', () => {
		expect(['new session', 'New Session', 'New session now', '■ Stop', 'More', 'Help me'].map(text => parseTelegramBotAction(text))).toEqual([
			undefined, undefined, undefined, undefined, undefined, undefined,
		]);
		expect(parseTelegramBotAction('/unknown')).toBe('unknown-command');
	});

	it('keeps every canonical slash command working', () => {
		expect(['/new', '/sessions', '/model', '/status', '/files', '/help', '/stop', '/steer', '/reconnect', '/settings'].map(command => parseTelegramBotAction(command))).toEqual([
			{ action: 'new' },
			{ action: 'sessions' },
			{ action: 'model' },
			{ action: 'status' },
			{ action: 'files' },
			{ action: 'help' },
			{ action: 'stop' },
			{ action: 'steer' },
			{ action: 'reconnect' },
			{ action: 'settings' },
		]);
	});

	it('builds only the documented idle, running, and disconnected keyboards', () => {
		expect({
			idle: buildControlKeyboard('idle'),
			running: buildControlKeyboard('running'),
			disconnected: buildControlKeyboard('disconnected'),
		}).toEqual({
			idle: {
				keyboard: [[{ text: 'New session' }, { text: 'Sessions' }, { text: 'Model' }], [{ text: 'Status' }, { text: 'Files' }, { text: 'Help' }]],
				resize_keyboard: true,
				is_persistent: true,
				one_time_keyboard: false,
				input_field_placeholder: 'Ask Copilot...',
			},
			running: {
				keyboard: [[{ text: 'Stop' }, { text: 'Steer' }, { text: 'Status' }], [{ text: 'Files' }, { text: 'Help' }]],
				resize_keyboard: true,
				is_persistent: true,
				one_time_keyboard: false,
				input_field_placeholder: 'Send instructions to Copilot...',
			},
			disconnected: {
				keyboard: [[{ text: 'Reconnect' }, { text: 'Status' }], [{ text: 'Settings' }]],
				resize_keyboard: true,
				is_persistent: true,
				one_time_keyboard: false,
				input_field_placeholder: undefined,
			},
		});
	});
});
