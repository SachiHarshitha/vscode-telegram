/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { mock } from '../../../../util/common/test/simpleMock';
import { URI } from '../../../../util/vs/base/common/uri';
import type { TelegramUpdate } from '../../common/telegramTypes';

export class TestMemento implements vscode.Memento {
	readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	setKeysForSync(_keys: readonly string[]): void {
		// Pairing metadata is deliberately device-local and is never registered for sync.
	}
}

export class TestSecretStorage extends mock<vscode.SecretStorage>() {
	readonly values = new Map<string, string>();

	override async get(key: string): Promise<string | undefined> {
		return this.values.get(key);
	}

	override async store(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	override async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

export class TestTelegramExtensionContext extends mock<IVSCodeExtensionContext>() {
	override readonly globalStorageUri: URI;

	constructor(
		storageRoot: string,
		override readonly globalState = new TestMemento(),
		override readonly secrets = new TestSecretStorage(),
	) {
		super();
		this.globalStorageUri = URI.file(storageRoot);
	}
}

export function telegramMessageUpdate(
	updateId: number,
	text: string | undefined,
	userId = 101,
	chatId = 202,
	chatType: 'private' | 'group' | 'supergroup' | 'channel' = 'private',
	isBot = false,
	username = 'first_handle',
): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			message_id: updateId,
			date: 1_700_000_000,
			chat: { id: chatId, type: chatType },
			from: { id: userId, is_bot: isBot, first_name: 'First', last_name: 'User', username },
			text,
		},
	};
}

export function telegramCallbackUpdate(
	updateId: number,
	callbackData: string,
	userId = 101,
	chatId = 202,
): TelegramUpdate {
	return {
		update_id: updateId,
		callback_query: {
			id: `callback-${updateId}`,
			from: { id: userId, is_bot: false, first_name: 'First', username: 'changed_handle' },
			message: {
				message_id: updateId,
				date: 1_700_000_000,
				chat: { id: chatId, type: 'private' },
			},
			data: callbackData,
		},
	};
}
