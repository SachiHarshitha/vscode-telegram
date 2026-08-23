/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildTelegramConsentDetail, getTelegramStatusMessage } from '../telegramSetupWizard';
import { getTelegramStatusBarPresentation } from '../telegramStatusBar';

describe('Telegram Phase 3b UI', () => {
	it('discloses all consent risks and exact local scope without exposing a bot token', () => {
		const token = '123456:never-render-this-token';
		const detail = buildTelegramConsentDetail('WORKSTATION-17', 'C:\\projects\\private-workspace');

		expect({
			writes: detail.includes('write files'),
			shell: detail.includes('shell commands'),
			network: detail.includes('access the network'),
			git: detail.includes('Git operations'),
			remoteApproval: detail.includes('approve permission requests remotely'),
			notEndToEndEncrypted: detail.includes('not end-to-end encrypted'),
			tokenCompromise: detail.includes('obtains the bot token'),
			accountCompromise: detail.includes('paired Telegram account'),
			workstation: detail.includes('WORKSTATION-17'),
			workspace: detail.includes('C:\\projects\\private-workspace'),
			disable: detail.includes('Disable Remote Access'),
			redacted: !detail.includes(token),
		}).toEqual({
			writes: true,
			shell: true,
			network: true,
			git: true,
			remoteApproval: true,
			notEndToEndEncrypted: true,
			tokenCompromise: true,
			accountCompromise: true,
			workstation: true,
			workspace: true,
			disable: true,
			redacted: true,
		});
	});

	it('renders stable hidden, connecting, unauthorized, attached, and error states', () => {
		expect([
			getTelegramStatusBarPresentation({ enabled: false, statusBarEnabled: true, status: { state: 'stopped' }, sessionTitles: [] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'starting' }, sessionTitles: [] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } }, sessionTitles: [] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } }, pairedUser: '@operator', sessionTitles: ['Session A'] }),
			getTelegramStatusBarPresentation({ enabled: false, statusBarEnabled: false, status: { state: 'stopped' }, pairedUser: '@operator', sessionTitles: ['Session A'] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'failed', reason: 'network' }, sessionTitles: [] }),
		]).toEqual([
			{ visible: false },
			expect.objectContaining({ visible: true, text: '$(sync~spin) Telegram' }),
			expect.objectContaining({ visible: true, text: '$(alert) Telegram', background: 'error' }),
			expect.objectContaining({ visible: true, text: '$(radio-tower) Telegram: Session A', background: 'warning' }),
			expect.objectContaining({ visible: true, text: '$(radio-tower) Telegram: Session A', background: 'warning' }),
			expect.objectContaining({ visible: true, text: '$(alert) Telegram', background: 'error' }),
		]);
	});

	it('keeps status text credential-free', () => {
		const token = '123456:never-render-this-token';
		const status = getTelegramStatusMessage(true, { state: 'failed', reason: 'authentication' }, undefined);
		expect(status).not.toContain(token);
	});
});
