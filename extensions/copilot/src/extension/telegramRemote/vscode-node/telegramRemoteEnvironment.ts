/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hostname } from 'node:os';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { getTelegramConsentScopeFingerprint } from '../node/telegramConsent';

export interface TelegramRemoteEnvironment {
	readonly consentScopeFingerprint: string;
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
}

export function getTelegramRemoteEnvironment(): TelegramRemoteEnvironment {
	const workspaceIdentifiers = vscode.workspace.workspaceFile
		? [vscode.workspace.workspaceFile.toString()]
		: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString());
	const openWorkspaceLabel = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath || folder.uri.toString()).join(', ');
	return {
		consentScopeFingerprint: getTelegramConsentScopeFingerprint(vscode.env.machineId, workspaceIdentifiers),
		workstationLabel: hostname(),
		workspaceLabel: vscode.workspace.workspaceFile?.fsPath ?? (openWorkspaceLabel || l10n.t('No workspace is open')),
	};
}
