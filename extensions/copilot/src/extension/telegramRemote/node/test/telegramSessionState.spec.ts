/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import type { IRemoteControlTransport } from '../../common/remoteControlTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramSessionState, TelegramSessionStateError } from '../telegramSessionState';
import { TestTelegramExtensionContext } from './testTelegramSecurityState';

const identity: TelegramPairedIdentity = {
	pairingId: 'pairing-1',
	userId: 101,
	chatId: 202,
	firstName: 'First',
	pairedAt: 1,
};
const sessionScopeFingerprint = '1234567890abcdef12345678';

describe('TelegramSessionState', () => {
	it('persists one paired-chat selection and reflects switches as logical attachments', async () => {
		const { context, registry, state } = createState();

		await state.select(identity, 'session-1', sessionScopeFingerprint);
		expect(state.getSelectedSessionId(identity)).toBe('session-1');
		expect(registry.getAttachedSessionIds('telegram')).toEqual(['session-1']);
		expect(JSON.stringify([...context.globalState.values.values()])).not.toContain('First');

		await state.select(identity, 'session-2', sessionScopeFingerprint);
		expect(registry.getAttachedSessionIds('telegram')).toEqual(['session-2']);
		expect(JSON.stringify([...context.globalState.values.values()])).toContain('session-2');
	});

	it('suspends runtime attachment and restores it only after metadata validation', async () => {
		const { context, registry, state } = createState();
		await state.select(identity, 'session-1', sessionScopeFingerprint);
		state.suspend();
		expect(registry.getAttachedSessionIds('telegram')).toEqual([]);

		const restored = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
		await expect(restored.restore(identity, async (sessionId, scope) => sessionId === 'session-1' && scope === sessionScopeFingerprint)).resolves.toBe('session-1');
		expect(registry.getAttachedSessionIds('telegram')).toEqual(['session-1']);

		restored.suspend();
		const stale = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
		await expect(stale.restore(identity, async () => false)).resolves.toBeUndefined();
		expect(stale.getSelectedSessionId(identity)).toBeUndefined();
		expect(registry.getAttachedSessionIds('telegram')).toEqual([]);
	});

	it('never restores a selection from a different consented workspace scope', async () => {
		const { context, registry, state } = createState();
		await state.select(identity, 'session-1', sessionScopeFingerprint);
		state.suspend();
		const otherWorkspace = new TelegramSessionState('111111111111111111111111', context, registry);
		const validate = vi.fn(async () => true);

		await expect(otherWorkspace.restore(identity, validate)).resolves.toBeUndefined();
		expect(validate).not.toHaveBeenCalled();
		expect(registry.getAttachedSessionIds('telegram')).toEqual([]);
		expect(otherWorkspace.getSelectedSessionId(identity)).toBeUndefined();
	});

	it('removes deleted sessions and rejects malformed or mismatched persisted identities', async () => {
		const { context, registry, state } = createState();
		await state.select(identity, 'session-1', sessionScopeFingerprint);
		await expect(state.clearSession('session-1')).resolves.toBe(true);
		expect(registry.getAttachedSessionIds('telegram')).toEqual([]);

		context.globalState.values.set('vscode-telegram.telegram-remote.selected-sessions.v2', {
			version: 2,
			selections: [{ pairingId: identity.pairingId, userId: 999, chatId: identity.chatId, consentScopeFingerprint: 'abcdefabcdefabcdefabcdef', sessionId: 'leaked', sessionScopeFingerprint, selectedAt: 1 }],
		});
		const mismatched = new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry);
		await expect(mismatched.restore(identity, async () => true)).resolves.toBeUndefined();
		expect(mismatched.getSelectedSessionId(identity)).toBeUndefined();
	});

	it('keeps the prior selection and attachment when persistence fails', async () => {
		const { context, registry, state } = createState();
		await state.select(identity, 'session-1', sessionScopeFingerprint);
		context.globalState.update = vi.fn(async () => { throw new Error('offline'); });

		await expect(state.select(identity, 'session-2', sessionScopeFingerprint)).rejects.toBeInstanceOf(TelegramSessionStateError);
		expect(state.getSelectedSessionId(identity)).toBe('session-1');
		expect(registry.getAttachedSessionIds('telegram')).toEqual(['session-1']);
	});
});

function createState(): { context: TestTelegramExtensionContext; registry: RemoteControlRegistry; state: TelegramSessionState } {
	const context = new TestTelegramExtensionContext('C:\\telegram-state-test');
	const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
	registry.registerTransport({
		id: 'telegram',
		label: 'Telegram',
		themeIcon: 'radio-tower',
		publish: () => { },
		dispose: () => { },
	} satisfies IRemoteControlTransport);
	return { context, registry, state: new TelegramSessionState('abcdefabcdefabcdefabcdef', context, registry) };
}
