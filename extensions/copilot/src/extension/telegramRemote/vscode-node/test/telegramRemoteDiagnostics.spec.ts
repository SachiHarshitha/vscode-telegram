/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { TelegramRemoteDiagnostics } from '../telegramRemoteDiagnostics';

const vscodeHost = vi.hoisted(() => ({
	appendLine: vi.fn(),
	show: vi.fn(),
	dispose: vi.fn(),
	writeText: vi.fn(),
}));

vi.mock('vscode', () => ({
	version: '1.136.0-test',
	window: {
		createOutputChannel: () => ({ appendLine: vscodeHost.appendLine, show: vscodeHost.show, dispose: vscodeHost.dispose }),
	},
	env: { clipboard: { writeText: vscodeHost.writeText } },
}));

describe('TelegramRemoteDiagnostics', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('redacts credential-shaped values and strips multiline content from the dedicated channel', () => {
		const diagnostics = createDiagnostics();

		diagnostics.record('connection\nstate', {
			token: '123456:abcdefghijklmnopqrstuvwxyz',
			authorization: 'Bearer visible-only-to-the-test',
			reason: 'line one\nline two',
		});

		const output = vscodeHost.appendLine.mock.calls.map(call => call[0]).join('\n');
		expect(output).toContain('[redacted]');
		expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz');
		expect(output).not.toContain('visible-only-to-the-test');
		expect(output).not.toContain('line one\nline two');
		diagnostics.dispose();
	});

	it('copies bounded runtime compatibility metadata without credentials or conversation content', async () => {
		const diagnostics = createDiagnostics();

		await diagnostics.copyReport({
			configured: true,
			enabled: false,
			paired: true,
			authorizationState: 'disabled',
			pollingStatus: { state: 'stopped' },
			consentScopeFingerprint: 'abcdefabcdefabcdefabcdef',
		});

		const report = JSON.parse(vscodeHost.writeText.mock.calls[0][0]) as Record<string, unknown>;
		expect(report).toEqual(expect.objectContaining({
			schemaVersion: 1,
			vscodeVersion: '1.136.0-test',
			extensionVersion: '0.64.0',
			configured: true,
			enabled: false,
			paired: true,
			pollingState: 'stopped',
			consentScopeFingerprint: 'abcdefabcdefabcdefabcdef',
		}));
		expect(JSON.stringify(report)).not.toMatch(/token|prompt|answer/i);
		diagnostics.dispose();
	});
});

function createDiagnostics(): TelegramRemoteDiagnostics {
	return new TelegramRemoteDiagnostics({
		extension: { packageJSON: { version: '0.64.0', enabledApiProposals: ['chatParticipantPrivate'] } },
	} as IVSCodeExtensionContext);
}
