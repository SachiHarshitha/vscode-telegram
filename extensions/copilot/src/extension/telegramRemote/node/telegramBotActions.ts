/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TelegramBotAction =
	| 'start'
	| 'new'
	| 'sessions'
	| 'model'
	| 'mode'
	| 'status'
	| 'files'
	| 'stop'
	| 'controls'
	| 'controls-off'
	| 'settings'
	| 'help'
	| 'more'
	| 'steer'
	| 'reconnect'
	| 'deselect';

export interface TelegramBotActionRequest {
	readonly action: TelegramBotAction;
	readonly parameters?: string;
}

export type TelegramBotActionParseResult = TelegramBotActionRequest | 'unknown-command' | undefined;

export const TelegramReplyKeyboardLabel = Object.freeze({
	NewSession: 'New session',
	Sessions: 'Sessions',
	Model: 'Model',
	Status: 'Status',
	Files: 'Files',
	Help: 'Help',
	Stop: 'Stop',
	Steer: 'Steer',
	Reconnect: 'Reconnect',
	Settings: 'Settings',
} as const);

/** Exact reply-keyboard labels mapped to the slash commands they emulate. */
export const TELEGRAM_REPLY_KEYBOARD_COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
	[TelegramReplyKeyboardLabel.NewSession, '/new'],
	[TelegramReplyKeyboardLabel.Sessions, '/sessions'],
	[TelegramReplyKeyboardLabel.Model, '/model'],
	[TelegramReplyKeyboardLabel.Status, '/status'],
	[TelegramReplyKeyboardLabel.Files, '/files'],
	[TelegramReplyKeyboardLabel.Help, '/help'],
	[TelegramReplyKeyboardLabel.Stop, '/stop'],
	[TelegramReplyKeyboardLabel.Steer, '/steer'],
	[TelegramReplyKeyboardLabel.Reconnect, '/reconnect'],
	[TelegramReplyKeyboardLabel.Settings, '/settings'],
]);

const commandActions: Readonly<Record<string, TelegramBotAction>> = Object.freeze({
	start: 'start',
	new: 'new',
	sessions: 'sessions',
	models: 'model',
	model: 'model',
	mode: 'mode',
	status: 'status',
	files: 'files',
	stop: 'stop',
	controls: 'controls',
	controls_off: 'controls-off',
	settings: 'settings',
	help: 'help',
	steer: 'steer',
	reconnect: 'reconnect',
	deselect: 'deselect',
});

/** Normalizes slash commands and reply-keyboard labels into one application action. */
export function parseTelegramBotAction(text: string): TelegramBotActionParseResult {
	const commandText = TELEGRAM_REPLY_KEYBOARD_COMMAND_ALIASES.get(text) ?? text;
	if (!commandText.startsWith('/')) {
		return undefined;
	}
	const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(commandText);
	if (!match) {
		return 'unknown-command';
	}
	const action = commandActions[match[1].toLocaleLowerCase()];
	return action ? { action, parameters: match[2]?.trim() || undefined } : 'unknown-command';
}
