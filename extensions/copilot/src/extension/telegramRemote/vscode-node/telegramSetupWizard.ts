/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hostname } from 'node:os';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, ConfigTarget, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { TelegramBotApiError, TelegramPollingStatus, validateTelegramBotToken } from '../common/telegramTypes';
import type { TelegramPairedIdentity } from '../node/telegramAuthorization';
import { getTelegramConsentScopeFingerprint } from '../node/telegramConsent';
import { TelegramPairingChallenge } from '../node/telegramPairingService';
import { TelegramPollerLeaseHeldError } from '../node/telegramPollerLease';
import { TelegramRemoteContribution } from './telegramRemoteContribution';

export const TelegramRemoteCommand = Object.freeze({
	Setup: 'github.copilot.cli.telegram.setup',
	TestConnection: 'github.copilot.cli.telegram.testConnection',
	StartPairing: 'github.copilot.cli.telegram.startPairing',
	RevokePairing: 'github.copilot.cli.telegram.revokePairing',
	Disable: 'github.copilot.cli.telegram.disable',
	ShowStatus: 'github.copilot.cli.telegram.showStatus',
	ShowLog: 'github.copilot.cli.telegram.showLog',
	StatusBarMenu: 'github.copilot.cli.telegram.statusBarMenu',
});

interface TelegramConsentScope {
	readonly fingerprint: string;
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
}

type SetupSource = 'command' | 'setting';

/** Registers the consent-gated setup commands and owns configuration-driven lifecycle changes. */
export class TelegramSetupWizard extends Disposable {
	private readonly setupCancellationEmitter = this._register(new Emitter<void>());
	private setupPromise: Promise<void> | undefined;
	private configurationWriteDepth = 0;
	private setupGeneration = 0;

	constructor(
		private readonly contribution: TelegramRemoteContribution,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.registerCommand(TelegramRemoteCommand.Setup, () => this.runSetup('command'));
		this.registerCommand(TelegramRemoteCommand.TestConnection, () => this.testConnection());
		this.registerCommand(TelegramRemoteCommand.StartPairing, () => this.startPairing());
		this.registerCommand(TelegramRemoteCommand.RevokePairing, () => this.revokePairing());
		this.registerCommand(TelegramRemoteCommand.Disable, () => this.disableRemoteAccess(true));
		this.registerCommand(TelegramRemoteCommand.ShowStatus, () => this.showStatus());
		this.registerCommand(TelegramRemoteCommand.ShowLog, () => vscode.commands.executeCommand('github.copilot.debug.showOutputChannel.internal'));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(ConfigKey.Advanced.CLITelegramEnabled.fullyQualifiedId) || this.configurationWriteDepth > 0) {
				return;
			}
			if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled)) {
				void this.runSetup('setting');
			} else {
				void this.disableRemoteAccess(false);
			}
		}));
		void this.restoreConnection().catch(() => {
			this.logService.error('[TelegramRemote] Failed to restore the consented Telegram connection.');
		});
	}

	async disableRemoteAccess(showNotification: boolean): Promise<void> {
		this.cancelSetup();
		const disabling = this.contribution.disableRemoteAccess().then(() => false, () => true);
		await this.setEnabled(false);
		if (await disabling) {
			this.logService.warn('[TelegramRemote] Local access was blocked, but Telegram transport cleanup reported an error.');
			await vscode.window.showErrorMessage(l10n.t('Telegram Remote access was blocked locally, but connection cleanup did not complete normally.'));
		} else if (showNotification && this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
			await vscode.window.showInformationMessage(l10n.t('Telegram Remote access is disabled.'));
		}
	}

	private registerCommand(command: string, handler: () => Thenable<unknown>): void {
		this._register(vscode.commands.registerCommand(command, async () => {
			try {
				await handler();
			} catch {
				this.logService.error(`[TelegramRemote] Command ${command} failed.`);
				await vscode.window.showErrorMessage(l10n.t('Telegram Remote could not complete the requested operation. The bot token was not displayed or logged.'));
			}
		}));
	}

	private async restoreConnection(): Promise<void> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled)) {
			return;
		}
		const restored = await this.contribution.resumeStoredConnection(this.getConsentScope().fingerprint, this.getPollingOptions());
		if (!restored) {
			await this.runSetup('setting');
		}
	}

	private runSetup(source: SetupSource): Promise<void> {
		if (this.setupPromise) {
			return this.setupPromise;
		}
		const generation = ++this.setupGeneration;
		const setupPromise = this.runSetupCore(source, generation).finally(() => {
			if (this.setupPromise === setupPromise) {
				this.setupPromise = undefined;
			}
		});
		this.setupPromise = setupPromise;
		return setupPromise;
	}

	private async runSetupCore(source: SetupSource, generation: number): Promise<void> {
		const scope = this.getConsentScope();
		const accepted = await this.requestConsent(scope);
		if (generation !== this.setupGeneration) {
			return;
		}
		if (!accepted) {
			if (this.contribution.consent.hasPendingConsent) {
				await this.rollbackSetup();
			} else if (source === 'setting') {
				await this.setEnabled(false);
			}
			return;
		}

		const storedToken = source === 'setting' ? await this.contribution.authorization.getBotToken() : undefined;
		const botToken = storedToken ?? await this.promptForBotToken();
		if (generation !== this.setupGeneration) {
			return;
		}
		if (!botToken) {
			if (this.contribution.consent.hasPendingConsent) {
				await this.rollbackSetup();
			} else if (source === 'setting') {
				await this.setEnabled(false);
			}
			return;
		}

		try {
			await this.contribution.disableRemoteAccess();
			const result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: l10n.t('Validating the Telegram bot token...'),
				cancellable: false,
			}, () => this.contribution.startPairing(botToken, scope.fingerprint, this.getPollingOptions()));
			if (generation !== this.setupGeneration) {
				await this.rollbackSetup();
				return;
			}
			if (!await this.presentPairingChallenge(result.challenge)) {
				await this.rollbackSetup();
				return;
			}
			const identity = await this.waitForPairing(result.challenge);
			if (generation !== this.setupGeneration) {
				if (this.contribution.consent.hasPendingConsent) {
					await this.rollbackSetup();
				}
				return;
			}
			if (!identity) {
				await this.rollbackSetup();
				return;
			}
			await this.setEnabled(true);
			if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
				const userLabel = identity.username ? `@${identity.username}` : identity.firstName;
				await vscode.window.showInformationMessage(l10n.t('Telegram Remote is connected to {0} and paired with {1}.', formatBotName(result.bot), userLabel));
			}
		} catch (error) {
			await this.rollbackSetup();
			this.logService.error('[TelegramRemote] Setup failed; credential details were suppressed.');
			await vscode.window.showErrorMessage(getTelegramSetupErrorMessage(error));
		}
	}

	private async requestConsent(scope: TelegramConsentScope): Promise<boolean> {
		const enable = l10n.t('Enable Remote Access');
		const learnMore = l10n.t('Learn More');
		while (true) {
			const choice = await vscode.window.showWarningMessage(
				l10n.t('Enable Telegram remote control of Copilot?'),
				{ modal: true, detail: buildTelegramConsentDetail(scope.workstationLabel, scope.workspaceLabel) },
				enable,
				learnMore,
			);
			if (choice === enable) {
				return true;
			}
			if (choice !== learnMore) {
				return false;
			}
			const securityDocument = vscode.Uri.joinPath(this.extensionContext.extensionUri, 'docs', 'telegram-remote', 'SECURITY.md');
			await vscode.commands.executeCommand('vscode.open', securityDocument);
		}
	}

	private async promptForBotToken(): Promise<string | undefined> {
		const value = await vscode.window.showInputBox({
			title: l10n.t('Telegram Remote: Bot Token'),
			prompt: l10n.t('Paste the token from BotFather. It will be stored in VS Code SecretStorage and will not be written to settings or logs.'),
			placeHolder: '123456789:AA...',
			password: true,
			ignoreFocusOut: true,
			validateInput: value => {
				try {
					validateTelegramBotToken(value.trim());
					return undefined;
				} catch {
					return l10n.t('Enter a valid Telegram bot token.');
				}
			},
		});
		return value?.trim();
	}

	private async presentPairingChallenge(challenge: TelegramPairingChallenge): Promise<boolean> {
		const copyAndWait = l10n.t('Copy Command and Wait');
		const wait = l10n.t('Wait for Pairing');
		const choice = await vscode.window.showInformationMessage(
			l10n.t('Pair Telegram Remote'),
			{
				modal: true,
				detail: l10n.t('In a private chat with your bot, send this single-use command before it expires:\n\n{0}', challenge.command),
			},
			copyAndWait,
			wait,
		);
		if (choice === copyAndWait) {
			await vscode.env.clipboard.writeText(challenge.command);
		}
		return choice === copyAndWait || choice === wait;
	}

	private waitForPairing(challenge: TelegramPairingChallenge): Promise<TelegramPairedIdentity | undefined> {
		const pairedIdentity = this.contribution.authorization.pairedIdentity;
		if (pairedIdentity && !this.contribution.consent.hasPendingConsent) {
			return Promise.resolve(pairedIdentity);
		}
		return Promise.resolve(vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: l10n.t('Waiting for the pairing command in the private Telegram chat...'),
			cancellable: true,
		}, (_progress, token) => new Promise<TelegramPairedIdentity | undefined>(resolve => {
			const disposables = new DisposableStore();
			let completed = false;
			const complete = (identity: TelegramPairedIdentity | undefined) => {
				if (completed) {
					return;
				}
				completed = true;
				disposables.dispose();
				resolve(identity);
			};
			disposables.add(this.contribution.onDidCompletePairing(identity => complete(identity)));
			disposables.add(this.setupCancellationEmitter.event(() => complete(undefined)));
			disposables.add(token.onCancellationRequested(() => complete(undefined)));
			const timeout = setTimeout(() => complete(undefined), Math.max(0, challenge.expiresAt - Date.now()));
			disposables.add(toDisposable(() => clearTimeout(timeout)));
		})));
	}

	private async rollbackSetup(): Promise<void> {
		const forgetting = this.contribution.forgetBotToken().then(() => false, () => true);
		await this.setEnabled(false);
		if (await forgetting) {
			this.logService.warn('[TelegramRemote] Failed to clear incomplete Telegram setup state.');
		}
	}

	private async testConnection(): Promise<void> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled)) {
			await vscode.window.showWarningMessage(l10n.t('Telegram Remote is disabled. Run Telegram Remote: Set Up to enable it.'));
			return;
		}
		if (this.contribution.currentStatus.state !== 'connected') {
			await this.restoreConnection();
		}
		await this.showStatus();
	}

	private async startPairing(): Promise<void> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled) || !this.contribution.isAcceptingUpdates) {
			await this.runSetup('command');
			return;
		}
		const challenge = this.contribution.beginPairing();
		if (await this.presentPairingChallenge(challenge)) {
			const identity = await this.waitForPairing(challenge);
			if (identity && this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
				await vscode.window.showInformationMessage(l10n.t('Telegram user pairing was updated.'));
			}
		}
	}

	private async revokePairing(): Promise<void> {
		await this.contribution.revokePairing();
		if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
			await vscode.window.showInformationMessage(l10n.t('The paired Telegram user was removed. Remote prompts are blocked until a new user is paired.'));
		}
	}

	private async showStatus(): Promise<void> {
		await vscode.window.showInformationMessage(getTelegramStatusMessage(
			this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled),
			this.contribution.currentStatus,
			this.contribution.authorization.pairedIdentity?.username ?? this.contribution.authorization.pairedIdentity?.firstName,
		));
	}

	private getConsentScope(): TelegramConsentScope {
		const workspaceIdentifiers = vscode.workspace.workspaceFile
			? [vscode.workspace.workspaceFile.toString()]
			: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString());
		const openWorkspaceLabel = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath || folder.uri.toString()).join(', ');
		const workspaceLabel = vscode.workspace.workspaceFile?.fsPath ?? (openWorkspaceLabel || l10n.t('No workspace is open'));
		return {
			fingerprint: getTelegramConsentScopeFingerprint(vscode.env.machineId, workspaceIdentifiers),
			workstationLabel: hostname(),
			workspaceLabel,
		};
	}

	private getPollingOptions(): { timeoutSeconds: number } {
		return { timeoutSeconds: this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramPollTimeout) };
	}

	private async setEnabled(enabled: boolean): Promise<void> {
		if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled) === enabled) {
			return;
		}
		this.configurationWriteDepth++;
		try {
			await this.configurationService.setConfig(ConfigKey.Advanced.CLITelegramEnabled, enabled, ConfigTarget.Global);
		} finally {
			this.configurationWriteDepth--;
		}
	}

	private cancelSetup(): void {
		this.setupGeneration++;
		this.setupCancellationEmitter.fire();
	}

	public override dispose(): void {
		this.cancelSetup();
		super.dispose();
	}
}

export function buildTelegramConsentDetail(workstationLabel: string, workspaceLabel: string): string {
	return l10n.t('A paired Telegram user can send Copilot prompts that cause this machine to write files, run shell commands, access the network, and perform Git operations.\n\nThat user can approve permission requests remotely, so operations may proceed without anyone at the keyboard.\n\nTelegram bot chats are not end-to-end encrypted. Prompts, code, file paths, diffs, and tool output sent to the bot transit Telegram infrastructure.\n\nAnyone who obtains the bot token can impersonate the bot. Anyone who obtains the paired Telegram account gains this control.\n\nWorkstation exposed: {0}\nWorkspace exposed: {1}\n\nTo turn it off, select the Telegram status bar item and choose Disable Remote Access.', workstationLabel, workspaceLabel);
}

export function getTelegramStatusMessage(enabled: boolean, status: TelegramPollingStatus, pairedUser: string | undefined): string {
	if (!enabled && status.state === 'stopped') {
		return l10n.t('Telegram Remote is disabled.');
	}
	switch (status.state) {
		case 'starting':
			return l10n.t('Telegram Remote is connecting.');
		case 'retrying':
			return l10n.t('Telegram Remote is reconnecting after a transport error.');
		case 'failed':
			return l10n.t('Telegram Remote has a connection error ({0}). Remote prompts are blocked.', status.reason);
		case 'connected':
			return pairedUser
				? l10n.t('Telegram Remote is connected and paired with {0}.', pairedUser)
				: l10n.t('Telegram Remote is connected but no Telegram user is paired.');
		case 'stopped':
			return l10n.t('Telegram Remote is stopped.');
	}
}

function formatBotName(bot: { readonly username?: string; readonly first_name: string }): string {
	return bot.username ? `@${bot.username}` : bot.first_name;
}

function getTelegramSetupErrorMessage(error: unknown): string {
	if (error instanceof TelegramPollerLeaseHeldError) {
		return l10n.t('Another VS Code window or process is already polling this Telegram bot.');
	}
	if (error instanceof TelegramBotApiError) {
		switch (error.kind) {
			case 'authentication':
				return l10n.t('Telegram rejected the bot token. No token or consent was kept.');
			case 'network':
			case 'rate-limit':
			case 'server':
				return l10n.t('Telegram could not be reached. No token or consent was kept.');
		}
	}
	return l10n.t('Telegram Remote setup failed. No token or consent was kept.');
}
