/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import type { Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { IRemoteControlRegistry, type IRemoteControlSessionEvent, type IRemoteControlTransport, type IRemotePermissionRequest, type IRemoteUserInputRequest, type IRemoteUserInputResponse, type RemotePermissionResult } from '../common/remoteControlTypes';
import type { TelegramAnswerCallbackQueryOptions, TelegramEditMessageTextOptions, TelegramEditRichMessageOptions, TelegramInputRichMessage, TelegramMessage, TelegramPollingStatus, TelegramSendMessageOptions, TelegramSendRichMessageOptions, TelegramUpdate, TelegramUser } from '../common/telegramTypes';
import { TelegramService, type TelegramPollingOptions, type TelegramValidatedHandler } from './telegramService';

/** Telegram Bot API transport; the contribution owns Phase 3 authorization and lifecycle policy. */
export class TelegramTransport extends Disposable implements IRemoteControlTransport {
	readonly id = 'telegram';
	readonly label = l10n.t('Telegram');
	readonly themeIcon = 'radio-tower';

	private readonly service: TelegramService;
	private eventPublisher: Pick<IRemoteControlTransport, 'publish' | 'requestPermission' | 'requestUserInput'> | undefined;
	readonly onDidChangeStatus: Event<TelegramPollingStatus>;

	constructor(
		storageRoot: string,
		@IRemoteControlRegistry registry: IRemoteControlRegistry,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
	) {
		super();
		this.service = this._register(new TelegramService(storageRoot, undefined, fetcherService, logService));
		this.onDidChangeStatus = this.service.onDidChangeStatus;
		this._register(registry.registerTransport(this));
	}

	get currentStatus(): TelegramPollingStatus {
		return this.service.currentStatus;
	}

	start(botToken: string, handleUpdate: (update: TelegramUpdate) => Promise<void>, handleValidated?: TelegramValidatedHandler, options?: TelegramPollingOptions): Promise<TelegramUser> {
		return this.service.start(botToken, handleUpdate, handleValidated, options);
	}

	sendMessage(chatId: number, text: string, options?: TelegramSendMessageOptions): Promise<TelegramMessage> {
		return this.service.sendMessage(chatId, text, options);
	}

	sendRichMessage(chatId: number, richMessage: TelegramInputRichMessage, options?: TelegramSendRichMessageOptions): Promise<TelegramMessage> {
		return this.service.sendRichMessage(chatId, richMessage, options);
	}

	sendRichMessageDraft(chatId: number, draftId: number, richMessage: TelegramInputRichMessage): Promise<true> {
		return this.service.sendRichMessageDraft(chatId, draftId, richMessage);
	}

	editMessageText(chatId: number, messageId: number, text: string, options?: TelegramEditMessageTextOptions): Promise<TelegramMessage | true> {
		return this.service.editMessageText(chatId, messageId, text, options);
	}

	editRichMessage(chatId: number, messageId: number, richMessage: TelegramInputRichMessage, options?: TelegramEditRichMessageOptions): Promise<TelegramMessage | true> {
		return this.service.editRichMessage(chatId, messageId, richMessage, options);
	}

	editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: TelegramSendMessageOptions['replyMarkup']): Promise<TelegramMessage | true> {
		return this.service.editMessageReplyMarkup(chatId, messageId, replyMarkup);
	}

	answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<void> {
		return this.service.answerCallbackQuery(callbackQueryId, options);
	}

	stop(): Promise<void> {
		return this.service.stop();
	}

	preserveDeliveryClient(): void {
		this.service.preserveDeliveryClient();
	}

	clearDeliveryClient(): void {
		this.service.clearDeliveryClient();
	}

	setEventPublisher(publisher: Pick<IRemoteControlTransport, 'publish' | 'requestPermission' | 'requestUserInput'>): IDisposable {
		if (this.eventPublisher) {
			throw new Error('A Telegram event publisher is already registered.');
		}
		this.eventPublisher = publisher;
		return toDisposable(() => {
			if (this.eventPublisher === publisher) {
				this.eventPublisher = undefined;
			}
		});
	}

	publish(sessionId: string, event: IRemoteControlSessionEvent): void | Promise<void> {
		return this.eventPublisher?.publish(sessionId, event);
	}

	requestPermission(sessionId: string, request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> {
		return this.eventPublisher?.requestPermission?.(sessionId, request, token) ?? Promise.resolve(undefined);
	}

	requestUserInput(sessionId: string, request: IRemoteUserInputRequest, token: CancellationToken): Promise<IRemoteUserInputResponse | undefined> {
		return this.eventPublisher?.requestUserInput?.(sessionId, request, token) ?? Promise.resolve(undefined);
	}
}
