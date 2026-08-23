/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { resolveTelegramRemoteHostCompatibility, TELEGRAM_REMOTE_BUILD_MARKER, TELEGRAM_REMOTE_PATCH_REVISION } from '../telegramRemoteCompatibility';

describe('Telegram remote compatibility', () => {
	it('enables the controller path by default', () => {
		expect(ConfigKey.Advanced.CLISessionController.defaultValue).toBe(true);
	});

	it('accepts an ordinary controller host', () => {
		expect(resolveTelegramRemoteHostCompatibility({
			sessionController: true,
			agentSessionsWorkspace: false,
		})).toEqual({
			supported: true,
			sessionController: true,
			agentSessionsWorkspace: false,
		});
	});

	it('rejects the deprecated session provider', () => {
		expect(resolveTelegramRemoteHostCompatibility({
			sessionController: false,
			agentSessionsWorkspace: false,
		})).toEqual({ supported: false, reason: 'legacy-session-provider' });
	});

	it('rejects Agent Sessions workspaces for product V1', () => {
		expect(resolveTelegramRemoteHostCompatibility({
			sessionController: true,
			agentSessionsWorkspace: true,
		})).toEqual({ supported: false, reason: 'agent-sessions-workspace' });
	});

	it('has a stable diagnostics marker and patch revision', () => {
		expect(TELEGRAM_REMOTE_BUILD_MARKER).toBe('vscode-telegram/telegram-remote');
		expect(TELEGRAM_REMOTE_PATCH_REVISION).toBe(2);
	});
});
