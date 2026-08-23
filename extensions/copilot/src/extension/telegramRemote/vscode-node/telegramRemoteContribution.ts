/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IRemoteControlRegistry } from '../common/remoteControlTypes';
import { TelegramTransport } from '../node/telegramTransport';

/** Registers the dormant Phase 2 transport; Phase 3 owns consent, token storage and activation. */
export class TelegramRemoteContribution extends Disposable {
	readonly transport: TelegramTransport;

	constructor(
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IRemoteControlRegistry registry: IRemoteControlRegistry,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
	) {
		super();
		this.transport = this._register(new TelegramTransport(extensionContext.globalStorageUri.fsPath, registry, fetcherService, logService));
	}
}
