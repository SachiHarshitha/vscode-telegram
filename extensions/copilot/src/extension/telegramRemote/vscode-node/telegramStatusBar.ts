/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IRemoteControlRegistry } from '../common/remoteControlTypes';
import type { TelegramPollingStatus } from '../common/telegramTypes';
import { TelegramRemoteContribution, type TelegramRemoteAuthorizationState } from './telegramRemoteContribution';
import { getTelegramRemoteCapabilities, TelegramRemoteCommand, TelegramSetupWizard } from './telegramSetupWizard';

interface TelegramStatusBarPresentation {
	readonly visible: boolean;
	readonly text?: string;
	readonly tooltip?: string;
	readonly background?: 'warning' | 'error';
}

export interface TelegramStatusQuickPickItem extends vscode.QuickPickItem {
	readonly command: string;
}

/** Maintains the stable local Telegram status indicator and its kill-switch menu. */
export class TelegramStatusBar extends Disposable {
	private readonly statusBarItem: vscode.StatusBarItem;

	constructor(
		private readonly contribution: TelegramRemoteContribution,
		private readonly setupWizard: TelegramSetupWizard,
		@IRemoteControlRegistry private readonly registry: IRemoteControlRegistry,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.statusBarItem = this._register(vscode.window.createStatusBarItem('github.copilot.telegramRemote', vscode.StatusBarAlignment.Right, 90));
		this.statusBarItem.name = l10n.t('Telegram Remote');
		this.statusBarItem.command = TelegramRemoteCommand.StatusBarMenu;
		this._register(this.contribution.transport.onDidChangeStatus(() => this.update()));
		this._register(this.contribution.onDidChangeAuthorizationState(() => this.update()));
		this._register(this.contribution.authorization.onDidChangePairedIdentity(() => this.update()));
		this._register(this.setupWizard.onDidChangeConfigured(() => this.update()));
		this._register(this.registry.onDidChangeAttachments(() => this.update()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ConfigKey.Advanced.CLITelegramEnabled.fullyQualifiedId)
				|| event.affectsConfiguration(ConfigKey.Advanced.CLITelegramStatusBarEnabled.fullyQualifiedId)) {
				this.update();
			}
		}));
		this._register(vscode.commands.registerCommand(TelegramRemoteCommand.StatusBarMenu, () => this.showMenu()));
		this.update();
	}

	private update(): void {
		const attachedSessionIds = this.registry.getAttachedSessionIds(this.contribution.transport.id);
		const sessionTitles = attachedSessionIds.map(sessionId => this.registry.getSession(sessionId)?.title?.trim() || l10n.t('Copilot session'));
		const pairedIdentity = this.contribution.authorization.pairedIdentity;
		const pairedUser = pairedIdentity ? pairedIdentity.username ? `@${pairedIdentity.username}` : pairedIdentity.firstName : undefined;
		const presentation = getTelegramStatusBarPresentation({
			enabled: this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled),
			configured: this.setupWizard.isConfigured,
			statusBarEnabled: this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramStatusBarEnabled),
			status: this.contribution.currentStatus,
			authorizationState: this.contribution.authorizationState,
			pairedUser,
			sessionTitles,
			remotePermissionResponses: getTelegramRemoteCapabilities(this.contribution.transport).remotePermissionResponses,
		});
		if (!presentation.visible) {
			this.statusBarItem.hide();
			return;
		}
		this.statusBarItem.text = presentation.text!;
		this.statusBarItem.tooltip = presentation.tooltip;
		this.statusBarItem.backgroundColor = presentation.background
			? new vscode.ThemeColor(`statusBarItem.${presentation.background}Background`)
			: undefined;
		this.statusBarItem.show();
	}

	private async showMenu(): Promise<void> {
		const items = getTelegramStatusMenuItems({
			enabled: this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled),
			configured: this.setupWizard.isConfigured,
			status: this.contribution.currentStatus,
			authorizationState: this.contribution.authorizationState,
			paired: !!this.contribution.pairedIdentity,
		});
		const selected = await vscode.window.showQuickPick(items, {
			title: l10n.t('Telegram Remote Controls'),
			placeHolder: l10n.t('Choose an action'),
		});
		if (selected) {
			await vscode.commands.executeCommand(selected.command);
		}
	}
}

export function getTelegramStatusBarPresentation(input: {
	readonly enabled: boolean;
	readonly configured?: boolean;
	readonly statusBarEnabled: boolean;
	readonly status: TelegramPollingStatus;
	readonly authorizationState?: TelegramRemoteAuthorizationState;
	readonly pairedUser?: string;
	readonly sessionTitles: readonly string[];
	readonly remotePermissionResponses?: boolean;
}): TelegramStatusBarPresentation {
	if (input.sessionTitles.length > 0) {
		const sessionLabel = input.sessionTitles.length === 1
			? input.sessionTitles[0]
			: l10n.t('{0} (+{1})', input.sessionTitles[0], input.sessionTitles.length - 1);
		return {
			visible: true,
			text: l10n.t('$(radio-tower) Telegram: {0}', sessionLabel),
			tooltip: input.pairedUser
				? input.remotePermissionResponses
					? l10n.t('Telegram user {0} can remotely control {1} and answer supported permission prompts. Select for controls.', input.pairedUser, sessionLabel)
					: l10n.t('Telegram user {0} can send prompts, steer, and stop Telegram-started work in {1}. Permission prompts require local approval. Select for controls.', input.pairedUser, sessionLabel)
				: l10n.t('Telegram is attached to {0}. Permission prompts require local approval. Select Disable Remote Access immediately.', sessionLabel),
			background: 'warning',
		};
	}
	if (!input.statusBarEnabled) {
		return { visible: false };
	}
	if (input.authorizationState === 'needs-consent') {
		return {
			visible: true,
			text: l10n.t('$(shield) Telegram: Workspace authorization required'),
			tooltip: l10n.t('The current workspace has not been authorized for Telegram Remote. Remote commands are blocked. Select for controls.'),
			background: 'warning',
		};
	}
	if (!input.enabled) {
		return input.configured
			? {
				visible: true,
				text: l10n.t('$(circle-slash) Telegram: Off'),
				tooltip: l10n.t('Telegram Remote is disabled. Select to enable remote access using the saved configuration.'),
			}
			: { visible: false };
	}
	if (input.status.state === 'starting' || input.status.state === 'retrying') {
		return {
			visible: true,
			text: l10n.t('$(sync~spin) Telegram'),
			tooltip: input.status.state === 'retrying'
				? l10n.t('Telegram Remote is reconnecting. Select for controls, including Disable Remote Access.')
				: l10n.t('Telegram Remote is connecting. Select for controls, including Disable Remote Access.'),
		};
	}
	if (input.status.state === 'failed') {
		return {
			visible: true,
			text: l10n.t('$(alert) Telegram'),
			tooltip: l10n.t('Telegram Remote connection error ({0}). Remote prompts are blocked. Select for controls.', input.status.reason),
			background: 'error',
		};
	}
	if (input.status.state === 'connected' && !input.pairedUser) {
		return {
			visible: true,
			text: l10n.t('$(alert) Telegram'),
			tooltip: l10n.t('Telegram is connected, but no private-chat user is paired. Select for controls.'),
			background: 'error',
		};
	}
	if (input.status.state === 'connected') {
		return {
			visible: true,
			text: l10n.t('$(radio-tower) Telegram'),
			tooltip: l10n.t('Telegram Remote is connected and paired with {0}. No session is attached. Select for controls.', input.pairedUser!),
		};
	}
	return {
		visible: true,
		text: l10n.t('$(alert) Telegram'),
		tooltip: l10n.t('Telegram Remote is stopped unexpectedly. Remote prompts are blocked. Select for controls.'),
		background: 'error',
	};
}

export function getTelegramStatusMenuItems(input: {
	readonly enabled: boolean;
	readonly configured: boolean;
	readonly status: TelegramPollingStatus;
	readonly paired: boolean;
	readonly authorizationState?: TelegramRemoteAuthorizationState;
}): readonly TelegramStatusQuickPickItem[] {
	if (input.authorizationState === 'needs-consent') {
		return [
			{ label: l10n.t('$(shield) Authorize Current Workspace'), command: TelegramRemoteCommand.AuthorizeWorkspace },
			{ label: l10n.t('$(circle-slash) Keep Disabled'), command: TelegramRemoteCommand.KeepDisabled },
			...(input.configured ? [{ label: l10n.t('$(trash) Forget Configuration'), command: TelegramRemoteCommand.ForgetConfiguration }] : []),
			{ label: l10n.t('$(output) Open Log'), command: TelegramRemoteCommand.ShowLog },
		];
	}
	if (!input.enabled) {
		return [{ label: l10n.t('$(debug-start) Enable Remote Access'), command: TelegramRemoteCommand.Enable }];
	}

	const showStatus: TelegramStatusQuickPickItem = { label: l10n.t('$(info) Show Status'), command: TelegramRemoteCommand.ShowStatus };
	const showLog: TelegramStatusQuickPickItem = { label: l10n.t('$(output) Open Log'), command: TelegramRemoteCommand.ShowLog };
	const disable: TelegramStatusQuickPickItem = {
		label: l10n.t('$(debug-disconnect) Disable Remote Access'),
		description: l10n.t('Immediately block local remote dispatch and stop polling'),
		command: TelegramRemoteCommand.Disable,
	};
	const forget: TelegramStatusQuickPickItem = { label: l10n.t('$(trash) Forget Configuration'), command: TelegramRemoteCommand.ForgetConfiguration };
	if (input.authorizationState === 'pairing-only') {
		return [showStatus, showLog, disable];
	}

	if (input.status.state === 'failed' || input.status.state === 'stopped') {
		const recovery = input.status.state === 'failed' && (input.status.reason === 'authentication' || input.status.reason === 'api')
			? { label: l10n.t('$(gear) Set Up Again'), command: TelegramRemoteCommand.Setup }
			: { label: l10n.t('$(refresh) Reconnect'), command: TelegramRemoteCommand.Reconnect };
		return [recovery, showStatus, showLog, disable, ...(input.configured ? [forget] : [])];
	}

	if (input.status.state === 'connected') {
		return [
			showStatus,
			input.paired
				? { label: l10n.t('$(account) Unpair User'), command: TelegramRemoteCommand.RevokePairing }
				: { label: l10n.t('$(account) Pair User'), command: TelegramRemoteCommand.StartPairing },
			showLog,
			disable,
		];
	}

	return [showStatus, showLog, disable];
}
