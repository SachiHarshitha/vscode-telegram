/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeHost = vi.hoisted(() => {
	const commandHandlers = new Map<string, () => Promise<unknown>>();
	return {
		commandHandlers,
		workspaceFolders: [{ uri: { fsPath: 'C:\\workspace', toString: () => 'file:///c:/workspace' } }] as Array<{ uri: { fsPath: string; toString(): string } }>,
		registerCommand: vi.fn((command: string, handler: () => Promise<unknown>) => {
			commandHandlers.set(command, handler);
			return { dispose: () => commandHandlers.delete(command) };
		}),
		executeCommand: vi.fn(async () => undefined),
		showWarningMessage: vi.fn(async () => undefined as string | undefined),
		showInformationMessage: vi.fn(async () => undefined as string | undefined),
		showErrorMessage: vi.fn(async () => undefined as string | undefined),
		showInputBox: vi.fn(async () => undefined as string | undefined),
	};
});

vi.mock('vscode', () => ({
	commands: {
		registerCommand: vscodeHost.registerCommand,
		executeCommand: vscodeHost.executeCommand,
	},
	window: {
		showWarningMessage: vscodeHost.showWarningMessage,
		showInformationMessage: vscodeHost.showInformationMessage,
		showErrorMessage: vscodeHost.showErrorMessage,
		showInputBox: vscodeHost.showInputBox,
		withProgress: async (_options: unknown, task: (progress: unknown, token: { onCancellationRequested: () => { dispose(): void } }) => Promise<unknown>) => task({}, { onCancellationRequested: () => ({ dispose() { } }) }),
	},
	env: {
		machineId: 'telegram-test-machine',
		clipboard: { writeText: vi.fn(async () => undefined) },
	},
	workspace: {
		workspaceFile: undefined,
		get workspaceFolders() { return vscodeHost.workspaceFolders; },
	},
	Uri: {
		joinPath: (...parts: Array<{ toString(): string } | string>) => ({ toString: () => parts.map(part => part.toString()).join('/') }),
	},
	ProgressLocation: { Notification: 15 },
}));

import { ConfigKey, type IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import type { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import type { ILogService } from '../../../../platform/log/common/logService';
import type { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { mock } from '../../../../util/common/test/simpleMock';
import { Emitter } from '../../../../util/vs/base/common/event';
import { TelegramBotApiError, type TelegramUser } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../../node/remoteControlRegistry';
import { getTelegramBotTokenFingerprint } from '../../node/telegramPollerLease';
import type { TelegramValidatedHandler } from '../../node/telegramService';
import { TestTelegramExtensionContext } from '../../node/test/testTelegramSecurityState';
import { getTelegramRemoteEnvironment } from '../telegramRemoteEnvironment';
import { TelegramRemoteContribution } from '../telegramRemoteContribution';
import { TelegramRemoteCommand, TelegramSetupWizard } from '../telegramSetupWizard';

const botToken = '123456:lifecycle-test-token';
const bot: TelegramUser = { id: 42, is_bot: true, first_name: 'Lifecycle Bot' };

describe('TelegramSetupWizard lifecycle', () => {
	let storageRoot: string;

	beforeEach(async () => {
		storageRoot = await mkdtemp(join(tmpdir(), 'telegram-lifecycle-'));
		vscodeHost.commandHandlers.clear();
		vi.clearAllMocks();
		vscodeHost.showWarningMessage.mockResolvedValue(undefined);
		vscodeHost.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace', toString: () => 'file:///c:/workspace' } }];
	});

	afterEach(async () => {
		await rm(storageRoot, { recursive: true, force: true });
	});

	it('reuses stored credentials across disable, reload, and enable without requesting the token', async () => {
		const context = new TestTelegramExtensionContext(storageRoot);
		const configuration = createConfiguration(false);
		const first = createContribution(context);
		await seedReadyConnection(first.contribution);
		const firstTransport = mockTransportStartup(first.contribution);
		const firstWizard = new TelegramSetupWizard(first.contribution, createDiagnostics(), configuration.service, context, first.logService);
		await vi.waitFor(() => expect(firstWizard.isConfigured).toBe(true));

		await invoke(TelegramRemoteCommand.Enable);
		expect({ enabled: configuration.enabled, starts: firstTransport.start.mock.calls.length, tokenPrompts: vscodeHost.showInputBox.mock.calls.length }).toEqual({ enabled: true, starts: 1, tokenPrompts: 0 });
		await invoke(TelegramRemoteCommand.Disable);
		expect({ enabled: configuration.enabled, accepting: first.contribution.isAcceptingUpdates }).toEqual({ enabled: false, accepting: false });
		firstWizard.dispose();
		first.contribution.dispose();

		const reloaded = createContribution(context);
		const reloadedTransport = mockTransportStartup(reloaded.contribution);
		const reloadedWizard = new TelegramSetupWizard(reloaded.contribution, createDiagnostics(), configuration.service, context, reloaded.logService);
		expect(reloadedWizard.isConfigured).toBe(true);
		await invoke(TelegramRemoteCommand.Enable);
		expect({ enabled: configuration.enabled, starts: reloadedTransport.start.mock.calls.length, tokenPrompts: vscodeHost.showInputBox.mock.calls.length }).toEqual({ enabled: true, starts: 1, tokenPrompts: 0 });

		reloadedWizard.dispose();
		reloaded.contribution.dispose();
	});

	it('routes missing pairing through setup instead of starting a stored poller', async () => {
		const context = new TestTelegramExtensionContext(storageRoot);
		const contributionHost = createContribution(context);
		const tokenFingerprint = await contributionHost.contribution.authorization.storeBotToken(botToken);
		const scope = getTelegramRemoteEnvironment().consentScopeFingerprint;
		await contributionHost.contribution.consent.begin(tokenFingerprint, scope);
		await contributionHost.contribution.consent.commit(tokenFingerprint);
		const start = vi.spyOn(contributionHost.contribution.transport, 'start');
		const configuration = createConfiguration(false);
		const wizard = new TelegramSetupWizard(contributionHost.contribution, createDiagnostics(), configuration.service, context, contributionHost.logService);

		await invoke(TelegramRemoteCommand.Enable);
		expect({ setupDisclosure: vscodeHost.showWarningMessage.mock.calls.length, starts: start.mock.calls.length, enabled: configuration.enabled }).toEqual({ setupDisclosure: 1, starts: 0, enabled: false });

		wizard.dispose();
		contributionHost.contribution.dispose();
	});

	it('authorizes a changed workspace with the saved token and paired user without a new pairing challenge', async () => {
		const context = new TestTelegramExtensionContext(storageRoot);
		const configuration = createConfiguration(false);
		const contributionHost = createContribution(context);
		await seedReadyConnection(contributionHost.contribution);
		const originalIdentity = contributionHost.contribution.pairedIdentity;
		vscodeHost.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace-b', toString: () => 'file:///c:/workspace-b' } }];
		const transport = mockTransportStartup(contributionHost.contribution);
		vscodeHost.showWarningMessage.mockResolvedValue('Enable Remote Access');
		const wizard = new TelegramSetupWizard(contributionHost.contribution, createDiagnostics(), configuration.service, context, contributionHost.logService);
		await vi.waitFor(() => expect(contributionHost.contribution.authorizationState).toBe('needs-consent'));

		await invoke(TelegramRemoteCommand.Enable);

		expect({
			enabled: configuration.enabled,
			state: contributionHost.contribution.authorizationState,
			identity: contributionHost.contribution.pairedIdentity,
			starts: transport.start.mock.calls.length,
			tokenPrompts: vscodeHost.showInputBox.mock.calls.length,
			pairingDialogs: vscodeHost.showInformationMessage.mock.calls.filter(call => (call as unknown[])[0] === 'Pair Telegram Remote').length,
		}).toEqual({ enabled: true, state: 'authorized', identity: originalIdentity, starts: 1, tokenPrompts: 0, pairingDialogs: 0 });

		wizard.dispose();
		contributionHost.contribution.dispose();
	});

	it('reconnects after a recoverable failure with the same stored token', async () => {
		const context = new TestTelegramExtensionContext(storageRoot);
		const configuration = createConfiguration(false);
		const contributionHost = createContribution(context);
		await seedReadyConnection(contributionHost.contribution);
		vi.spyOn(contributionHost.contribution.transport, 'stop').mockResolvedValue();
		const start = vi.spyOn(contributionHost.contribution.transport, 'start');
		start.mockRejectedValueOnce(new TelegramBotApiError('network', 'Offline.'));
		const wizard = new TelegramSetupWizard(contributionHost.contribution, createDiagnostics(), configuration.service, context, contributionHost.logService);
		await vi.waitFor(() => expect(wizard.isConfigured).toBe(true));

		await invoke(TelegramRemoteCommand.Enable);
		expect({ enabledAfterFailure: configuration.enabled, accepting: contributionHost.contribution.isAcceptingUpdates }).toEqual({ enabledAfterFailure: true, accepting: false });
		start.mockImplementation(async (_token, _handler, validatedHandler?: TelegramValidatedHandler) => {
			await validatedHandler?.(bot);
			return bot;
		});
		await invoke(TelegramRemoteCommand.Reconnect);
		expect({ starts: start.mock.calls.length, accepting: contributionHost.contribution.isAcceptingUpdates, tokenPrompts: vscodeHost.showInputBox.mock.calls.length }).toEqual({ starts: 2, accepting: true, tokenPrompts: 0 });

		wizard.dispose();
		contributionHost.contribution.dispose();
	});

	it('deduplicates concurrent enable/setup commands and disable prevents cancelled startup revival', async () => {
		const context = new TestTelegramExtensionContext(storageRoot);
		const configuration = createConfiguration(false);
		const contributionHost = createContribution(context);
		await seedReadyConnection(contributionHost.contribution);
		let finishStart!: () => void;
		vi.spyOn(contributionHost.contribution.transport, 'stop').mockResolvedValue();
		const start = vi.spyOn(contributionHost.contribution.transport, 'start').mockImplementation(async (_token, _handler, validatedHandler?: TelegramValidatedHandler) => {
			await validatedHandler?.(bot);
			await new Promise<void>(resolve => finishStart = resolve);
			return bot;
		});
		const wizard = new TelegramSetupWizard(contributionHost.contribution, createDiagnostics(), configuration.service, context, contributionHost.logService);
		await vi.waitFor(() => expect(wizard.isConfigured).toBe(true));

		const enable = invoke(TelegramRemoteCommand.Enable);
		const duplicateEnable = invoke(TelegramRemoteCommand.Enable);
		const concurrentSetup = invoke(TelegramRemoteCommand.Setup);
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
		const disable = invoke(TelegramRemoteCommand.Disable);
		expect(configuration.enabled).toBe(false);
		finishStart();
		await Promise.all([enable, duplicateEnable, concurrentSetup, disable]);
		expect({ starts: start.mock.calls.length, enabled: configuration.enabled, accepting: contributionHost.contribution.isAcceptingUpdates }).toEqual({ starts: 1, enabled: false, accepting: false });

		wizard.dispose();
		contributionHost.contribution.dispose();
	});
});

function createConfiguration(initialEnabled: boolean): { readonly service: IConfigurationService; get enabled(): boolean } {
	const values = new Map<string, unknown>([
		[ConfigKey.Advanced.CLITelegramEnabled.fullyQualifiedId, initialEnabled],
		[ConfigKey.Advanced.CLITelegramNotificationsEnabled.fullyQualifiedId, false],
		[ConfigKey.Advanced.CLITelegramPollTimeout.fullyQualifiedId, 1],
	]);
	const emitter = new Emitter<{ affectsConfiguration(section: string): boolean }>();
	const service = {
		_serviceBrand: undefined,
		onDidChangeConfiguration: emitter.event,
		getConfig: <T>(key: { readonly fullyQualifiedId: string; readonly defaultValue: T }): T => (values.has(key.fullyQualifiedId) ? values.get(key.fullyQualifiedId) : key.defaultValue) as T,
		setConfig: async <T>(key: { readonly fullyQualifiedId: string }, value: T): Promise<void> => {
			values.set(key.fullyQualifiedId, value);
			emitter.fire({ affectsConfiguration: section => section === key.fullyQualifiedId });
		},
	} as unknown as IConfigurationService;
	return { service, get enabled() { return values.get(ConfigKey.Advanced.CLITelegramEnabled.fullyQualifiedId) === true; } };
}

function createContribution(context: TestTelegramExtensionContext): {
	readonly contribution: TelegramRemoteContribution;
	readonly logService: ILogService & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
} {
	const logService = new class extends mock<ILogService>() {
		override error = vi.fn();
		override warn = vi.fn();
		override info = vi.fn();
	};
	const registry = new RemoteControlRegistry(logService);
	const contribution = new TelegramRemoteContribution(
		{ record: vi.fn(), show: vi.fn(), copyReport: vi.fn(async () => { }) },
		context as IVSCodeExtensionContext,
		registry,
		new class extends mock<IFetcherService>() { },
		logService,
	);
	return { contribution, logService };
}

async function seedReadyConnection(contribution: TelegramRemoteContribution): Promise<void> {
	const tokenFingerprint = await contribution.authorization.storeBotToken(botToken);
	const scope = getTelegramRemoteEnvironment().consentScopeFingerprint;
	await contribution.consent.begin(tokenFingerprint, scope);
	await contribution.consent.commit(tokenFingerprint);
	await contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, getTelegramBotTokenFingerprint(botToken));
}

function mockTransportStartup(contribution: TelegramRemoteContribution): { readonly start: ReturnType<typeof vi.fn> } {
	vi.spyOn(contribution.transport, 'stop').mockResolvedValue();
	const start = vi.spyOn(contribution.transport, 'start').mockImplementation(async (_token, _handler, validatedHandler?: TelegramValidatedHandler) => {
		await validatedHandler?.(bot);
		return bot;
	});
	return { start };
}

async function invoke(command: string): Promise<void> {
	const handler = vscodeHost.commandHandlers.get(command);
	if (!handler) {
		throw new Error(`Command was not registered: ${command}`);
	}
	await handler();
}

function createDiagnostics() {
	return { record: vi.fn(), show: vi.fn(), copyReport: vi.fn(async () => { }) };
}
