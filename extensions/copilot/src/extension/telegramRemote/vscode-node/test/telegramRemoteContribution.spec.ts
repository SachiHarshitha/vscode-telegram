/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import type { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { mock } from '../../../../util/common/test/simpleMock';
import { TelegramBotApiError, type TelegramUpdate, type TelegramUser } from '../../common/telegramTypes';
import { RemoteControlRegistry } from '../../node/remoteControlRegistry';
import { TestTelegramExtensionContext, telegramCallbackUpdate, telegramMessageUpdate } from '../../node/test/testTelegramSecurityState';
import { getTelegramBotTokenFingerprint } from '../../node/telegramPollerLease';
import type { TelegramValidatedHandler } from '../../node/telegramService';
import { TelegramRemoteContribution, type TelegramAuthorizedUpdate } from '../telegramRemoteContribution';

const botToken = '123456:phase3-contribution-token';
const consentScopeFingerprint = 'abcdefabcdefabcdefabcdef';
const bot: TelegramUser = { id: 42, is_bot: true, first_name: 'Phase 3 Bot', username: 'phase3_bot' };

describe('TelegramRemoteContribution', () => {
	let storageRoot: string;

	beforeEach(async () => {
		storageRoot = await mkdtemp(join(tmpdir(), 'telegram-contribution-'));
	});

	afterEach(async () => {
		await rm(storageRoot, { recursive: true, force: true });
	});

	it('registers a dormant transport and removes it on disposal', () => {
		const { contribution, registry } = createContribution(storageRoot);
		const attachment = registry.attachTransport('session-1', 'telegram');

		expect(contribution.transport.currentStatus).toEqual({ state: 'stopped' });
		expect(contribution.isAcceptingUpdates).toBe(false);
		attachment.dispose();
		contribution.dispose();
		expect(() => registry.attachTransport('session-1', 'telegram')).toThrow();
	});

	it('stores a validated token, pairs a private identity, and authenticates before dispatch', async () => {
		const { contribution, context } = createContribution(storageRoot);
		const transport = mockTransportStartup(contribution);
		const authorizedHandler = vi.fn(async (_accepted: TelegramAuthorizedUpdate) => { });
		const authorizedConnection = vi.fn();
		contribution.registerAuthorizedUpdateHandler(authorizedHandler);
		contribution.onDidAuthorizeConnection(authorizedConnection);

		const pairing = await contribution.startPairing(botToken, consentScopeFingerprint);
		expect(pairing.bot).toBe(bot);
		expect(context.secrets.values.size).toBe(1);
		expect(JSON.stringify([...context.globalState.values])).not.toContain(botToken);

		await transport.handleUpdate(telegramMessageUpdate(1, pairing.challenge.command));
		expect(contribution.authorization.pairedIdentity).toEqual(expect.objectContaining({ userId: 101, chatId: 202 }));
		expect(contribution.consent.hasCurrentConsent(getTelegramBotTokenFingerprint(botToken), consentScopeFingerprint)).toBe(true);
		expect(authorizedConnection).toHaveBeenCalledWith(expect.objectContaining({ userId: 101, chatId: 202 }));
		expect(transport.sendMessage).toHaveBeenCalledWith(202, expect.stringContaining('Pairing succeeded'));

		await transport.handleUpdate(telegramMessageUpdate(2, 'unauthorized', 999, 202));
		expect(authorizedHandler).not.toHaveBeenCalled();
		await transport.handleUpdate(telegramMessageUpdate(3, 'authorized', 101, 202, 'private', false, 'renamed'));
		expect(authorizedHandler).toHaveBeenCalledOnce();
		expect(authorizedHandler.mock.calls[0][0].identity).toEqual(expect.objectContaining({ userId: 101, chatId: 202 }));

		contribution.dispose();
	});

	it('bounds authorized message bursts before they reach the command router', async () => {
		const { contribution, logService } = createContribution(storageRoot);
		const transport = mockTransportStartup(contribution);
		const authorizedHandler = vi.fn(async (_accepted: TelegramAuthorizedUpdate) => { });
		contribution.registerAuthorizedUpdateHandler(authorizedHandler);
		const pairing = await contribution.startPairing(botToken, consentScopeFingerprint);
		await transport.handleUpdate(telegramMessageUpdate(1, pairing.challenge.command));

		for (let updateId = 2; updateId <= 22; updateId++) {
			await transport.handleUpdate(telegramMessageUpdate(updateId, '/status'));
		}

		expect(authorizedHandler).toHaveBeenCalledTimes(20);
		expect(logService.warn).toHaveBeenCalledWith('[TelegramRemote] update=rate-limited kind=message');
		contribution.dispose();
	});

	it('admits only the matching pair command while pairing is pending', async () => {
		const { contribution } = createContribution(storageRoot);
		const transport = mockTransportStartup(contribution);
		const authorizedHandler = vi.fn(async (_accepted: TelegramAuthorizedUpdate) => { });
		contribution.registerAuthorizedUpdateHandler(authorizedHandler);
		const pairing = await contribution.startPairing(botToken, consentScopeFingerprint);

		await transport.handleUpdate(telegramMessageUpdate(1, '/status'));
		await transport.handleUpdate(telegramMessageUpdate(2, '/sessions'));
		await transport.handleUpdate(telegramMessageUpdate(3, 'Run a prompt'));
		await transport.handleUpdate(telegramCallbackUpdate(4, 'tr1:opaque-callback'));

		expect({ state: contribution.authorizationState, routed: authorizedHandler.mock.calls.length, paired: contribution.pairedIdentity }).toEqual({
			state: 'pairing-only',
			routed: 0,
			paired: undefined,
		});
		await transport.handleUpdate(telegramMessageUpdate(5, pairing.challenge.command));
		expect({ state: contribution.authorizationState, routed: authorizedHandler.mock.calls.length }).toEqual({ state: 'authorized', routed: 0 });
		contribution.dispose();
	});

	it('fails pairing closed when metadata persistence fails', async () => {
		const { contribution, context, logService } = createContribution(storageRoot);
		const transport = mockTransportStartup(contribution);
		const pairing = await contribution.startPairing(botToken, consentScopeFingerprint);
		context.globalState.update = vi.fn(async () => { throw new Error('storage failed'); });

		await transport.handleUpdate(telegramMessageUpdate(1, pairing.challenge.command));

		expect(contribution.authorization.pairedIdentity).toBeUndefined();
		expect(logService.error).toHaveBeenCalledWith('[TelegramRemote] Failed to persist Telegram pairing state.');
		expect(transport.sendMessage).toHaveBeenCalledWith(202, expect.stringContaining('Pairing failed'));
		contribution.dispose();
	});

	it('does not restore networking without active consent for the exact workspace scope', async () => {
		const { contribution } = createContribution(storageRoot);
		const tokenFingerprint = await contribution.authorization.storeBotToken(botToken);
		await contribution.consent.begin(tokenFingerprint, '111111111111111111111111');
		await contribution.consent.commit(tokenFingerprint);
		const start = vi.spyOn(contribution.transport, 'start');

		await expect(contribution.resumeStoredConnection(consentScopeFingerprint)).resolves.toBeUndefined();
		expect(start).not.toHaveBeenCalled();

		await contribution.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await contribution.consent.commit(tokenFingerprint);
		await contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, tokenFingerprint);
		mockTransportStartup(contribution);
		await expect(contribution.resumeStoredConnection(consentScopeFingerprint)).resolves.toBe(bot);
		contribution.dispose();
	});

	it('requires token, exact consent, and token-bound pairing before stored reconnection', async () => {
		const { contribution, context } = createContribution(storageRoot);
		expect(await contribution.getStoredConnectionReadiness(consentScopeFingerprint)).toBe('missing-token');

		const tokenFingerprint = await contribution.authorization.storeBotToken(botToken);
		expect(await contribution.getStoredConnectionReadiness(consentScopeFingerprint)).toBe('missing-pairing');
		await contribution.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await contribution.consent.commit(tokenFingerprint);
		expect(await contribution.getStoredConnectionReadiness(consentScopeFingerprint)).toBe('missing-pairing');
		await contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, tokenFingerprint);
		expect(await contribution.getStoredConnectionReadiness(consentScopeFingerprint)).toBe('ready');
		expect(await contribution.getStoredConnectionReadiness('111111111111111111111111')).toBe('needs-workspace-consent');

		const tokenKey = [...context.secrets.values.keys()][0];
		context.secrets.values.set(tokenKey, '654321:replacement-token');
		expect(await contribution.getStoredConnectionReadiness(consentScopeFingerprint)).toBe('missing-pairing');
		contribution.dispose();
	});

	it('blocks workspace A commands in workspace B and reuses the token and paired user after local consent', async () => {
		const { contribution } = createContribution(storageRoot);
		const tokenFingerprint = await contribution.authorization.storeBotToken(botToken);
		await contribution.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await contribution.consent.commit(tokenFingerprint);
		await contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, tokenFingerprint);
		const originalIdentity = contribution.pairedIdentity;
		const transport = mockTransportStartup(contribution);
		const pairingBegin = vi.spyOn(contribution.pairing, 'begin');
		const authorizedHandler = vi.fn(async (_accepted: TelegramAuthorizedUpdate) => { });
		contribution.registerAuthorizedUpdateHandler(authorizedHandler);
		await contribution.resumeStoredConnection(consentScopeFingerprint);

		const workspaceB = '111111111111111111111111';
		contribution.requireWorkspaceConsent('workspace-changed');
		await transport.handleUpdate(telegramMessageUpdate(1, '/status'));
		expect({ state: contribution.authorizationState, routed: authorizedHandler.mock.calls.length }).toEqual({ state: 'needs-consent', routed: 0 });

		await contribution.authorizeWorkspace(workspaceB);
		await contribution.resumeStoredConnection(workspaceB);
		expect({
			state: contribution.authorizationState,
			readiness: await contribution.getStoredConnectionReadiness(workspaceB),
			identity: contribution.pairedIdentity,
			token: await contribution.authorization.getBotToken(),
			pairingChallenges: pairingBegin.mock.calls.length,
		}).toEqual({ state: 'authorized', readiness: 'ready', identity: originalIdentity, token: botToken, pairingChallenges: 0 });
		contribution.dispose();
	});

	it('preserves saved credentials and pairing when a re-pair challenge expires', async () => {
		const { contribution, logService } = createContribution(storageRoot);
		const tokenFingerprint = await contribution.authorization.storeBotToken(botToken);
		await contribution.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await contribution.consent.commit(tokenFingerprint);
		await contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, tokenFingerprint);
		const originalIdentity = contribution.pairedIdentity;
		mockTransportStartup(contribution);
		await contribution.resumeStoredConnection(consentScopeFingerprint);
		contribution.beginPairing();

		await contribution.cancelPairingPreservingConfiguration(consentScopeFingerprint, true);

		expect({
			readiness: await contribution.getStoredConnectionReadiness(consentScopeFingerprint),
			identity: contribution.pairedIdentity,
			token: await contribution.authorization.getBotToken(),
		}).toEqual({ readiness: 'ready', identity: originalIdentity, token: botToken });
		expect(logService.info).toHaveBeenCalledWith('[TelegramRemote] pairing=expired configuration-preserved=true');
		contribution.dispose();
	});

	it('reuses stored credentials after disable and deduplicates concurrent enable attempts', async () => {
		const { contribution } = createContribution(storageRoot);
		const tokenFingerprint = await contribution.authorization.storeBotToken(botToken);
		await contribution.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await contribution.consent.commit(tokenFingerprint);
		await contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, tokenFingerprint);
		const transport = mockTransportStartup(contribution);
		const discardPending = vi.spyOn(contribution.transport, 'discardPendingUpdatesOnNextStart');

		const [first, duplicate] = await Promise.all([
			contribution.resumeStoredConnection(consentScopeFingerprint),
			contribution.resumeStoredConnection(consentScopeFingerprint),
		]);
		expect({ first, duplicate, starts: transport.start.mock.calls.length }).toEqual({ first: bot, duplicate: bot, starts: 1 });
		await contribution.disableRemoteAccess();
		expect(discardPending).toHaveBeenCalledWith(botToken);
		await expect(contribution.resumeStoredConnection(consentScopeFingerprint)).resolves.toBe(bot);
		expect(transport.start).toHaveBeenCalledTimes(2);
		contribution.dispose();
	});

	it('restores after reload and can retry a failed stored reconnection without replacing the token', async () => {
		const first = createContribution(storageRoot);
		const tokenFingerprint = await first.contribution.authorization.storeBotToken(botToken);
		await first.contribution.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await first.contribution.consent.commit(tokenFingerprint);
		await first.contribution.authorization.pair({ userId: 101, chatId: 202, firstName: 'Operator' }, tokenFingerprint);
		first.contribution.dispose();

		const reloaded = createContribution(storageRoot, first.context);
		const start = vi.spyOn(reloaded.contribution.transport, 'start');
		vi.spyOn(reloaded.contribution.transport, 'stop').mockResolvedValue();
		start.mockRejectedValueOnce(new TelegramBotApiError('network', 'Offline.'));
		await expect(reloaded.contribution.resumeStoredConnection(consentScopeFingerprint)).rejects.toMatchObject({ kind: 'network' });
		expect(await reloaded.contribution.getStoredConnectionReadiness(consentScopeFingerprint)).toBe('ready');
		start.mockImplementation(async (_token, _handler, validatedHandler?: TelegramValidatedHandler) => {
			await validatedHandler?.(bot);
			return bot;
		});
		await expect(reloaded.contribution.resumeStoredConnection(consentScopeFingerprint)).resolves.toBe(bot);
		expect(start).toHaveBeenCalledTimes(2);
		reloaded.contribution.dispose();
	});

	it('authorizes opaque callbacks and invalidates them synchronously on disable or revoke', async () => {
		const { contribution } = createContribution(storageRoot);
		const transport = mockTransportStartup(contribution);
		const pairing = await contribution.startPairing(botToken, consentScopeFingerprint);
		await transport.handleUpdate(telegramMessageUpdate(1, pairing.challenge.command));
		const identity = contribution.authorization.pairedIdentity!;
		const first = contribution.registerCallback({
			identity,
			sessionId: 'session-1',
			requestId: 'request-1',
			action: 'permission.approveOnce',
		});

		expect(contribution.consumeCallback(telegramCallbackUpdate(2, first.callbackData, 999, 202))).toBeUndefined();
		expect(contribution.consumeCallback(telegramCallbackUpdate(3, first.callbackData), { sessionId: 'session-1' })).toEqual(expect.objectContaining({ requestId: 'request-1' }));
		const second = contribution.registerCallback({
			identity,
			sessionId: 'session-1',
			requestId: 'request-2',
			action: 'permission.deny',
		});

		const disable = contribution.disableRemoteAccess();
		expect(contribution.isAcceptingUpdates).toBe(false);
		expect(contribution.consumeCallback(telegramCallbackUpdate(4, second.callbackData))).toBeUndefined();
		await disable;
		expect(transport.stop).toHaveBeenCalled();
		expect(() => contribution.registerCallback({
			identity,
			sessionId: 'session-1',
			requestId: 'request-disabled',
			action: 'permission.deny',
		})).toThrow('active paired identity');

		const resumed = await contribution.startPairing(botToken, consentScopeFingerprint);
		await transport.handleUpdate(telegramMessageUpdate(5, resumed.challenge.command));
		const third = contribution.registerCallback({
			identity: contribution.authorization.pairedIdentity!,
			sessionId: 'session-1',
			requestId: 'request-3',
			action: 'permission.deny',
		});
		await contribution.revokePairing();
		expect(contribution.consumeCallback(telegramCallbackUpdate(6, third.callbackData))).toBeUndefined();
		expect(contribution.authorization.pairedIdentity).toBeUndefined();
		contribution.dispose();
	});

	it('waits for an in-progress startup to release its resources before disable completes', async () => {
		const { contribution } = createContribution(storageRoot);
		let rejectStartup!: (error: Error) => void;
		vi.spyOn(contribution.transport, 'start').mockImplementation(() => new Promise((_resolve, reject) => rejectStartup = reject));
		vi.spyOn(contribution.transport, 'stop').mockResolvedValue();
		const startup = contribution.startPairing(botToken, consentScopeFingerprint);
		await vi.waitFor(() => expect(rejectStartup).toBeTypeOf('function'));
		let disableCompleted = false;
		const disabling = contribution.disableRemoteAccess().then(() => disableCompleted = true);

		expect(disableCompleted).toBe(false);
		rejectStartup(new TelegramBotApiError('aborted', 'Cancelled.'));
		await expect(startup).rejects.toMatchObject({ kind: 'aborted' });
		await disabling;
		expect(disableCompleted).toBe(true);
		contribution.dispose();
	});

	it('blocks dispatch and clears attachments before offline cleanup can fail', async () => {
		const { contribution, registry } = createContribution(storageRoot);
		const transport = mockTransportStartup(contribution);
		const pairing = await contribution.startPairing(botToken, consentScopeFingerprint);
		await transport.handleUpdate(telegramMessageUpdate(1, pairing.challenge.command));
		registry.attachTransport('session-1', 'telegram');
		transport.stop.mockRejectedValueOnce(new TelegramBotApiError('network', 'Offline.'));
		const blocked = vi.fn();
		contribution.onDidBlockRemoteAccess(blocked);

		const disabling = contribution.disableRemoteAccess();
		expect({
			acceptingUpdates: contribution.isAcceptingUpdates,
			attachments: registry.getAttachedSessionIds('telegram'),
			callbacks: contribution.callbacks.size,
		}).toEqual({ acceptingUpdates: false, attachments: [], callbacks: 0 });
		expect(blocked).toHaveBeenCalledOnce();
		await expect(disabling).rejects.toMatchObject({ kind: 'network' });
		contribution.dispose();
	});
});

function createContribution(storageRoot: string, existingContext?: TestTelegramExtensionContext): {
	readonly contribution: TelegramRemoteContribution;
	readonly context: TestTelegramExtensionContext;
	readonly registry: RemoteControlRegistry;
	readonly logService: ILogService & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
} {
	const logService = new class extends mock<ILogService>() {
		override error = vi.fn();
		override warn = vi.fn();
		override info = vi.fn();
	};
	const registry = new RemoteControlRegistry(logService);
	const context = existingContext ?? new TestTelegramExtensionContext(storageRoot);
	const contribution = new TelegramRemoteContribution(
		{ record: vi.fn(), show: vi.fn(), copyReport: vi.fn(async () => { }) },
		context,
		registry,
		new class extends mock<IFetcherService>() { },
		logService,
	);
	return { contribution, context, registry, logService };
}

function mockTransportStartup(contribution: TelegramRemoteContribution): {
	readonly handleUpdate: (update: TelegramUpdate) => Promise<void>;
	readonly sendMessage: ReturnType<typeof vi.fn>;
	readonly stop: ReturnType<typeof vi.fn>;
	readonly start: ReturnType<typeof vi.fn>;
} {
	let handleUpdate: ((update: TelegramUpdate) => Promise<void>) | undefined;
	const sendMessage = vi.spyOn(contribution.transport, 'sendMessage').mockResolvedValue({ message_id: 1, date: 1, chat: { id: 202, type: 'private' } });
	const stop = vi.spyOn(contribution.transport, 'stop').mockResolvedValue();
	const start = vi.spyOn(contribution.transport, 'start').mockImplementation(async (_token, updateHandler, validatedHandler?: TelegramValidatedHandler) => {
		handleUpdate = updateHandler;
		await validatedHandler?.(bot);
		return bot;
	});
	return {
		handleUpdate: update => handleUpdate ? handleUpdate(update) : Promise.reject(new Error('Transport has not started.')),
		sendMessage,
		stop,
		start,
	};
}
