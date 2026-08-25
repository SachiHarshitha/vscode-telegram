/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import type { ICopilotCLISessionService } from '../../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlRegistry, IRemoteControlSession } from '../../common/remoteControlTypes';
import type { ITelegramLanguageModelBridge, TelegramSelectableModelInfo } from '../../common/telegramLanguageModelBridgeTypes';
import type { TelegramPairedIdentity } from '../telegramAuthorization';
import { TelegramRequestPreferences, type TelegramModelPreferenceStore } from '../telegramRequestPreferences';
import type { TelegramPersistedModelPreference } from '../telegramSessionState';

const identity: TelegramPairedIdentity = { pairingId: 'pairing-1', userId: 101, chatId: 202, firstName: 'First', pairedAt: 1 };
const catalog: TelegramSelectableModelInfo[] = [
	{
		id: 'claude-sonnet',
		name: 'Claude Sonnet',
		provider: 'Copilot CLI',
		source: 'copilotcli',
		maxContextWindowTokens: 128_000,
		supportsReasoningEffort: true,
		defaultReasoningEffort: 'medium',
		supportedReasoningEfforts: ['low', 'medium', 'high'],
	},
	{ id: 'gpt-fast', name: 'GPT Fast', provider: 'Copilot CLI', source: 'copilotcli', maxContextWindowTokens: 64_000 },
];

describe('TelegramRequestPreferences', () => {
	it('validates model and reasoning against the upstream catalog and keeps the model selected', async () => {
		const test = createPreferences();

		await expect(test.preferences.setModel(identity, 'session-1', 'Claude Sonnet', 'HIGH')).resolves.toEqual({
			kind: 'valid',
			value: { modelId: 'claude-sonnet', modelSource: 'copilotcli', reasoningEffort: 'high', mode: 'interactive' },
		});
		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({
			kind: 'valid',
			value: { modelId: 'claude-sonnet', modelSource: 'copilotcli', reasoningEffort: 'high', mode: 'interactive' },
		});
		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({
			kind: 'valid',
			value: { modelId: 'claude-sonnet', modelSource: 'copilotcli', reasoningEffort: 'high', mode: 'interactive' },
		});
	});

	it('preserves a VS Code-backed model source across dispatches', async () => {
		const test = createPreferences();
		test.models.getModels.mockResolvedValue([
			...catalog,
			{ id: 'openai/work-model', name: 'Work Model', provider: 'openai', source: 'vscode-lm', maxContextWindowTokens: 128_000 },
		]);

		expect(await test.preferences.setModel(identity, 'session-1', 'openai/work-model')).toEqual({
			kind: 'valid',
			value: { modelId: 'openai/work-model', modelSource: 'vscode-lm', reasoningEffort: undefined, mode: 'interactive' },
		});
		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({
			kind: 'valid',
			value: { modelId: 'openai/work-model', modelSource: 'vscode-lm', reasoningEffort: undefined, mode: 'interactive' },
		});
		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({
			kind: 'valid',
			value: { modelId: 'openai/work-model', modelSource: 'vscode-lm', reasoningEffort: undefined, mode: 'interactive' },
		});
	});

	it('restores the selected model when the preference controller is recreated', async () => {
		const store = new TestPreferenceStore();
		const first = createPreferences({ store });
		await first.preferences.setModel(identity, 'session-1', 'claude-sonnet', 'medium');

		const recreated = createPreferences({ store });

		expect(await recreated.preferences.consumeForDispatch(identity, 'session-1')).toEqual({
			kind: 'valid',
			value: { modelId: 'claude-sonnet', modelSource: 'copilotcli', reasoningEffort: 'medium', mode: 'interactive' },
		});
	});

	it('fails a stale stored model visibly before dispatch', async () => {
		const test = createPreferences();
		await test.preferences.setModel(identity, 'session-1', 'claude-sonnet', 'high');
		test.models.getModels.mockResolvedValue([]);

		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({ kind: 'invalid', error: 'catalog-unavailable' });
		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({ kind: 'valid', value: { mode: 'interactive' } });
	});

	it('classifies an upstream catalogue failure without exposing its details', async () => {
		const test = createPreferences();
		test.models.getModels.mockRejectedValue(new Error('provider secret detail'));

		expect(await test.preferences.setModel(identity, 'session-1', 'claude-sonnet')).toEqual({ kind: 'invalid', error: 'catalog-unavailable' });
		expect(test.logService.warn).toHaveBeenCalledWith('[TelegramRemote] model-validation=failed reason=catalog-unavailable');
		expect(JSON.stringify(test.logService.warn.mock.calls)).not.toContain('provider secret detail');
	});

	it('rejects unsupported and feature-disabled reasoning effort', async () => {
		const test = createPreferences();
		expect(await test.preferences.setModel(identity, 'session-1', 'gpt-fast', 'high')).toEqual({ kind: 'invalid', error: 'unsupported-reasoning' });

		test.configurationService.reasoningEnabled = false;
		expect(await test.preferences.setModel(identity, 'session-1', 'claude-sonnet', 'high')).toEqual({ kind: 'invalid', error: 'reasoning-disabled' });
	});

	it('rejects a reasoning effort removed from the catalogue before dispatch', async () => {
		const test = createPreferences();
		await test.preferences.setModel(identity, 'session-1', 'claude-sonnet', 'high');
		test.models.getModels.mockResolvedValue([{ ...catalog[0], supportedReasoningEfforts: ['low'] }]);

		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({ kind: 'invalid', error: 'unsupported-reasoning' });
	});

	it('combines only plan or interactive mode with the next model request', async () => {
		const test = createPreferences();
		await test.preferences.setModel(identity, 'session-1', 'gpt-fast');
		test.preferences.setMode(identity, 'session-1', 'plan');

		expect(await test.preferences.consumeForDispatch(identity, 'session-1')).toEqual({
			kind: 'valid',
			value: { modelId: 'gpt-fast', modelSource: 'copilotcli', reasoningEffort: undefined, mode: 'plan' },
		});
		expect(() => test.preferences.setMode(identity, 'session-1', 'autopilot' as never)).toThrow('permission-elevating');
	});

	it('shows the persistent Telegram model instead of a reconnected SDK Auto selection', async () => {
		const test = createPreferences({ selectedModelId: 'gpt-fast', currentMode: 'plan' });
		await test.preferences.setModel(identity, 'session-1', 'claude-sonnet', 'medium');

		expect(await test.preferences.getStatus(identity, 'session-1')).toEqual({
			selectedModelId: 'claude-sonnet',
			selectedModelLabel: 'Claude Sonnet · medium',
			currentMode: 'plan',
			pending: undefined,
		});
		await test.preferences.consumeForDispatch(identity, 'session-1');
		expect(await test.preferences.getStatus(identity, 'session-1')).toEqual(expect.objectContaining({
			selectedModelId: 'claude-sonnet',
			selectedModelLabel: 'Claude Sonnet · medium',
			pending: undefined,
		}));
		expect(test.sessionService.getSelectedModelId).not.toHaveBeenCalled();
	});
});

class TestPreferenceStore implements TelegramModelPreferenceStore {
	private stored: { readonly pairingId: string; readonly sessionId: string; readonly preference: TelegramPersistedModelPreference } | undefined;

	getSelectedModelPreference(preferenceIdentity: TelegramPairedIdentity, sessionId: string): TelegramPersistedModelPreference | undefined {
		return this.stored?.pairingId === preferenceIdentity.pairingId && this.stored.sessionId === sessionId ? this.stored.preference : undefined;
	}

	async setSelectedModelPreference(preferenceIdentity: TelegramPairedIdentity, sessionId: string, preference: TelegramPersistedModelPreference): Promise<void> {
		this.stored = { pairingId: preferenceIdentity.pairingId, sessionId, preference };
	}

	async clearSelectedModelPreference(preferenceIdentity: TelegramPairedIdentity, sessionId: string): Promise<boolean> {
		if (this.stored?.pairingId !== preferenceIdentity.pairingId || this.stored.sessionId !== sessionId) {
			return false;
		}
		this.stored = undefined;
		return true;
	}
}

function createPreferences(options: { readonly selectedModelId?: string; readonly currentMode?: string; readonly store?: TestPreferenceStore } = {}) {
	const models = new class extends mock<ITelegramLanguageModelBridge>() {
		override dispose = vi.fn();
		override getModels = vi.fn(async () => catalog);
		override resolveModel = vi.fn(async (value: string) => (await this.getModels()).find(model => model.id.toLocaleLowerCase() === value.toLocaleLowerCase() || model.name.toLocaleLowerCase() === value.toLocaleLowerCase()));
		override resolveSelection = vi.fn(async () => undefined);
	};
	const sessionService = new class extends mock<ICopilotCLISessionService>() {
		override getSelectedModelId = vi.fn(async () => options.selectedModelId);
	};
	const liveSession = options.currentMode ? { getCurrentMode: () => options.currentMode } as IRemoteControlSession : undefined;
	const registry = new class extends mock<IRemoteControlRegistry>() {
		override getSession = vi.fn(() => liveSession);
	};
	const configurationService = new class extends mock<IConfigurationService>() {
		reasoningEnabled = true;
		override getConfig<T>(): T { return this.reasoningEnabled as T; }
	};
	const logService = new class extends mock<ILogService>() {
		override warn = vi.fn();
	};
	const store = options.store ?? new TestPreferenceStore();
	const preferences = new TelegramRequestPreferences(models, sessionService, registry, store, configurationService, logService);
	return { preferences, models, sessionService, registry, store, configurationService, logService };
}
