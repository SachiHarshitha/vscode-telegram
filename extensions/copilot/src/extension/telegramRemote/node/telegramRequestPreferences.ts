/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import type { ICopilotCLISessionService } from '../../chatSessions/copilotcli/node/copilotcliSessionService';
import type { IRemoteControlRegistry, RemoteNonElevatingMode } from '../../remoteControl/common/remoteControlTypes';
import type { ITelegramLanguageModelBridge, TelegramModelSource, TelegramSelectableModelInfo } from '../common/telegramLanguageModelBridgeTypes';
import type { TelegramPairedIdentity } from './telegramAuthorization';
import type { TelegramPersistedModelPreference } from './telegramSessionState';

export type TelegramPreferenceValidationError =
	| 'catalog-unavailable'
	| 'unsupported-model'
	| 'reasoning-disabled'
	| 'unsupported-reasoning';

export interface TelegramPromptPreference {
	readonly modelId?: string;
	readonly modelSource?: TelegramModelSource;
	readonly reasoningEffort?: string;
	readonly mode: RemoteNonElevatingMode;
}

export interface TelegramSessionModelStatus {
	readonly selectedModelId?: string;
	readonly selectedModelLabel?: string;
	readonly currentMode?: string;
	readonly pending?: TelegramPromptPreference;
}

export type TelegramPreferenceResult<T> =
	| { readonly kind: 'valid'; readonly value: T }
	| { readonly kind: 'invalid'; readonly error: TelegramPreferenceValidationError };

interface StoredTelegramPromptPreference {
	readonly pairingId: string;
	readonly userId: number;
	readonly chatId: number;
	readonly sessionId: string;
	readonly modelId?: string;
	readonly modelSource?: TelegramModelSource;
	readonly reasoningEffort?: string;
	readonly mode?: RemoteNonElevatingMode;
}

export interface TelegramRequestPreferenceController {
	getModels(): Promise<readonly TelegramSelectableModelInfo[]>;
	isReasoningEffortSelectionEnabled(): boolean;
	setModel(identity: TelegramPairedIdentity, sessionId: string, modelId: string, reasoningEffort?: string): Promise<TelegramPreferenceResult<TelegramPromptPreference>>;
	setMode(identity: TelegramPairedIdentity, sessionId: string, mode: RemoteNonElevatingMode): TelegramPromptPreference;
	consumeForDispatch(identity: TelegramPairedIdentity, sessionId: string): Promise<TelegramPreferenceResult<TelegramPromptPreference>>;
	getStatus(identity: TelegramPairedIdentity, sessionId: string): Promise<TelegramSessionModelStatus>;
	clear(identity: TelegramPairedIdentity): void;
}

export interface TelegramModelPreferenceStore {
	getSelectedModelPreference(identity: TelegramPairedIdentity, sessionId: string): TelegramPersistedModelPreference | undefined;
	setSelectedModelPreference(identity: TelegramPairedIdentity, sessionId: string, preference: TelegramPersistedModelPreference): Promise<void>;
	clearSelectedModelPreference(identity: TelegramPairedIdentity, sessionId: string): Promise<boolean>;
}

/** Owns an identity/session-bound persistent model and a one-request safe-mode preference. */
export class TelegramRequestPreferences implements TelegramRequestPreferenceController {
	private readonly preferences = new Map<string, StoredTelegramPromptPreference>();

	constructor(
		private readonly models: ITelegramLanguageModelBridge,
		private readonly sessionService: ICopilotCLISessionService,
		private readonly registry: IRemoteControlRegistry,
		private readonly preferenceStore: TelegramModelPreferenceStore,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) { }

	getModels(): Promise<readonly TelegramSelectableModelInfo[]> {
		return this.models.getModels();
	}

	isReasoningEffortSelectionEnabled(): boolean {
		return this.configurationService.getConfig(ConfigKey.Advanced.CLIThinkingEffortEnabled);
	}

	async setModel(identity: TelegramPairedIdentity, sessionId: string, requestedModelId: string, requestedReasoningEffort?: string): Promise<TelegramPreferenceResult<TelegramPromptPreference>> {
		const validation = await this.validateModel(requestedModelId, requestedReasoningEffort);
		if (validation.kind === 'invalid') {
			return validation;
		}
		const current = this.getStored(identity, sessionId);
		const next: StoredTelegramPromptPreference = {
			pairingId: identity.pairingId,
			userId: identity.userId,
			chatId: identity.chatId,
			sessionId,
			modelId: validation.value.modelId,
			modelSource: validation.value.modelSource,
			reasoningEffort: validation.value.reasoningEffort,
			mode: current?.mode,
		};
		await this.preferenceStore.setSelectedModelPreference(identity, sessionId, {
			modelId: validation.value.modelId,
			modelSource: validation.value.modelSource,
			reasoningEffort: validation.value.reasoningEffort,
		});
		this.preferences.set(identity.pairingId, next);
		return { kind: 'valid', value: toPromptPreference(next) };
	}

	setMode(identity: TelegramPairedIdentity, sessionId: string, mode: RemoteNonElevatingMode): TelegramPromptPreference {
		if (mode !== 'interactive' && mode !== 'plan') {
			throw new Error('Telegram cannot select a permission-elevating mode.');
		}
		const current = this.getStored(identity, sessionId);
		const next: StoredTelegramPromptPreference = {
			pairingId: identity.pairingId,
			userId: identity.userId,
			chatId: identity.chatId,
			sessionId,
			modelId: current?.modelId,
			modelSource: current?.modelSource,
			reasoningEffort: current?.reasoningEffort,
			mode,
		};
		this.preferences.set(identity.pairingId, next);
		return toPromptPreference(next);
	}

	async consumeForDispatch(identity: TelegramPairedIdentity, sessionId: string): Promise<TelegramPreferenceResult<TelegramPromptPreference>> {
		const stored = this.getStored(identity, sessionId);
		if (!stored) {
			return { kind: 'valid', value: { mode: 'interactive' } };
		}
		if (stored.modelId) {
			const validation = await this.validateModel(stored.modelId, stored.reasoningEffort);
			if (validation.kind === 'invalid') {
				this.preferences.delete(identity.pairingId);
				await this.preferenceStore.clearSelectedModelPreference(identity, sessionId);
				return validation;
			}
			this.preferences.delete(identity.pairingId);
			return {
				kind: 'valid',
				value: {
					modelId: validation.value.modelId,
					modelSource: validation.value.modelSource,
					reasoningEffort: validation.value.reasoningEffort,
					mode: stored.mode ?? 'interactive',
				},
			};
		}
		this.preferences.delete(identity.pairingId);
		return { kind: 'valid', value: toPromptPreference(stored) };
	}

	async getStatus(identity: TelegramPairedIdentity, sessionId: string): Promise<TelegramSessionModelStatus> {
		const stored = this.getStored(identity, sessionId);
		let selectedModelId: string | undefined;
		if (stored?.modelId) {
			selectedModelId = stored.modelId;
		} else {
			try {
				selectedModelId = await this.sessionService.getSelectedModelId(sessionId, CancellationToken.None);
			} catch {
				this.logService.warn('[TelegramRemote] model-status=unavailable reason=session-read-failed');
			}
		}
		let selectedModelLabel = selectedModelId;
		if (selectedModelId) {
			try {
				const model = (await this.models.getModels()).find(candidate => candidate.id === selectedModelId || candidate.runtimeModelId === selectedModelId);
				selectedModelLabel = model ? `${formatModel(model)}${stored?.reasoningEffort ? ` · ${stored.reasoningEffort}` : ''}` : selectedModelId;
			} catch {
				this.logService.warn('[TelegramRemote] model-status=catalog-unavailable');
			}
		}
		const transient = this.preferences.get(identity.pairingId);
		const pending = transient && transient.userId === identity.userId && transient.chatId === identity.chatId && transient.sessionId === sessionId && transient.mode
			? { mode: transient.mode } satisfies TelegramPromptPreference
			: undefined;
		return {
			selectedModelId,
			selectedModelLabel,
			currentMode: this.registry.getSession(sessionId)?.getCurrentMode(),
			pending,
		};
	}

	clear(identity: TelegramPairedIdentity): void {
		this.preferences.delete(identity.pairingId);
	}

	private getStored(identity: TelegramPairedIdentity, sessionId: string): StoredTelegramPromptPreference | undefined {
		const transient = this.preferences.get(identity.pairingId);
		const matchingTransient = transient?.userId === identity.userId && transient.chatId === identity.chatId && transient.sessionId === sessionId
			? transient
			: undefined;
		const persistentModel = this.preferenceStore.getSelectedModelPreference(identity, sessionId);
		if (!matchingTransient && !persistentModel) {
			return undefined;
		}
		return {
			pairingId: identity.pairingId,
			userId: identity.userId,
			chatId: identity.chatId,
			sessionId,
			modelId: persistentModel?.modelId ?? matchingTransient?.modelId,
			modelSource: persistentModel?.modelSource ?? matchingTransient?.modelSource,
			reasoningEffort: persistentModel?.reasoningEffort ?? matchingTransient?.reasoningEffort,
			mode: matchingTransient?.mode,
		};
	}

	private async validateModel(requestedModelId: string, requestedReasoningEffort: string | undefined): Promise<TelegramPreferenceResult<{ readonly modelId: string; readonly modelSource: TelegramModelSource; readonly reasoningEffort?: string }>> {
		if (!requestedModelId.trim() || requestedModelId.length > 1024 || (requestedReasoningEffort !== undefined && (!requestedReasoningEffort.trim() || requestedReasoningEffort.length > 128))) {
			return { kind: 'invalid', error: requestedReasoningEffort ? 'unsupported-reasoning' : 'unsupported-model' };
		}
		let catalog: readonly TelegramSelectableModelInfo[];
		let model: TelegramSelectableModelInfo | undefined;
		try {
			catalog = await this.models.getModels();
			model = await this.models.resolveModel(requestedModelId);
		} catch {
			this.logService.warn('[TelegramRemote] model-validation=failed reason=catalog-unavailable');
			return { kind: 'invalid', error: 'catalog-unavailable' };
		}
		if (catalog.length === 0) {
			return { kind: 'invalid', error: 'catalog-unavailable' };
		}
		if (!model || !catalog.some(candidate => candidate.id === model.id && candidate.source === model.source)) {
			return { kind: 'invalid', error: 'unsupported-model' };
		}
		if (!requestedReasoningEffort) {
			return { kind: 'valid', value: { modelId: model.id, modelSource: model.source } };
		}
		if (!this.isReasoningEffortSelectionEnabled()) {
			return { kind: 'invalid', error: 'reasoning-disabled' };
		}
		const reasoningEffort = model.supportedReasoningEfforts?.find(effort => effort.toLocaleLowerCase() === requestedReasoningEffort.toLocaleLowerCase());
		if (!model.supportsReasoningEffort || !reasoningEffort) {
			return { kind: 'invalid', error: 'unsupported-reasoning' };
		}
		return { kind: 'valid', value: { modelId: model.id, modelSource: model.source, reasoningEffort } };
	}
}

function toPromptPreference(stored: StoredTelegramPromptPreference): TelegramPromptPreference {
	return {
		modelId: stored.modelId,
		modelSource: stored.modelSource,
		reasoningEffort: stored.reasoningEffort,
		mode: stored.mode ?? 'interactive',
	};
}

export function formatModel(model: Pick<TelegramSelectableModelInfo, 'name'>): string {
	return model.name;
}
