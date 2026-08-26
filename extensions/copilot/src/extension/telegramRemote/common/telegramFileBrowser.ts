/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TelegramWorkspaceFileKind = 'directory' | 'file';

export interface TelegramWorkspaceFileEntry {
	readonly id: string;
	readonly label: string;
	readonly kind: TelegramWorkspaceFileKind;
}

export interface TelegramWorkspaceDirectory {
	readonly relativePath: string;
	readonly entries: readonly TelegramWorkspaceFileEntry[];
}

export interface TelegramWorkspaceFileContent {
	readonly relativePath: string;
	readonly text: string;
	readonly truncated: boolean;
}

/** Abstract, read-only application seam used by Telegram's file navigation UI. */
export interface TelegramWorkspaceFileBrowser {
	listDirectory(workspaceRoot: string, relativePath: string): Promise<TelegramWorkspaceDirectory>;
	readFile(workspaceRoot: string, relativePath: string): Promise<TelegramWorkspaceFileContent>;
}
