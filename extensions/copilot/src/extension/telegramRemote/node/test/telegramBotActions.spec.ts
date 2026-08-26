/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { parseTelegramBotAction } from '../telegramBotActions';
import { buildControlKeyboard } from '../telegramControlKeyboards';

describe('Telegram bot actions', () => {
	it('maps every quick-control label to the same application action as its command', () => {
		expect([
			['＋ New', parseTelegramBotAction('＋ New')],
			['Sessions', parseTelegramBotAction('Sessions')],
			['Model', parseTelegramBotAction('Model')],
			['Status', parseTelegramBotAction('Status')],
			['Files', parseTelegramBotAction('Files')],
			['■ Stop', parseTelegramBotAction('■ Stop')],
			['More', parseTelegramBotAction('More')],
			['Steer', parseTelegramBotAction('Steer')],
			['Reconnect', parseTelegramBotAction('Reconnect')],
			['Settings', parseTelegramBotAction('Settings')],
		]).toEqual([
			['＋ New', { action: 'new' }],
			['Sessions', { action: 'sessions' }],
			['Model', { action: 'model' }],
			['Status', { action: 'status' }],
			['Files', { action: 'files' }],
			['■ Stop', { action: 'stop' }],
			['More', { action: 'more' }],
			['Steer', { action: 'steer' }],
			['Reconnect', { action: 'reconnect' }],
			['Settings', { action: 'settings' }],
		]);
	});

	it('parses every reply-keyboard payload as an explicit slash command', () => {
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
				keyboard: [[{ text: '/new' }, { text: '/sessions' }, { text: '/model' }], [{ text: '/status' }, { text: '/files' }, { text: '/help' }]],
				resize_keyboard: true,
				is_persistent: true,
				one_time_keyboard: false,
				input_field_placeholder: 'Ask Copilot...',
			},
			running: {
				keyboard: [[{ text: '/stop' }, { text: '/steer' }, { text: '/status' }], [{ text: '/files' }, { text: '/help' }]],
				resize_keyboard: true,
				is_persistent: true,
				one_time_keyboard: false,
				input_field_placeholder: 'Send instructions to Copilot...',
			},
			disconnected: {
				keyboard: [[{ text: '/reconnect' }, { text: '/status' }], [{ text: '/settings' }]],
				resize_keyboard: true,
				is_persistent: true,
				one_time_keyboard: false,
				input_field_placeholder: undefined,
			},
		});
	});
});
