/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ICopilotCLISessionItem } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { TelegramRemoteEnvironment } from '../telegramRemoteEnvironment';
import { CurrentWorkspaceTelegramSessionScopePolicy } from '../telegramSessionScope';

const consentScopeFingerprint = 'abcdefabcdefabcdefabcdef';

describe('CurrentWorkspaceTelegramSessionScopePolicy', () => {
	it('matches Windows paths case-insensitively without authorizing sibling prefixes', () => {
		const policy = createPolicy([vscode.Uri.file('C:\\Projects\\Repo')]);

		expect({
			same: !!policy.authorizeSession(session('same', vscode.Uri.file('c:\\projects\\repo'))),
			child: !!policy.authorizeSession(session('child', vscode.Uri.file('C:\\Projects\\Repo\\packages\\app'))),
			sibling: !!policy.authorizeSession(session('sibling', vscode.Uri.file('C:\\Projects\\Repository-Secrets'))),
		}).toEqual({ same: true, child: true, sibling: false });
	});

	it('supports multi-root and URI-authority identity while rejecting a changed authority', () => {
		const policy = createPolicy([
			vscode.Uri.file('C:\\Projects\\One'),
			vscode.Uri.parse('vscode-remote://ssh-remote+HOST/workspaces/two'),
		]);

		expect({
			secondRoot: !!policy.authorizeSession(session('second', vscode.Uri.parse('vscode-remote://ssh-remote+host/workspaces/two/app'))),
			otherAuthority: !!policy.authorizeSession(session('foreign', vscode.Uri.parse('vscode-remote://ssh-remote+other/workspaces/two/app'))),
		}).toEqual({ secondRoot: true, otherAuthority: false });
	});

	it('fails closed for no workspace, missing working directory, and consent-scope changes', () => {
		const emptyPolicy = createPolicy([]);
		const changedScopePolicy = createPolicy([vscode.Uri.file('C:\\Projects\\Repo')], '111111111111111111111111');

		expect({
			emptyWindow: !!emptyPolicy.authorizeSession(session('foreign', vscode.Uri.file('C:\\Projects\\Foreign'))),
			missingWorkingDirectory: !!emptyPolicy.authorizeSession({ id: 'missing' }),
			changedScope: !!changedScopePolicy.authorizeSession(session('same', vscode.Uri.file('C:\\Projects\\Repo'))),
		}).toEqual({ emptyWindow: false, missingWorkingDirectory: false, changedScope: false });
	});
});

function createPolicy(workspaceRoots: readonly vscode.Uri[], currentFingerprint = consentScopeFingerprint): CurrentWorkspaceTelegramSessionScopePolicy {
	const environment: TelegramRemoteEnvironment = {
		consentScopeFingerprint: currentFingerprint,
		workstationLabel: 'workstation',
		workspaceLabel: workspaceRoots.map(root => root.fsPath || root.toString()).join(', ') || 'No workspace is open',
		workspaceRoots,
	};
	return new CurrentWorkspaceTelegramSessionScopePolicy(consentScopeFingerprint, () => environment);
}

function session(id: string, workingDirectory: vscode.Uri): ICopilotCLISessionItem {
	return { id, label: id, timing: undefined, workingDirectory };
}
