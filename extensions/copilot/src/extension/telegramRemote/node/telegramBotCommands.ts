/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAbortSignal } from '../../../platform/networking/common/fetcherService';
import type { ITelegramBotClient, TelegramBotCommand } from '../common/telegramTypes';

export const telegramBotCommands: readonly TelegramBotCommand[] = Object.freeze([
	{ command: 'new', description: 'Start a new Copilot session' },
	{ command: 'sessions', description: 'View or switch sessions' },
	{ command: 'model', description: 'Select the AI model' },
	{ command: 'status', description: 'Show connection and agent status' },
	{ command: 'files', description: 'Browse workspace files' },
	{ command: 'stop', description: 'Stop the active request' },
	{ command: 'controls', description: 'Show quick controls' },
	{ command: 'settings', description: 'Open bot settings' },
	{ command: 'help', description: 'Show available commands' },
]);

export function registerTelegramBotCommands(client: ITelegramBotClient, signal?: IAbortSignal): Promise<true> {
	return client.setMyCommands(telegramBotCommands, signal);
}
