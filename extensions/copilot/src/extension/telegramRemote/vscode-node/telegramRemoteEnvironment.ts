/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hostname } from 'node:os';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { extUriBiasedIgnorePathCase } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { getTelegramConsentScopeFingerprint } from '../node/telegramConsent';

export interface TelegramRemoteEnvironment {
	readonly consentScopeFingerprint: string;
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
	readonly workspaceRoots: readonly vscode.Uri[];
}

export function getTelegramRemoteEnvironment(): TelegramRemoteEnvironment {
	const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri);
	const workspaceIdentifiers = [
		vscode.workspace.workspaceFile ? `workspace:${normalizeUri(vscode.workspace.workspaceFile)}` : undefined,
		...workspaceRoots.map(root => `root:${normalizeUri(root)}`),
	].filter((identifier): identifier is string => !!identifier);
	const openWorkspaceLabel = workspaceRoots.map(root => root.fsPath || root.toString()).join(', ');
	return {
		consentScopeFingerprint: getTelegramConsentScopeFingerprint(vscode.env.machineId, workspaceIdentifiers),
		workstationLabel: hostname(),
		workspaceLabel: vscode.workspace.workspaceFile?.fsPath ?? (openWorkspaceLabel || l10n.t('No workspace is open')),
		workspaceRoots,
	};
}

function normalizeUri(uri: vscode.Uri): string {
	return extUriBiasedIgnorePathCase.getComparisonKey(URI.parse(uri.toString()), true);
}
