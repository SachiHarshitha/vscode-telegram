/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import type { Event } from '../../../util/vs/base/common/event';
import { IRemoteControlRegistry, type IRemoteControlSessionEvent, type IRemoteControlTransport } from '../common/remoteControlTypes';
import type { TelegramPollingStatus, TelegramUpdate, TelegramUser } from '../common/telegramTypes';
import { TelegramService } from './telegramService';

/** Phase 2 transport shell. Session attachment and authorization are added in later phases. */
export class TelegramTransport extends Disposable implements IRemoteControlTransport {
	readonly id = 'telegram';
	readonly label = l10n.t('Telegram');

	private readonly service: TelegramService;
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

	start(botToken: string, handleUpdate: (update: TelegramUpdate) => Promise<void>): Promise<TelegramUser> {
		return this.service.start(botToken, handleUpdate);
	}

	stop(): Promise<void> {
		return this.service.stop();
	}

	publish(_sessionId: string, _event: IRemoteControlSessionEvent): void {
		// Phase 2 has no authorized chat/session binding, so registry events cannot be projected yet.
	}
}
