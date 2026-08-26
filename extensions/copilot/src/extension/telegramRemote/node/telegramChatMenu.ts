/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAbortSignal } from '../../../platform/networking/common/fetcherService';
import type { ITelegramBotClient } from '../common/telegramTypes';

/** Configures the global default native Telegram menu button; no chat_id is sent. */
export function configureTelegramChatMenu(client: ITelegramBotClient, signal?: IAbortSignal): Promise<true> {
	return client.setChatMenuButton({ type: 'commands' }, signal);
}
