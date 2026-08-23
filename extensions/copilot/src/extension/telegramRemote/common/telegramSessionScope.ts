/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface TelegramAuthorizedSessionScope {
	readonly fingerprint: string;
	readonly workingDirectoryLabel: string;
}

/** Narrow structural view used to keep the authorization contract host- and transport-neutral. */
export interface TelegramSessionScopeCandidate {
	readonly id: string;
	readonly workingDirectory?: {
		readonly fsPath: string;
		toString(): string;
	};
}

/** Fail-closed authorization boundary for metadata and remote operations on a Copilot session. */
export interface TelegramSessionScopePolicy {
	authorizeSession(session: TelegramSessionScopeCandidate): TelegramAuthorizedSessionScope | undefined;
}
