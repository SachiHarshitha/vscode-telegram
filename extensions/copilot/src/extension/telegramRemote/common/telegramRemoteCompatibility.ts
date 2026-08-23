/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const TELEGRAM_REMOTE_BUILD_MARKER = 'vscode-telegram/telegram-remote';
export const TELEGRAM_REMOTE_PATCH_REVISION = 2;

export interface TelegramRemoteHostEnvironment {
	readonly sessionController: boolean;
	readonly agentSessionsWorkspace: boolean;
}

export interface TelegramRemoteSupportedHost {
	readonly supported: true;
	readonly sessionController: true;
	readonly agentSessionsWorkspace: false;
}

export type TelegramRemoteUnsupportedReason = 'legacy-session-provider' | 'agent-sessions-workspace';

export interface TelegramRemoteUnsupportedHost {
	readonly supported: false;
	readonly reason: TelegramRemoteUnsupportedReason;
}

export type TelegramRemoteHostCompatibility = TelegramRemoteSupportedHost | TelegramRemoteUnsupportedHost;

/**
 * Resolves whether this extension host is allowed to register Telegram Remote contributions.
 * Product V1 is deliberately restricted to the controller-based Copilot CLI implementation in
 * an ordinary workspace. Network and UI contributions are added in later implementation phases.
 */
export function resolveTelegramRemoteHostCompatibility(environment: TelegramRemoteHostEnvironment): TelegramRemoteHostCompatibility {
	if (!environment.sessionController) {
		return { supported: false, reason: 'legacy-session-provider' };
	}

	if (environment.agentSessionsWorkspace) {
		return { supported: false, reason: 'agent-sessions-workspace' };
	}

	return {
		supported: true,
		sessionController: true,
		agentSessionsWorkspace: false,
	};
}
