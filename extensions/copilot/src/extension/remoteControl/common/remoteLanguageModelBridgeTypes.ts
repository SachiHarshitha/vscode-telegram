/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import { createServiceIdentifier } from '../../../util/common/services';
import type { IDisposable } from '../../../util/vs/base/common/lifecycle';

export const REMOTE_CONTROL_MODEL_SELECTION_PROPERTY = 'remoteControlModelId';

export type RemoteModelSource = 'copilotcli' | 'vscode-lm';

/** Model descriptor exposed to an internal remote-control transport. */
export interface RemoteSelectableModelInfo {
	readonly id: string;
	readonly runtimeModelId?: string;
	readonly name: string;
	readonly provider: string;
	readonly source: RemoteModelSource;
	readonly maxContextWindowTokens: number;
	readonly supportsVision?: boolean;
	readonly supportsReasoningEffort?: boolean;
	readonly defaultReasoningEffort?: string;
	readonly supportedReasoningEfforts?: readonly string[];
}

export type RemoteAdditionalModelRegistry = {
	readonly providers: NonNullable<SessionOptions['providers']>;
	readonly models: NonNullable<SessionOptions['models']>;
};

export interface RemoteLanguageModelSelection {
	readonly model: string;
	readonly registry: RemoteAdditionalModelRegistry;
}

/** Transport-neutral model catalogue and external-model selection seam. */
export interface IRemoteLanguageModelBridge extends IDisposable {
	readonly _serviceBrand: undefined;
	getModels(): Promise<readonly RemoteSelectableModelInfo[]>;
	resolveModel(value: string): Promise<RemoteSelectableModelInfo | undefined>;
	resolveSelection(modelId: string): Promise<RemoteLanguageModelSelection | undefined>;
}

export const IRemoteLanguageModelBridge = createServiceIdentifier<IRemoteLanguageModelBridge>('IRemoteLanguageModelBridge');
