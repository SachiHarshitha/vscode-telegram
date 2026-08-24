/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTelegramConsentDetail, getTelegramStatusMessage, TelegramRemoteCommand } from '../telegramSetupWizard';
import { getTelegramStatusBarPresentation, getTelegramStatusMenuItems } from '../telegramStatusBar';

describe('Telegram Phase 3b UI', () => {
	it('discloses current local-permission capabilities and exact scope without exposing a bot token', () => {
		const token = '123456:never-render-this-token';
		const detail = buildTelegramConsentDetail('WORKSTATION-17', 'C:\\projects\\private-workspace');

		expect({
			writes: detail.includes('write files'),
			shell: detail.includes('shell commands'),
			network: detail.includes('access the network'),
			git: detail.includes('Git operations'),
			localApproval: detail.includes('Permission prompts must be answered locally in this build'),
			unsupportedRemoteApproval: detail.includes('approve permission requests remotely'),
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
			localApproval: true,
			unsupportedRemoteApproval: false,
			notEndToEndEncrypted: true,
			tokenCompromise: true,
			accountCompromise: true,
			workstation: true,
			workspace: true,
			disable: true,
			redacted: true,
		});
	});

	it('advertises remote permission handling only when the transport registers that capability', () => {
		const withoutCapability = buildTelegramConsentDetail('host', 'workspace', { remotePermissionResponses: false });
		const withCapability = buildTelegramConsentDetail('host', 'workspace', { remotePermissionResponses: true });
		expect({
			withoutCapability: withoutCapability.includes('answered remotely'),
			withCapability: withCapability.includes('answer supported permission prompts remotely'),
		}).toEqual({ withoutCapability: false, withCapability: true });
	});

	it('renders stable hidden, connecting, unauthorized, attached, and error states', () => {
		expect([
			getTelegramStatusBarPresentation({ enabled: false, statusBarEnabled: true, status: { state: 'stopped' }, sessionTitles: [] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'starting' }, sessionTitles: [] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } }, sessionTitles: [] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } }, pairedUser: '@operator', sessionTitles: ['Session A'], remotePermissionResponses: false }),
			getTelegramStatusBarPresentation({ enabled: false, statusBarEnabled: false, status: { state: 'stopped' }, pairedUser: '@operator', sessionTitles: ['Session A'] }),
			getTelegramStatusBarPresentation({ enabled: true, statusBarEnabled: true, status: { state: 'failed', reason: 'network' }, sessionTitles: [] }),
		]).toEqual([
			{ visible: false },
			expect.objectContaining({ visible: true, text: '$(copilot-telegram-logo) Telegram' }),
			expect.objectContaining({ visible: true, text: '$(copilot-telegram-logo) Telegram', background: 'error' }),
			expect.objectContaining({ visible: true, text: '$(copilot-telegram-logo) Telegram: Session A', background: 'warning' }),
			expect.objectContaining({ visible: true, text: '$(copilot-telegram-logo) Telegram: Session A', background: 'warning' }),
			expect.objectContaining({ visible: true, text: '$(copilot-telegram-logo) Telegram', background: 'error' }),
		]);
		expect(getTelegramStatusBarPresentation({
			enabled: true,
			statusBarEnabled: true,
			status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } },
			pairedUser: '@operator',
			sessionTitles: ['Session A'],
			remotePermissionResponses: false,
		}).tooltip).toContain('Permission prompts require local approval');
	});

	it('keeps status text credential-free', () => {
		const token = '123456:never-render-this-token';
		const status = getTelegramStatusMessage(true, { state: 'failed', reason: 'authentication' }, undefined);
		expect(status).not.toContain(token);
	});

	it('keeps configured disabled access discoverable without showing inapplicable actions', () => {
		expect({
			configuredOff: getTelegramStatusBarPresentation({ enabled: false, configured: true, statusBarEnabled: true, status: { state: 'stopped' }, sessionTitles: [] }),
			hiddenBySetting: getTelegramStatusBarPresentation({ enabled: false, configured: true, statusBarEnabled: false, status: { state: 'stopped' }, sessionTitles: [] }),
			neverConfigured: getTelegramStatusBarPresentation({ enabled: false, configured: false, statusBarEnabled: true, status: { state: 'stopped' }, sessionTitles: [] }),
		}).toEqual({
			configuredOff: expect.objectContaining({ visible: true, text: '$(copilot-telegram-logo) Telegram: Off' }),
			hiddenBySetting: { visible: false },
			neverConfigured: { visible: false },
		});

		const disabledCommands = getTelegramStatusMenuItems({ enabled: false, configured: true, status: { state: 'stopped' }, paired: true }).map(item => item.command);
		expect(disabledCommands).toEqual([TelegramRemoteCommand.Enable]);
		expect(disabledCommands).not.toContain(TelegramRemoteCommand.Disable);
		expect(disabledCommands).not.toContain(TelegramRemoteCommand.RevokePairing);
	});

	it('renders workspace consent as an amber authorization state with only applicable actions', () => {
		const presentation = getTelegramStatusBarPresentation({
			enabled: false,
			configured: true,
			statusBarEnabled: true,
			status: { state: 'stopped' },
			authorizationState: 'needs-consent',
			sessionTitles: [],
		});
		const commands = getTelegramStatusMenuItems({
			enabled: false,
			configured: true,
			status: { state: 'stopped' },
			authorizationState: 'needs-consent',
			paired: true,
		}).map(item => item.command);

		expect(presentation).toEqual(expect.objectContaining({
			visible: true,
			text: '$(copilot-telegram-logo) Telegram: Workspace authorization required',
			background: 'warning',
		}));
		expect(commands).toEqual([
			TelegramRemoteCommand.AuthorizeWorkspace,
			TelegramRemoteCommand.KeepDisabled,
			TelegramRemoteCommand.ForgetConfiguration,
			TelegramRemoteCommand.ShowLog,
		]);
		expect(commands).not.toContain(TelegramRemoteCommand.RevokePairing);
		expect(commands).not.toContain(TelegramRemoteCommand.Disable);
	});

	it('offers reconnect only for recoverable failures and keeps connected controls state-aware', () => {
		const recoverable = getTelegramStatusMenuItems({ enabled: true, configured: true, status: { state: 'failed', reason: 'network' }, paired: true }).map(item => item.command);
		const authentication = getTelegramStatusMenuItems({ enabled: true, configured: true, status: { state: 'failed', reason: 'authentication' }, paired: true }).map(item => item.command);
		const connected = getTelegramStatusMenuItems({ enabled: true, configured: true, status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } }, paired: true }).map(item => item.command);
		const unpaired = getTelegramStatusMenuItems({ enabled: true, configured: true, status: { state: 'connected', bot: { id: 1, is_bot: true, first_name: 'Bot' } }, paired: false }).map(item => item.command);

		expect(recoverable).toEqual([
			TelegramRemoteCommand.Reconnect,
			TelegramRemoteCommand.ShowStatus,
			TelegramRemoteCommand.ShowLog,
			TelegramRemoteCommand.Disable,
			TelegramRemoteCommand.ForgetConfiguration,
		]);
		expect(authentication[0]).toBe(TelegramRemoteCommand.Setup);
		expect(authentication).not.toContain(TelegramRemoteCommand.Reconnect);
		expect(connected).toEqual([
			TelegramRemoteCommand.ShowStatus,
			TelegramRemoteCommand.RevokePairing,
			TelegramRemoteCommand.ShowLog,
			TelegramRemoteCommand.Disable,
		]);
		expect(unpaired).toContain(TelegramRemoteCommand.StartPairing);
		expect(unpaired).not.toContain(TelegramRemoteCommand.RevokePairing);
	});

	it('declares palette lifecycle commands with state-aware enablement', () => {
		const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
			contributes: { commands: Array<{ command: string; enablement?: string }> };
		};
		const commands = new Map(manifest.contributes.commands.map(command => [command.command, command.enablement]));
		expect({
			enable: commands.get(TelegramRemoteCommand.Enable),
			authorizeWorkspace: commands.get(TelegramRemoteCommand.AuthorizeWorkspace),
			reconnect: commands.get(TelegramRemoteCommand.Reconnect),
			unpair: commands.get(TelegramRemoteCommand.RevokePairing),
			disable: commands.get(TelegramRemoteCommand.Disable),
			forget: commands.get(TelegramRemoteCommand.ForgetConfiguration),
		}).toEqual({
			enable: '!config.github.copilot.chat.cli.telegram.enabled',
			authorizeWorkspace: 'github.copilot.cli.telegram.needsConsent',
			reconnect: 'config.github.copilot.chat.cli.telegram.enabled && github.copilot.cli.telegram.reconnectable',
			unpair: 'config.github.copilot.chat.cli.telegram.enabled && github.copilot.cli.telegram.paired',
			disable: 'config.github.copilot.chat.cli.telegram.enabled',
			forget: 'github.copilot.cli.telegram.configured',
		});
	});
});
