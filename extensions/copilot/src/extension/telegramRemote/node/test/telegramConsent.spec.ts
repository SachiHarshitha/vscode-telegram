/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { TestTelegramExtensionContext } from './testTelegramSecurityState';
import { getTelegramConsentScopeFingerprint, TelegramConsent } from '../telegramConsent';

const tokenFingerprint = '0123456789abcdef01234567';

describe('TelegramConsent', () => {
	it('requires a committed current-version record bound to the token and workspace scope', async () => {
		const context = new TestTelegramExtensionContext('C:\\telegram-test');
		const consent = new TelegramConsent(context);
		const scope = getTelegramConsentScopeFingerprint('machine-1', ['file:///workspace']);

		await consent.begin(tokenFingerprint, scope);
		expect({ pending: consent.hasPendingConsent, current: consent.hasCurrentConsent(tokenFingerprint, scope) }).toEqual({ pending: true, current: false });
		await consent.commit(tokenFingerprint);
		expect({ current: consent.hasCurrentConsent(tokenFingerprint, scope), otherScope: consent.hasCurrentConsent(tokenFingerprint, getTelegramConsentScopeFingerprint('machine-1', ['file:///other'])) }).toEqual({ current: true, otherScope: false });

		await consent.revoke();
		expect(consent.hasCurrentConsent(tokenFingerprint, scope)).toBe(false);
	});

	it('fails closed for stale, malformed, and token-mismatched records', async () => {
		const context = new TestTelegramExtensionContext('C:\\telegram-test');
		context.globalState.values.set('vscode-telegram.telegram-remote.consent.v2', {
			version: 2,
			state: 'active',
			tokenFingerprint,
			scopeFingerprint: tokenFingerprint,
			acceptedAt: Date.now(),
		});
		const consent = new TelegramConsent(context);

		expect(consent.hasCurrentConsent(tokenFingerprint, tokenFingerprint)).toBe(false);
		await consent.begin(tokenFingerprint, tokenFingerprint);
		await expect(consent.commit('abcdefabcdefabcdefabcdef')).rejects.toThrow('consent state write failed');
	});

	it('removes current and legacy consent records on explicit revocation', async () => {
		const context = new TestTelegramExtensionContext('C:\\telegram-test');
		context.globalState.values.set('vscode-telegram.telegram-remote.consent.v2', { version: 2 });
		const consent = new TelegramConsent(context);
		await consent.begin(tokenFingerprint, tokenFingerprint);

		await consent.revoke();

		expect([...context.globalState.values.keys()].filter(key => key.includes('telegram-remote.consent'))).toEqual([]);
	});

	it('normalizes workspace order without exposing the raw workspace in stored state', async () => {
		const context = new TestTelegramExtensionContext('C:\\telegram-test');
		const consent = new TelegramConsent(context);
		const scope = getTelegramConsentScopeFingerprint('machine-1', ['file:///b/private', 'file:///a/private']);
		expect(scope).toBe(getTelegramConsentScopeFingerprint('machine-1', ['file:///a/private', 'file:///b/private']));

		await consent.begin(tokenFingerprint, scope);
		expect(JSON.stringify([...context.globalState.values])).not.toContain('file:///a/private');
	});
});
