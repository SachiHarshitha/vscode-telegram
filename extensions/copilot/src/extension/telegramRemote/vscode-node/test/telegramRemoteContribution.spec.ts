/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import type { ILogService } from '../../../../platform/log/common/logService';
import type { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { mock } from '../../../../util/common/test/simpleMock';
import { URI } from '../../../../util/vs/base/common/uri';
import { RemoteControlRegistry } from '../../node/remoteControlRegistry';
import { TelegramRemoteContribution } from '../telegramRemoteContribution';

describe('TelegramRemoteContribution', () => {
	let storageRoot: string;

	beforeEach(async () => {
		storageRoot = await mkdtemp(join(tmpdir(), 'telegram-contribution-'));
	});

	afterEach(async () => {
		await rm(storageRoot, { recursive: true, force: true });
	});

	it('registers a dormant transport and removes it on disposal', () => {
		const logService = new class extends mock<ILogService>() { };
		const registry = new RemoteControlRegistry(logService);
		const extensionContext = new class extends mock<IVSCodeExtensionContext>() {
			override globalStorageUri = URI.file(storageRoot);
		};
		const contribution = new TelegramRemoteContribution(
			extensionContext,
			registry,
			new class extends mock<IFetcherService>() { },
			logService,
		);

		const attachment = registry.attachTransport('session-1', 'telegram');
		expect(contribution.transport.currentStatus).toEqual({ state: 'stopped' });
		attachment.dispose();
		contribution.dispose();
		expect(() => registry.attachTransport('session-1', 'telegram')).toThrow();
	});
});
