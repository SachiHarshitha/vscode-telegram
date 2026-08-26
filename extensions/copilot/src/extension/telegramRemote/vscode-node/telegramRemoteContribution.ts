/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { IRemoteControlRegistry } from '../../remoteControl/common/remoteControlTypes';
import { TelegramAnswerCallbackQueryOptions, TelegramBotApiError, TelegramEditMessageTextOptions, TelegramEditRichMessageOptions, TelegramInputRichMessage, TelegramMessage, TelegramPollingStatus, TelegramSendMessageOptions, TelegramSendRichMessageOptions, TelegramUpdate, TelegramUser, validateTelegramBotToken } from '../common/telegramTypes';
import { TelegramAuthorization, TelegramPairedIdentity } from '../node/telegramAuthorization';
import { TelegramCallbackConstraints, TelegramCallbackContext, TelegramCallbackInput, TelegramCallbackRegistration, TelegramCallbackRegistry } from '../node/telegramCallbackRegistry';
import { TelegramConsent } from '../node/telegramConsent';
import { TelegramPairingChallenge, TelegramPairingResult, TelegramPairingService } from '../node/telegramPairingService';
import { TelegramUpdateRateLimiter } from '../node/telegramUpdateRateLimiter';
import { getTelegramBotTokenFingerprint } from '../node/telegramPollerLease';
import type { TelegramPollingOptions } from '../node/telegramService';
import { TelegramTransport } from '../node/telegramTransport';
import type { ITelegramRemoteDiagnostics } from './telegramRemoteDiagnostics';

export interface TelegramPairingStartResult {
	readonly bot: TelegramUser;
	readonly challenge: TelegramPairingChallenge;
}

export interface TelegramAuthorizedUpdate {
	readonly update: TelegramUpdate;
	readonly identity: TelegramPairedIdentity;
}

export type TelegramAuthorizedUpdateHandler = (accepted: TelegramAuthorizedUpdate) => Promise<void>;

export type TelegramStoredConnectionReadiness = 'ready' | 'missing-token' | 'missing-pairing' | 'needs-workspace-consent';
export type TelegramRemoteAuthorizationState = 'disabled' | 'needs-consent' | 'pairing-only' | 'authorized';

/** Composes the dormant transport with the Phase 3 secure-state and authorization boundary. */
export class TelegramRemoteContribution extends Disposable {
	private readonly pairingCompletedEmitter = this._register(new Emitter<TelegramPairedIdentity>());
	readonly onDidCompletePairing: Event<TelegramPairedIdentity> = this.pairingCompletedEmitter.event;
	private readonly authorizedConnectionEmitter = this._register(new Emitter<TelegramPairedIdentity>());
	readonly onDidAuthorizeConnection: Event<TelegramPairedIdentity> = this.authorizedConnectionEmitter.event;
	private readonly blockedEmitter = this._register(new Emitter<void>());
	readonly onDidBlockRemoteAccess: Event<void> = this.blockedEmitter.event;
	private readonly authorizationStateEmitter = this._register(new Emitter<TelegramRemoteAuthorizationState>());
	readonly onDidChangeAuthorizationState: Event<TelegramRemoteAuthorizationState> = this.authorizationStateEmitter.event;

	readonly transport: TelegramTransport;
	readonly authorization: TelegramAuthorization;
	readonly consent: TelegramConsent;
	readonly pairing = new TelegramPairingService();
	readonly callbacks = new TelegramCallbackRegistry();
	private readonly updateRateLimiter = new TelegramUpdateRateLimiter();

	private lifecycleGeneration = 0;
	private authorizationStateValue: TelegramRemoteAuthorizationState = 'disabled';
	private startInProgress = false;
	private startCompletion: Promise<void> | undefined;
	private resumeOperation: { readonly scopeFingerprint: string; readonly promise: Promise<TelegramUser | undefined> } | undefined;
	private tokenFingerprint: string | undefined;
	private authorizedUpdateHandler: TelegramAuthorizedUpdateHandler | undefined;

	constructor(
		private readonly diagnostics: ITelegramRemoteDiagnostics,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IRemoteControlRegistry private readonly registry: IRemoteControlRegistry,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.authorization = this._register(new TelegramAuthorization(extensionContext));
		this.consent = new TelegramConsent(extensionContext);
		this.transport = this._register(new TelegramTransport(extensionContext.globalStorageUri.fsPath, registry, fetcherService, logService));
		this._register(this.transport.onDidChangeStatus(status => {
			this.diagnostics.record('polling-state', {
				state: status.state,
				reason: status.state === 'failed' || status.state === 'retrying' ? status.reason : undefined,
			});
			if (status.state === 'failed' && (this.authorizationStateValue === 'authorized' || this.authorizationStateValue === 'pairing-only')) {
				this.blockIncomingUpdates('disabled', `connection-failed-${status.reason}`);
				this.registry.suspendTransport(this.transport.id);
			}
		}));
	}

	get currentStatus(): TelegramPollingStatus {
		return this.transport.currentStatus;
	}

	get isAcceptingUpdates(): boolean {
		return this.authorizationStateValue === 'authorized';
	}

	get authorizationState(): TelegramRemoteAuthorizationState {
		return this.authorizationStateValue;
	}

	get pairedIdentity(): TelegramPairedIdentity | undefined {
		return this.authorization.pairedIdentity;
	}

	get onDidChangePairedIdentity(): Event<TelegramPairedIdentity | undefined> {
		return this.authorization.onDidChangePairedIdentity;
	}

	/** Starts validation and polling only after a versioned consent record is durable. */
	async startPairing(botToken: string, consentScopeFingerprint: string, pollingOptions?: TelegramPollingOptions): Promise<TelegramPairingStartResult> {
		validateTelegramBotToken(botToken);
		const expectedTokenFingerprint = getTelegramBotTokenFingerprint(botToken);
		let challenge: TelegramPairingChallenge | undefined;
		let bot: TelegramUser;
		try {
			bot = await this.startConnection(botToken, async () => {
				const tokenFingerprint = await this.authorization.storeBotToken(botToken);
				if (tokenFingerprint !== expectedTokenFingerprint) {
					throw new TelegramBotApiError('api', 'Telegram credential validation failed.');
				}
				this.tokenFingerprint = tokenFingerprint;
				challenge = this.pairing.begin(tokenFingerprint);
				this.transitionAuthorizationState('pairing-only', 'awaiting-pair-command');
			}, pollingOptions, () => this.consent.begin(expectedTokenFingerprint, consentScopeFingerprint));
		} catch (error) {
			await this.consent.revokePending().catch(() => {
				this.logService.warn('[TelegramRemote] Failed to clear incomplete Telegram consent state.');
			});
			throw error;
		}
		if (!challenge) {
			throw new TelegramBotApiError('api', 'Telegram pairing startup failed.');
		}
		return { bot, challenge };
	}

	/** Restores a connection only when its token and exact machine/workspace scope still have current consent. */
	getStoredConnectionReadiness(consentScopeFingerprint: string): Promise<TelegramStoredConnectionReadiness> {
		return this.resolveStoredConnection(consentScopeFingerprint).then(result => result.readiness);
	}

	resumeStoredConnection(consentScopeFingerprint: string, pollingOptions?: TelegramPollingOptions): Promise<TelegramUser | undefined> {
		const existing = this.resumeOperation;
		if (existing) {
			return existing.scopeFingerprint === consentScopeFingerprint ? existing.promise : Promise.resolve(undefined);
		}
		const promise = this.resumeStoredConnectionCore(consentScopeFingerprint, pollingOptions).finally(() => {
			if (this.resumeOperation?.promise === promise) {
				this.resumeOperation = undefined;
			}
		});
		this.resumeOperation = { scopeFingerprint: consentScopeFingerprint, promise };
		return promise;
	}

	private async resumeStoredConnectionCore(consentScopeFingerprint: string, pollingOptions?: TelegramPollingOptions): Promise<TelegramUser | undefined> {
		const requestedGeneration = this.lifecycleGeneration;
		const stored = await this.resolveStoredConnection(consentScopeFingerprint);
		if (stored.readiness !== 'ready' || !stored.botToken || requestedGeneration !== this.lifecycleGeneration) {
			return undefined;
		}
		const botToken = stored.botToken;
		return this.startConnection(botToken, async () => {
			const tokenFingerprint = await this.authorization.storeBotToken(botToken);
			if (!this.consent.hasCurrentConsent(tokenFingerprint, consentScopeFingerprint)
				|| !this.authorization.hasPairedIdentityForToken(tokenFingerprint)) {
				throw new TelegramBotApiError('api', 'Telegram authorization state changed during reconnection.');
			}
			this.tokenFingerprint = tokenFingerprint;
			this.transitionAuthorizationState('authorized', 'stored-configuration-validated');
		}, pollingOptions);
	}

	private async resolveStoredConnection(consentScopeFingerprint: string): Promise<{ readonly readiness: TelegramStoredConnectionReadiness; readonly botToken?: string }> {
		const botToken = await this.authorization.getBotToken();
		if (!botToken) {
			return { readiness: 'missing-token' };
		}
		const tokenFingerprint = getTelegramBotTokenFingerprint(botToken);
		if (!this.authorization.hasPairedIdentityForToken(tokenFingerprint)) {
			return { readiness: 'missing-pairing' };
		}
		if (!this.consent.hasCurrentConsent(tokenFingerprint, consentScopeFingerprint)) {
			return { readiness: 'needs-workspace-consent' };
		}
		return { readiness: 'ready', botToken };
	}

	/** Enters the non-network-failure state used when the current workspace has not been approved. */
	requireWorkspaceConsent(reason = 'workspace-changed'): void {
		this.blockIncomingUpdates('needs-consent', reason);
		this.registry.suspendTransport(this.transport.id);
	}

	/** Persists local consent only after token-bound pairing has already been verified. */
	async authorizeWorkspace(consentScopeFingerprint: string): Promise<void> {
		const botToken = await this.authorization.getBotToken();
		if (!botToken) {
			throw new TelegramBotApiError('authentication', 'Telegram bot credentials are missing.');
		}
		const tokenFingerprint = getTelegramBotTokenFingerprint(botToken);
		if (!this.authorization.hasPairedIdentityForToken(tokenFingerprint)) {
			throw new TelegramBotApiError('api', 'Telegram pairing is missing.');
		}
		await this.consent.begin(tokenFingerprint, consentScopeFingerprint);
		await this.consent.commit(tokenFingerprint);
		this.logService.info('[TelegramRemote] workspace-consent=active pairing=reused');
	}

	beginPairing(): TelegramPairingChallenge {
		if (this.authorizationStateValue !== 'authorized' || !this.tokenFingerprint) {
			throw new TelegramBotApiError('api', 'Telegram polling is not connected.');
		}
		const challenge = this.pairing.begin(this.tokenFingerprint);
		this.restrictToPairingOnly('manual-repairing');
		return challenge;
	}

	registerAuthorizedUpdateHandler(handler: TelegramAuthorizedUpdateHandler): IDisposable {
		if (this.authorizedUpdateHandler) {
			throw new Error('A Telegram authorized-update handler is already registered.');
		}
		this.authorizedUpdateHandler = handler;
		return toDisposable(() => {
			if (this.authorizedUpdateHandler === handler) {
				this.authorizedUpdateHandler = undefined;
			}
		});
	}

	registerCallback(input: TelegramCallbackInput): TelegramCallbackRegistration {
		const identity = this.authorization.pairedIdentity;
		if (this.authorizationStateValue !== 'authorized' || !identity || identity.pairingId !== input.identity.pairingId
			|| identity.userId !== input.identity.userId || identity.chatId !== input.identity.chatId) {
			throw new Error('Telegram callback registration requires the active paired identity.');
		}
		return this.callbacks.register({ ...input, identity });
	}

	consumeCallback(update: TelegramUpdate, constraints: TelegramCallbackConstraints = {}): TelegramCallbackContext | undefined {
		const tokenFingerprint = this.tokenFingerprint;
		const callbackData = update.callback_query?.data;
		if (this.authorizationStateValue !== 'authorized' || !tokenFingerprint || !callbackData) {
			return undefined;
		}
		const identity = this.authorization.authorizeUpdate(update, tokenFingerprint);
		return identity ? this.callbacks.consume(callbackData, identity, constraints) : undefined;
	}

	sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage> {
		return this.transport.sendMessage(chatId, text, options);
	}

	sendRichMessage(chatId: number, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageOptions): Promise<TelegramMessage> {
		return this.transport.sendRichMessage(chatId, richMessage, options);
	}

	sendRichMessageDraft(chatId: number, draftId: number, richMessage: TelegramInputRichMessage): Promise<true> {
		return this.transport.sendRichMessageDraft(chatId, draftId, richMessage);
	}

	editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true> {
		return this.transport.editMessageText(chatId, messageId, text, options);
	}

	editRichMessage(chatId: number, messageId: number, richMessage: TelegramInputRichMessage, options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true> {
		return this.transport.editRichMessage(chatId, messageId, richMessage, options);
	}

	editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: TelegramSendMessageOptions['replyMarkup']): Promise<TelegramMessage | true> {
		return this.transport.editMessageReplyMarkup(chatId, messageId, replyMarkup);
	}

	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void> {
		return this.transport.answerCallbackQuery(callbackQueryId, options);
	}

	clearDeliveryClient(): void {
		this.transport.clearDeliveryClient();
	}

	preserveDeliveryClient(): void {
		this.transport.preserveDeliveryClient();
	}

	invalidateSessionCallbacks(sessionId: string): void {
		this.callbacks.invalidateSession(sessionId);
	}

	invalidateRequestCallbacks(sessionId: string, requestId: string): void {
		this.callbacks.invalidateRequest(sessionId, requestId);
	}

	invalidateAllCallbacks(): void {
		this.callbacks.invalidateAll();
	}

	async revokePairing(): Promise<void> {
		this.blockIncomingUpdates('disabled', 'pairing-revoked');
		this.registry.suspendTransport(this.transport.id);
		await this.transport.stop();
		this.transport.clearDeliveryClient();
		await this.authorization.revokePairing();
	}

	async disableRemoteAccess(): Promise<void> {
		const startCompletion = this.startCompletion;
		this.blockIncomingUpdates('disabled', 'user-disabled');
		this.registry.suspendTransport(this.transport.id);
		let disableError: unknown;
		try {
			const botToken = await this.authorization.getBotToken();
			if (botToken) {
				await this.transport.discardPendingUpdatesOnNextStart(botToken);
			}
		} catch (error) {
			disableError = error;
		}
		try {
			await this.transport.stop();
		} catch (error) {
			disableError ??= error;
		}
		await startCompletion;
		if (disableError) {
			throw disableError;
		}
	}

	/** Cancels a consent or pairing recovery without deleting saved credentials or identity. */
	async cancelRecovery(needsWorkspaceConsent: boolean): Promise<void> {
		const startCompletion = this.startCompletion;
		this.blockIncomingUpdates(needsWorkspaceConsent ? 'needs-consent' : 'disabled', needsWorkspaceConsent ? 'workspace-consent-cancelled' : 'recovery-cancelled');
		this.registry.suspendTransport(this.transport.id);
		await this.transport.stop();
		await startCompletion;
		await this.consent.revokePending();
		this.transport.clearDeliveryClient();
		this.logService.info('[TelegramRemote] recovery=cancelled configuration-preserved=true');
	}

	/** Removes only configuration staged by a first setup that never became authorized. */
	async rollbackFirstSetup(stagedTokenFingerprint: string): Promise<void> {
		const startCompletion = this.startCompletion;
		this.blockIncomingUpdates('disabled', 'first-setup-rolled-back');
		this.registry.detachTransport(this.transport.id);
		await this.transport.stop();
		await startCompletion;
		await this.consent.revokePending();
		await this.authorization.discardStagedConfiguration(stagedTokenFingerprint);
		this.transport.clearDeliveryClient();
	}

	/** Ends pairing-only admission and restores an existing valid authorization when possible. */
	async cancelPairingPreservingConfiguration(consentScopeFingerprint: string, expired: boolean): Promise<void> {
		this.pairing.cancel();
		const tokenFingerprint = this.tokenFingerprint;
		if (tokenFingerprint && this.transport.currentStatus.state === 'connected'
			&& this.authorization.hasPairedIdentityForToken(tokenFingerprint)
			&& this.consent.hasCurrentConsent(tokenFingerprint, consentScopeFingerprint)) {
			this.transitionAuthorizationState('authorized', expired ? 'pairing-expired' : 'pairing-cancelled');
			const identity = this.authorization.pairedIdentity!;
			this.authorizedConnectionEmitter.fire(identity);
		} else {
			this.blockIncomingUpdates('disabled', expired ? 'pairing-expired' : 'pairing-cancelled');
			this.registry.suspendTransport(this.transport.id);
			await this.transport.stop();
			await this.consent.revokePending();
			this.transport.clearDeliveryClient();
		}
		this.logService.info(`[TelegramRemote] pairing=${expired ? 'expired' : 'cancelled'} configuration-preserved=true`);
	}

	async forgetBotToken(): Promise<void> {
		await this.disableRemoteAccess();
		this.registry.detachTransport(this.transport.id);
		this.transport.clearDeliveryClient();
		let consentError: unknown;
		try {
			await this.consent.revoke();
		} catch (error) {
			consentError = error;
		}
		await this.authorization.forgetBotToken();
		if (consentError) {
			throw consentError;
		}
	}

	private async startConnection(botToken: string, handleValidated: () => Promise<void>, pollingOptions?: TelegramPollingOptions, prepareStart?: () => Promise<void>): Promise<TelegramUser> {
		if (this.startInProgress) {
			throw new TelegramBotApiError('api', 'Telegram connection startup is already in progress.');
		}
		this.startInProgress = true;
		this.blockIncomingUpdates('disabled', 'connection-starting');
		const generation = this.lifecycleGeneration;
		let completeStart!: () => void;
		const startCompletion = new Promise<void>(resolve => completeStart = resolve);
		this.startCompletion = startCompletion;
		try {
			await prepareStart?.();
			if (generation !== this.lifecycleGeneration) {
				throw new TelegramBotApiError('aborted', 'Telegram connection startup was cancelled.');
			}
			const bot = await this.transport.start(botToken, update => this.handleUpdate(update), async () => {
				if (generation !== this.lifecycleGeneration) {
					throw new TelegramBotApiError('aborted', 'Telegram connection startup was cancelled.');
				}
				await handleValidated();
				if (generation !== this.lifecycleGeneration || !this.tokenFingerprint
					|| (this.authorizationStateValue !== 'authorized' && this.authorizationStateValue !== 'pairing-only')) {
					throw new TelegramBotApiError('aborted', 'Telegram connection startup was cancelled.');
				}
				const identity = this.authorizationStateValue === 'authorized' ? this.authorization.pairedIdentity : undefined;
				if (identity) {
					this.authorizedConnectionEmitter.fire(identity);
				}
			}, pollingOptions);
			return bot;
		} catch (error) {
			if (generation === this.lifecycleGeneration) {
				this.blockIncomingUpdates('disabled', 'connection-start-failed');
				try {
					await this.transport.stop();
				} catch {
					this.logService.warn('[TelegramRemote] Failed to stop Telegram polling after a startup failure.');
				}
			}
			throw error;
		} finally {
			this.startInProgress = false;
			if (this.startCompletion === startCompletion) {
				this.startCompletion = undefined;
			}
			completeStart();
		}
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		const generation = this.lifecycleGeneration;
		const tokenFingerprint = this.tokenFingerprint;
		if (!tokenFingerprint || (this.authorizationStateValue !== 'pairing-only' && this.authorizationStateValue !== 'authorized')) {
			return;
		}
		if (this.authorizationStateValue === 'pairing-only') {
			const pairingResult = this.pairing.handleUpdate(update, tokenFingerprint);
			if (pairingResult.kind === 'ignored') {
				return;
			}
			await this.handlePairingResult(pairingResult, generation, tokenFingerprint);
			return;
		}
		const identity = this.authorization.authorizeUpdate(update, tokenFingerprint);
		if (!identity) {
			return;
		}
		const updateKind = update.callback_query ? 'callback' : 'message';
		if (!this.updateRateLimiter.accept(identity, updateKind)) {
			this.logService.warn(`[TelegramRemote] update=rate-limited kind=${updateKind}`);
			this.diagnostics.record('update-rate-limited', { kind: updateKind });
			return;
		}
		await this.authorizedUpdateHandler?.({ update, identity });
	}

	private async handlePairingResult(result: Exclude<TelegramPairingResult, { readonly kind: 'ignored' }>, generation: number, tokenFingerprint: string): Promise<void> {
		if (result.kind === 'paired') {
			try {
				await this.consent.commit(tokenFingerprint);
				if (generation !== this.lifecycleGeneration || this.authorizationStateValue !== 'pairing-only') {
					return;
				}
				await this.authorization.pair(result.identity, tokenFingerprint);
				if (generation !== this.lifecycleGeneration || this.authorizationStateValue !== 'pairing-only') {
					return;
				}
				this.transitionAuthorizationState('authorized', 'pairing-and-consent-complete');
				this.callbacks.invalidateAll();
				this.pairingCompletedEmitter.fire(this.authorization.pairedIdentity!);
				this.authorizedConnectionEmitter.fire(this.authorization.pairedIdentity!);
				await this.sendPairingMessage(result.identity.chatId, l10n.t('Pairing succeeded. Telegram Remote is authorized for this private chat.'));
			} catch {
				this.logService.error('[TelegramRemote] Failed to persist Telegram pairing state.');
				await this.sendPairingMessage(result.identity.chatId, l10n.t('Pairing failed. Start a new pairing request in VS Code and try again.'));
			}
			return;
		}
		if (result.identity) {
			const message = result.reason === 'rate-limited'
				? l10n.t('Too many pairing attempts. Wait before trying again.')
				: l10n.t('Pairing failed. Start a new pairing request in VS Code and try again.');
			await this.sendPairingMessage(result.identity.chatId, message);
		}
		if (result.reason === 'expired') {
			this.logService.info('[TelegramRemote] pairing=expired configuration-preserved=true');
		}
	}

	private async sendPairingMessage(chatId: number, text: string): Promise<void> {
		try {
			await this.transport.sendMessage(chatId, text);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to send a Telegram pairing status message.');
		}
	}

	private restrictToPairingOnly(reason: string): void {
		this.lifecycleGeneration++;
		this.transitionAuthorizationState('pairing-only', reason);
		this.callbacks.invalidateAll();
		this.registry.suspendTransport(this.transport.id);
		this.blockedEmitter.fire();
	}

	private blockIncomingUpdates(state: Exclude<TelegramRemoteAuthorizationState, 'authorized' | 'pairing-only'>, reason: string): void {
		this.diagnostics.record('incoming-blocked', { state, reason });
		this.lifecycleGeneration++;
		this.transitionAuthorizationState(state, reason);
		this.tokenFingerprint = undefined;
		this.pairing.cancel();
		this.callbacks.invalidateAll();
		this.updateRateLimiter.clear();
		this.blockedEmitter.fire();
	}

	private transitionAuthorizationState(state: TelegramRemoteAuthorizationState, reason: string): void {
		if (this.authorizationStateValue === state) {
			return;
		}
		this.authorizationStateValue = state;
		this.logService.info(`[TelegramRemote] state=${state} reason=${reason}`);
		this.diagnostics.record('authorization-state', { state, reason });
		this.authorizationStateEmitter.fire(state);
	}

	public override dispose(): void {
		this.blockIncomingUpdates('disabled', 'disposed');
		this.registry.detachTransport(this.transport.id);
		this.transport.clearDeliveryClient();
		void this.transport.stop().catch(() => {
			this.logService.warn('[TelegramRemote] Failed to stop Telegram polling during disposal.');
		});
		super.dispose();
	}
}
