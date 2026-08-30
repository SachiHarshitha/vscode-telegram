/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('vscode', () => ({
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {},
}));

import * as vscode from 'vscode';
import { NotificationService } from '../notificationServiceImpl';

describe('NotificationService', () => {
	beforeEach(() => {
		vi.mocked(vscode.commands.executeCommand).mockClear();
	});

	test('uses the workbench setup flow for the default chat extension', async () => {
		const service = new NotificationService('workbench.action.chat.triggerSetup');

		await service.showQuotaExceededDialog({ isNoAuthUser: true });

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.triggerSetup');
	});

	test('uses extension authentication for an alternate extension id', async () => {
		const service = new NotificationService('emagin8.remotePilot.signIn');

		await service.showQuotaExceededDialog({ isNoAuthUser: true });

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith('emagin8.remotePilot.signIn');
	});

	test('keeps the quota dialog for authenticated users', async () => {
		const service = new NotificationService('emagin8.remotePilot.signIn');

		await service.showQuotaExceededDialog({ isNoAuthUser: false });

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.openQuotaExceededDialog');
	});
});
