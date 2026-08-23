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
import { IRemoteControlRegistry } from '../common/remoteControlTypes';
import { TelegramAnswerCallbackQueryOptions, TelegramBotApiError, TelegramEditMessageTextOptions, TelegramMessage, TelegramPollingStatus, TelegramSendMessageOptions, TelegramUpdate, TelegramUser, validateTelegramBotToken } from '../common/telegramTypes';
import { TelegramAuthorization, TelegramPairedIdentity } from '../node/telegramAuthorization';
import { TelegramCallbackConstraints, TelegramCallbackContext, TelegramCallbackInput, TelegramCallbackRegistration, TelegramCallbackRegistry } from '../node/telegramCallbackRegistry';
import { TelegramConsent } from '../node/telegramConsent';
import { TelegramPairingChallenge, TelegramPairingResult, TelegramPairingService } from '../node/telegramPairingService';
import { getTelegramBotTokenFingerprint } from '../node/telegramPollerLease';
import type { TelegramPollingOptions } from '../node/telegramService';
import { TelegramTransport } from '../node/telegramTransport';

export interface TelegramPairingStartResult {
	readonly bot: TelegramUser;
	readonly challenge: TelegramPairingChallenge;
}

export interface TelegramAuthorizedUpdate {
	readonly update: TelegramUpdate;
	readonly identity: TelegramPairedIdentity;
}

export type TelegramAuthorizedUpdateHandler = (accepted: TelegramAuthorizedUpdate) => Promise<void>;

/** Composes the dormant transport with the Phase 3 secure-state and authorization boundary. */
export class TelegramRemoteContribution extends Disposable {
	private readonly pairingCompletedEmitter = this._register(new Emitter<TelegramPairedIdentity>());
	readonly onDidCompletePairing: Event<TelegramPairedIdentity> = this.pairingCompletedEmitter.event;
	private readonly authorizedConnectionEmitter = this._register(new Emitter<TelegramPairedIdentity>());
	readonly onDidAuthorizeConnection: Event<TelegramPairedIdentity> = this.authorizedConnectionEmitter.event;
	private readonly blockedEmitter = this._register(new Emitter<void>());
	readonly onDidBlockRemoteAccess: Event<void> = this.blockedEmitter.event;

	readonly transport: TelegramTransport;
	readonly authorization: TelegramAuthorization;
	readonly consent: TelegramConsent;
	readonly pairing = new TelegramPairingService();
	readonly callbacks = new TelegramCallbackRegistry();

	private lifecycleGeneration = 0;
	private acceptingUpdates = false;
	private startInProgress = false;
	private startCompletion: Promise<void> | undefined;
	private tokenFingerprint: string | undefined;
	private authorizedUpdateHandler: TelegramAuthorizedUpdateHandler | undefined;

	constructor(
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IRemoteControlRegistry private readonly registry: IRemoteControlRegistry,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.authorization = this._register(new TelegramAuthorization(extensionContext));
		this.consent = new TelegramConsent(extensionContext);
		this.transport = this._register(new TelegramTransport(extensionContext.globalStorageUri.fsPath, registry, fetcherService, logService));
	}

	get currentStatus(): TelegramPollingStatus {
		return this.transport.currentStatus;
	}

	get isAcceptingUpdates(): boolean {
		return this.acceptingUpdates;
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
			}, pollingOptions, () => this.consent.begin(expectedTokenFingerprint, consentScopeFingerprint));
		} catch (error) {
			await this.consent.revoke().catch(() => {
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
	async resumeStoredConnection(consentScopeFingerprint: string, pollingOptions?: TelegramPollingOptions): Promise<TelegramUser | undefined> {
		const requestedGeneration = this.lifecycleGeneration;
		const botToken = await this.authorization.getBotToken();
		if (!botToken || requestedGeneration !== this.lifecycleGeneration) {
			return undefined;
		}
		const tokenFingerprint = getTelegramBotTokenFingerprint(botToken);
		if (!this.consent.hasCurrentConsent(tokenFingerprint, consentScopeFingerprint)) {
			return undefined;
		}
		return this.startConnection(botToken, async () => {
			this.tokenFingerprint = await this.authorization.storeBotToken(botToken);
		}, pollingOptions);
	}

	beginPairing(): TelegramPairingChallenge {
		if (!this.acceptingUpdates || !this.tokenFingerprint) {
			throw new TelegramBotApiError('api', 'Telegram polling is not connected.');
		}
		return this.pairing.begin(this.tokenFingerprint);
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
		if (!this.acceptingUpdates || !identity || identity.pairingId !== input.identity.pairingId
			|| identity.userId !== input.identity.userId || identity.chatId !== input.identity.chatId) {
			throw new Error('Telegram callback registration requires the active paired identity.');
		}
		return this.callbacks.register({ ...input, identity });
	}

	consumeCallback(update: TelegramUpdate, constraints: TelegramCallbackConstraints = {}): TelegramCallbackContext | undefined {
		const tokenFingerprint = this.tokenFingerprint;
		const callbackData = update.callback_query?.data;
		if (!this.acceptingUpdates || !tokenFingerprint || !callbackData) {
			return undefined;
		}
		const identity = this.authorization.authorizeUpdate(update, tokenFingerprint);
		return identity ? this.callbacks.consume(callbackData, identity, constraints) : undefined;
	}

	sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage> {
		return this.transport.sendMessage(chatId, text, options);
	}

	editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true> {
		return this.transport.editMessageText(chatId, messageId, text, options);
	}

	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void> {
		return this.transport.answerCallbackQuery(callbackQueryId, options);
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
		this.pairing.cancel();
		this.callbacks.invalidateAll();
		this.registry.detachTransport(this.transport.id);
		await this.authorization.revokePairing();
	}

	async disableRemoteAccess(): Promise<void> {
		const startCompletion = this.startCompletion;
		this.blockIncomingUpdates();
		this.registry.detachTransport(this.transport.id);
		let stopError: unknown;
		try {
			await this.transport.stop();
		} catch (error) {
			stopError = error;
		}
		await startCompletion;
		if (stopError) {
			throw stopError;
		}
	}

	async forgetBotToken(): Promise<void> {
		await this.disableRemoteAccess();
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
		this.blockIncomingUpdates();
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
				if (generation !== this.lifecycleGeneration || !this.tokenFingerprint) {
					throw new TelegramBotApiError('aborted', 'Telegram connection startup was cancelled.');
				}
				this.acceptingUpdates = true;
				const identity = this.authorization.pairedIdentity;
				if (identity) {
					this.authorizedConnectionEmitter.fire(identity);
				}
			}, pollingOptions);
			return bot;
		} catch (error) {
			if (generation === this.lifecycleGeneration) {
				this.blockIncomingUpdates();
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
		if (!this.acceptingUpdates || !tokenFingerprint) {
			return;
		}
		const pairingResult = this.pairing.handleUpdate(update, tokenFingerprint);
		if (pairingResult.kind !== 'ignored') {
			await this.handlePairingResult(pairingResult, generation, tokenFingerprint);
			return;
		}
		const identity = this.authorization.authorizeUpdate(update, tokenFingerprint);
		if (!identity) {
			return;
		}
		await this.authorizedUpdateHandler?.({ update, identity });
	}

	private async handlePairingResult(result: Exclude<TelegramPairingResult, { readonly kind: 'ignored' }>, generation: number, tokenFingerprint: string): Promise<void> {
		if (result.kind === 'paired') {
			try {
				await this.authorization.pair(result.identity, tokenFingerprint);
				if (generation !== this.lifecycleGeneration || !this.acceptingUpdates) {
					await this.authorization.revokePairing();
					return;
				}
				await this.consent.commit(tokenFingerprint);
				if (generation !== this.lifecycleGeneration || !this.acceptingUpdates) {
					await this.authorization.revokePairing();
					return;
				}
				this.callbacks.invalidateAll();
				this.pairingCompletedEmitter.fire(this.authorization.pairedIdentity!);
				this.authorizedConnectionEmitter.fire(this.authorization.pairedIdentity!);
				await this.sendPairingMessage(result.identity.chatId, l10n.t('Pairing succeeded. Telegram Remote is authorized for this private chat.'));
			} catch {
				this.logService.error('[TelegramRemote] Failed to persist Telegram pairing state.');
				await this.authorization.revokePairing().catch(() => { });
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
	}

	private async sendPairingMessage(chatId: number, text: string): Promise<void> {
		try {
			await this.transport.sendMessage(chatId, text);
		} catch {
			this.logService.warn('[TelegramRemote] Failed to send a Telegram pairing status message.');
		}
	}

	private blockIncomingUpdates(): void {
		this.lifecycleGeneration++;
		this.acceptingUpdates = false;
		this.tokenFingerprint = undefined;
		this.pairing.cancel();
		this.callbacks.invalidateAll();
		this.blockedEmitter.fire();
	}

	public override dispose(): void {
		this.blockIncomingUpdates();
		void this.transport.stop().catch(() => {
			this.logService.warn('[TelegramRemote] Failed to stop Telegram polling during disposal.');
		});
		super.dispose();
	}
}
