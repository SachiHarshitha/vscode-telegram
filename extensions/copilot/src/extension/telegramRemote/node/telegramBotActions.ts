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

export const QUICK_ACTIONS: Readonly<Record<string, TelegramBotAction>> = Object.freeze({
	'＋ New': 'new',
	'Sessions': 'sessions',
	'Model': 'model',
	'Status': 'status',
	'Files': 'files',
	'More': 'more',
	'■ Stop': 'stop',
	'Steer': 'steer',
	'Reconnect': 'reconnect',
	'Settings': 'settings',
});

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
	const quickAction = QUICK_ACTIONS[text];
	if (quickAction) {
		return { action: quickAction };
	}
	if (!text.startsWith('/')) {
		return undefined;
	}
	const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i.exec(text);
	if (!match) {
		return 'unknown-command';
	}
	const action = commandActions[match[1].toLocaleLowerCase()];
	return action ? { action, parameters: match[2]?.trim() || undefined } : 'unknown-command';
}
