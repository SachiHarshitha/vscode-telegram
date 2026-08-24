/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, ConfigTarget, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore, toDisposable } from '../../../util/vs/base/common/lifecycle';
import type { IRemoteControlTransport } from '../common/remoteControlTypes';
import { TelegramBotApiError, TelegramPollingStatus, validateTelegramBotToken } from '../common/telegramTypes';
import type { TelegramPairedIdentity } from '../node/telegramAuthorization';
import { TelegramPairingChallenge } from '../node/telegramPairingService';
import { getTelegramBotTokenFingerprint, TelegramPollerLeaseHeldError } from '../node/telegramPollerLease';
import { getTelegramRemoteEnvironment } from './telegramRemoteEnvironment';
import { TelegramRemoteContribution } from './telegramRemoteContribution';

const configuredStateKey = 'vscode-telegram.telegram-remote.configured.v1';
const configuredContextKey = 'github.copilot.cli.telegram.configured';
const pairedContextKey = 'github.copilot.cli.telegram.paired';
const connectedContextKey = 'github.copilot.cli.telegram.connected';
const reconnectableContextKey = 'github.copilot.cli.telegram.reconnectable';
const needsConsentContextKey = 'github.copilot.cli.telegram.needsConsent';

export const TelegramRemoteCommand = Object.freeze({
	Setup: 'github.copilot.cli.telegram.setup',
	Enable: 'github.copilot.cli.telegram.enable',
	AuthorizeWorkspace: 'github.copilot.cli.telegram.authorizeWorkspace',
	KeepDisabled: 'github.copilot.cli.telegram.keepDisabled',
	Reconnect: 'github.copilot.cli.telegram.reconnect',
	TestConnection: 'github.copilot.cli.telegram.testConnection',
	StartPairing: 'github.copilot.cli.telegram.startPairing',
	RevokePairing: 'github.copilot.cli.telegram.revokePairing',
	Disable: 'github.copilot.cli.telegram.disable',
	ForgetConfiguration: 'github.copilot.cli.telegram.forgetConfiguration',
	ShowStatus: 'github.copilot.cli.telegram.showStatus',
	ShowLog: 'github.copilot.cli.telegram.showLog',
	StatusBarMenu: 'github.copilot.cli.telegram.statusBarMenu',
});

interface TelegramConsentScope {
	readonly fingerprint: string;
	readonly workstationLabel: string;
	readonly workspaceLabel: string;
}

type SetupSource = 'command' | 'setting' | 'recovery';

/** Registers the consent-gated setup commands and owns configuration-driven lifecycle changes. */
export class TelegramSetupWizard extends Disposable {
	private readonly setupCancellationEmitter = this._register(new Emitter<void>());
	private readonly configuredEmitter = this._register(new Emitter<boolean>());
	readonly onDidChangeConfigured = this.configuredEmitter.event;
	private connectionOperation: { readonly generation: number; readonly promise: Promise<void> } | undefined;
	private configurationWriteDepth = 0;
	private lifecycleGeneration = 0;
	private configured: boolean;

	constructor(
		private readonly contribution: TelegramRemoteContribution,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.configured = extensionContext.globalState.get<boolean>(configuredStateKey) === true;
		this.registerCommand(TelegramRemoteCommand.Setup, () => this.runSetup('command'));
		this.registerCommand(TelegramRemoteCommand.Enable, () => this.enableRemoteAccess('command'));
		this.registerCommand(TelegramRemoteCommand.AuthorizeWorkspace, () => this.enableRemoteAccess('command'));
		this.registerCommand(TelegramRemoteCommand.KeepDisabled, () => this.keepDisabled());
		this.registerCommand(TelegramRemoteCommand.Reconnect, () => this.reconnect());
		this.registerCommand(TelegramRemoteCommand.TestConnection, () => this.testConnection());
		this.registerCommand(TelegramRemoteCommand.StartPairing, () => this.startPairing());
		this.registerCommand(TelegramRemoteCommand.RevokePairing, () => this.revokePairing());
		this.registerCommand(TelegramRemoteCommand.Disable, () => this.disableRemoteAccess(true));
		this.registerCommand(TelegramRemoteCommand.ForgetConfiguration, () => this.forgetConfiguration());
		this.registerCommand(TelegramRemoteCommand.ShowStatus, () => this.showStatus());
		this.registerCommand(TelegramRemoteCommand.ShowLog, () => vscode.commands.executeCommand('github.copilot.debug.showOutputChannel.internal'));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(ConfigKey.Advanced.CLITelegramEnabled.fullyQualifiedId) || this.configurationWriteDepth > 0) {
				return;
			}
			if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled)) {
				void this.enableRemoteAccess('setting');
			} else {
				void this.disableRemoteAccess(false);
			}
			this.refreshCommandContexts();
		}));
		this._register(this.contribution.transport.onDidChangeStatus(() => this.refreshCommandContexts()));
		this._register(this.contribution.onDidChangeAuthorizationState(() => this.refreshCommandContexts()));
		this._register(this.contribution.authorization.onDidChangePairedIdentity(() => this.refreshCommandContexts()));
		this.refreshCommandContexts();
		void this.initializeLifecycle().catch(() => {
			this.logService.error('[TelegramRemote] Failed to restore the consented Telegram connection.');
		});
	}

	get isConfigured(): boolean {
		return this.configured;
	}

	async disableRemoteAccess(showNotification: boolean): Promise<void> {
		this.cancelLifecycle();
		const disabling = this.contribution.disableRemoteAccess().then(() => false, () => true);
		await this.setEnabled(false);
		this.refreshCommandContexts();
		if (await disabling) {
			this.logService.warn('[TelegramRemote] Local access was blocked, but Telegram transport cleanup reported an error.');
			await vscode.window.showErrorMessage(l10n.t('Telegram Remote access was blocked locally, but connection cleanup did not complete normally.'));
		} else if (showNotification && this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
			await vscode.window.showInformationMessage(l10n.t('Telegram Remote access is disabled.'));
		}
	}

	private async forgetConfiguration(): Promise<void> {
		this.cancelLifecycle();
		const forgetting = this.contribution.forgetBotToken().then(() => false, () => true);
		await this.setEnabled(false);
		if (await forgetting) {
			this.logService.warn('[TelegramRemote] Local access was blocked, but the saved Telegram configuration could not be fully removed.');
			await vscode.window.showErrorMessage(l10n.t('Telegram Remote was disabled, but its saved configuration could not be fully removed.'));
			return;
		}
		await this.setConfigured(false);
		if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
			await vscode.window.showInformationMessage(l10n.t('Telegram Remote configuration was forgotten.'));
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

	private async initializeLifecycle(): Promise<void> {
		const readiness = await this.contribution.getStoredConnectionReadiness(this.getConsentScope().fingerprint);
		if (readiness !== 'missing-token' && !this.configured) {
			await this.setConfigured(true);
		}
		if (readiness === 'needs-workspace-consent') {
			this.contribution.requireWorkspaceConsent();
		}
		if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled)) {
			await this.enableRemoteAccess('setting');
		}
	}

	private enableRemoteAccess(source: 'command' | 'setting'): Promise<void> {
		return this.runConnectionOperation(generation => this.enableRemoteAccessCore(source, generation));
	}

	private async enableRemoteAccessCore(source: 'command' | 'setting', generation: number, forceLeaseTakeover = false): Promise<void> {
		const scope = this.getConsentScope();
		const readiness = await this.contribution.getStoredConnectionReadiness(scope.fingerprint);
		if (generation !== this.lifecycleGeneration) {
			return;
		}
		switch (readiness) {
			case 'ready': {
				await this.setConfigured(true);
				await this.setEnabled(true);
				const restored = await this.contribution.resumeStoredConnection(scope.fingerprint, this.getPollingOptions(forceLeaseTakeover));
				if (generation !== this.lifecycleGeneration || restored) {
					return;
				}
				break;
			}
			case 'needs-workspace-consent':
				await this.authorizeCurrentWorkspace(scope, generation, forceLeaseTakeover);
				return;
			case 'missing-pairing':
				await this.runPairingRecovery(scope, generation, forceLeaseTakeover);
				return;
			case 'missing-token':
				await this.runSetupCore(source === 'setting' ? 'setting' : 'recovery', generation, true, forceLeaseTakeover);
				return;
		}
		await this.runSetupCore(source === 'setting' ? 'setting' : 'recovery', generation, false, forceLeaseTakeover);
	}

	private reconnect(): Promise<void> {
		return this.runConnectionOperation(async generation => {
			const status = this.contribution.currentStatus;
			if (status.state === 'failed' && (status.reason === 'authentication' || status.reason === 'api')) {
				await this.runSetupCore('command', generation, false, true);
				return;
			}
			await this.enableRemoteAccessCore('command', generation, true);
		});
	}

	private runSetup(source: SetupSource): Promise<void> {
		return this.runConnectionOperation(async generation => {
			const initialSetup = await this.contribution.getStoredConnectionReadiness(this.getConsentScope().fingerprint) === 'missing-token';
			await this.runSetupCore(source, generation, initialSetup);
		});
	}

	private runConnectionOperation(operation: (generation: number) => Promise<void>): Promise<void> {
		const existing = this.connectionOperation;
		if (existing) {
			if (existing.generation === this.lifecycleGeneration) {
				return existing.promise;
			}
			return existing.promise.catch(() => { }).then(() => this.runConnectionOperation(operation));
		}
		const generation = ++this.lifecycleGeneration;
		const promise = operation(generation).finally(() => {
			if (this.connectionOperation?.promise === promise) {
				this.connectionOperation = undefined;
			}
			this.refreshCommandContexts();
		});
		this.connectionOperation = { generation, promise };
		return promise;
	}

	private async runSetupCore(source: SetupSource, generation: number, initialSetup: boolean, forceLeaseTakeover = false): Promise<void> {
		const scope = this.getConsentScope();
		const accepted = await this.requestConsent(scope);
		if (generation !== this.lifecycleGeneration) {
			return;
		}
		if (!accepted) {
			await this.cancelSetup(initialSetup, undefined, false);
			return;
		}

		const storedToken = source === 'command' ? undefined : await this.contribution.authorization.getBotToken();
		const botToken = storedToken ?? await this.promptForBotToken();
		if (generation !== this.lifecycleGeneration) {
			return;
		}
		if (!botToken) {
			await this.cancelSetup(initialSetup, undefined, false);
			return;
		}
		const stagedTokenFingerprint = getTelegramBotTokenFingerprint(botToken);

		try {
			await this.contribution.disableRemoteAccess();
			const result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: l10n.t('Validating the Telegram bot token...'),
				cancellable: false,
			}, () => this.contribution.startPairing(botToken, scope.fingerprint, this.getPollingOptions(forceLeaseTakeover)));
			if (generation !== this.lifecycleGeneration) {
				await this.cancelSetup(initialSetup, stagedTokenFingerprint, false);
				return;
			}
			if (!await this.presentPairingChallenge(result.challenge)) {
				await this.cancelSetup(initialSetup, stagedTokenFingerprint, false);
				return;
			}
			const identity = await this.waitForPairing(result.challenge);
			if (generation !== this.lifecycleGeneration) {
				await this.cancelSetup(initialSetup, stagedTokenFingerprint, false);
				return;
			}
			if (!identity) {
				await this.cancelSetup(initialSetup, stagedTokenFingerprint, false);
				return;
			}
			await this.completePairingSetup(result.bot, identity);
		} catch (error) {
			await this.cancelSetup(initialSetup, stagedTokenFingerprint, false);
			this.logService.error('[TelegramRemote] Setup failed; credential details were suppressed.');
			await vscode.window.showErrorMessage(getTelegramSetupErrorMessage(error));
		}
	}

	private async authorizeCurrentWorkspace(scope: TelegramConsentScope, generation: number, forceLeaseTakeover = false): Promise<void> {
		this.contribution.requireWorkspaceConsent();
		await this.setConfigured(true);
		if (!await this.requestConsent(scope) || generation !== this.lifecycleGeneration) {
			await this.cancelSetup(false, undefined, true);
			return;
		}
		try {
			await this.contribution.authorizeWorkspace(scope.fingerprint);
			if (generation !== this.lifecycleGeneration) {
				await this.cancelSetup(false, undefined, true);
				return;
			}
			await this.setEnabled(true);
			const restored = await this.contribution.resumeStoredConnection(scope.fingerprint, this.getPollingOptions(forceLeaseTakeover));
			if (!restored && generation === this.lifecycleGeneration) {
				throw new TelegramBotApiError('api', 'Telegram authorization state changed during workspace recovery.');
			}
		} catch (error) {
			this.logService.error('[TelegramRemote] Workspace authorization recovery failed; credential details were suppressed.');
			await vscode.window.showErrorMessage(getTelegramSetupErrorMessage(error));
		}
	}

	private async runPairingRecovery(scope: TelegramConsentScope, generation: number, forceLeaseTakeover = false): Promise<void> {
		if (!await this.requestConsent(scope) || generation !== this.lifecycleGeneration) {
			await this.cancelSetup(false, undefined, false);
			return;
		}
		const botToken = await this.contribution.authorization.getBotToken();
		if (!botToken) {
			await this.runSetupCore('recovery', generation, true, forceLeaseTakeover);
			return;
		}
		try {
			await this.contribution.disableRemoteAccess();
			const result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: l10n.t('Validating the saved Telegram bot configuration...'),
				cancellable: false,
			}, () => this.contribution.startPairing(botToken, scope.fingerprint, this.getPollingOptions(forceLeaseTakeover)));
			if (generation !== this.lifecycleGeneration || !await this.presentPairingChallenge(result.challenge)) {
				await this.cancelSetup(false, undefined, false);
				return;
			}
			const identity = await this.waitForPairing(result.challenge);
			if (!identity || generation !== this.lifecycleGeneration) {
				await this.cancelSetup(false, undefined, false);
				this.logService.info(`[TelegramRemote] pairing=${Date.now() >= result.challenge.expiresAt ? 'expired' : 'cancelled'} configuration-preserved=true`);
				return;
			}
			await this.completePairingSetup(result.bot, identity);
		} catch (error) {
			await this.cancelSetup(false, undefined, false);
			this.logService.error('[TelegramRemote] Pairing recovery failed; credential details were suppressed.');
			await vscode.window.showErrorMessage(getTelegramSetupErrorMessage(error));
		}
	}

	private async completePairingSetup(bot: { readonly username?: string; readonly first_name: string }, identity: TelegramPairedIdentity): Promise<void> {
		await this.setEnabled(true);
		await this.setConfigured(true);
		if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
			const userLabel = identity.username ? `@${identity.username}` : identity.firstName;
			await vscode.window.showInformationMessage(l10n.t('Telegram Remote is connected to {0} and paired with {1}.', formatBotName(bot), userLabel));
		}
	}

	private async requestConsent(scope: TelegramConsentScope): Promise<boolean> {
		const enable = l10n.t('Enable Remote Access');
		const learnMore = l10n.t('Learn More');
		while (true) {
			const choice = await vscode.window.showWarningMessage(
				l10n.t('Enable Telegram remote control of Copilot?'),
				{ modal: true, detail: buildTelegramConsentDetail(scope.workstationLabel, scope.workspaceLabel, getTelegramRemoteCapabilities(this.contribution.transport)) },
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

	private async cancelSetup(initialSetup: boolean, stagedTokenFingerprint: string | undefined, needsWorkspaceConsent: boolean): Promise<void> {
		await this.setEnabled(false);
		try {
			if (initialSetup && stagedTokenFingerprint) {
				await this.contribution.rollbackFirstSetup(stagedTokenFingerprint);
				await this.setConfigured(false);
			} else {
				await this.contribution.cancelRecovery(needsWorkspaceConsent);
			}
		} catch {
			this.logService.warn('[TelegramRemote] Failed to cancel incomplete Telegram setup state cleanly.');
		}
	}

	private async testConnection(): Promise<void> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled)) {
			await vscode.window.showWarningMessage(l10n.t('Telegram Remote is disabled. Run Telegram Remote: Enable Remote Access to reconnect or start setup.'));
			return;
		}
		if (this.contribution.currentStatus.state !== 'connected') {
			await this.reconnect();
		}
		await this.showStatus();
	}

	private async startPairing(): Promise<void> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled) || !this.contribution.isAcceptingUpdates) {
			await this.enableRemoteAccess('command');
			return;
		}
		const challenge = this.contribution.beginPairing();
		if (!await this.presentPairingChallenge(challenge)) {
			await this.contribution.cancelPairingPreservingConfiguration(this.getConsentScope().fingerprint, false);
			return;
		}
		const identity = await this.waitForPairing(challenge);
		if (!identity) {
			await this.contribution.cancelPairingPreservingConfiguration(this.getConsentScope().fingerprint, Date.now() >= challenge.expiresAt);
			return;
		}
		if (this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramNotificationsEnabled)) {
			await vscode.window.showInformationMessage(l10n.t('Telegram user pairing was updated.'));
		}
	}

	private async keepDisabled(): Promise<void> {
		this.cancelLifecycle();
		await this.setEnabled(false);
		await this.contribution.cancelRecovery(true);
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
			this.contribution.authorizationState,
		));
	}

	private getConsentScope(): TelegramConsentScope {
		const environment = getTelegramRemoteEnvironment();
		return {
			fingerprint: environment.consentScopeFingerprint,
			workstationLabel: environment.workstationLabel,
			workspaceLabel: environment.workspaceLabel,
		};
	}

	private getPollingOptions(forceLeaseTakeover = false): { timeoutSeconds: number; forceLeaseTakeover: boolean } {
		return {
			timeoutSeconds: this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramPollTimeout),
			forceLeaseTakeover,
		};
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
		this.refreshCommandContexts();
	}

	private async setConfigured(configured: boolean): Promise<void> {
		if (this.configured === configured) {
			return;
		}
		await this.extensionContext.globalState.update(configuredStateKey, configured ? true : undefined);
		this.configured = configured;
		this.configuredEmitter.fire(configured);
		this.refreshCommandContexts();
	}

	private refreshCommandContexts(): void {
		const enabled = this.configurationService.getConfig(ConfigKey.Advanced.CLITelegramEnabled);
		const status = this.contribution.currentStatus;
		const needsConsent = this.contribution.authorizationState === 'needs-consent';
		const reconnectable = enabled && !needsConsent && (status.state === 'stopped'
			|| (status.state === 'failed' && status.reason !== 'authentication' && status.reason !== 'api'));
		void vscode.commands.executeCommand('setContext', configuredContextKey, this.configured);
		void vscode.commands.executeCommand('setContext', pairedContextKey, !!this.contribution.pairedIdentity);
		void vscode.commands.executeCommand('setContext', connectedContextKey, enabled && status.state === 'connected' && this.contribution.authorizationState === 'authorized');
		void vscode.commands.executeCommand('setContext', reconnectableContextKey, reconnectable);
		void vscode.commands.executeCommand('setContext', needsConsentContextKey, needsConsent);
	}

	private cancelLifecycle(): void {
		this.lifecycleGeneration++;
		this.setupCancellationEmitter.fire();
	}

	public override dispose(): void {
		this.cancelLifecycle();
		super.dispose();
	}
}

export interface TelegramRemoteCapabilities {
	readonly remotePermissionResponses: boolean;
}

export function getTelegramRemoteCapabilities(transport: IRemoteControlTransport): TelegramRemoteCapabilities {
	return { remotePermissionResponses: typeof transport.requestPermission === 'function' };
}

export function buildTelegramConsentDetail(workstationLabel: string, workspaceLabel: string, capabilities: TelegramRemoteCapabilities = { remotePermissionResponses: false }): string {
	const permissionDetail = capabilities.remotePermissionResponses
		? l10n.t('This transport can answer supported permission prompts remotely.')
		: l10n.t('Permission prompts must be answered locally in this build.');
	return l10n.t('A paired Telegram user can send Copilot prompts, steer an active Telegram-started turn, and stop Telegram-started work. Prompts can cause this machine to write files, run shell commands, access the network, and perform Git operations, subject to Copilot’s normal controls.\n\n{0}\n\nTelegram bot chats are not end-to-end encrypted. Prompts, final answers, file paths, and any activity detail enabled locally transit Telegram infrastructure.\n\nAnyone who obtains the bot token can impersonate the bot. Anyone who obtains the paired Telegram account gains this control.\n\nWorkstation exposed: {1}\nWorkspace exposed: {2}\n\nTo turn it off, select the Telegram status bar item and choose Disable Remote Access.', permissionDetail, workstationLabel, workspaceLabel);
}

export function getTelegramStatusMessage(enabled: boolean, status: TelegramPollingStatus, pairedUser: string | undefined, authorizationState: TelegramRemoteContribution['authorizationState'] = enabled ? 'authorized' : 'disabled'): string {
	if (authorizationState === 'needs-consent') {
		return l10n.t('Telegram Remote requires authorization for the current workspace. Remote prompts are blocked.');
	}
	if (authorizationState === 'pairing-only') {
		return l10n.t('Telegram Remote is waiting for the single-use pairing command. All other remote commands are blocked.');
	}
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
				return l10n.t('Telegram rejected the bot token. Saved configuration is preserved until you explicitly forget it.');
			case 'network':
			case 'rate-limit':
			case 'server':
				return l10n.t('Telegram could not be reached. Saved configuration was preserved.');
		}
	}
	return l10n.t('Telegram Remote setup failed. Saved configuration was preserved unless this was an incomplete first setup.');
}
