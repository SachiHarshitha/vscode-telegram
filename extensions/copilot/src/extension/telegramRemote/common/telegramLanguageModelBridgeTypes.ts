/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import { createServiceIdentifier } from '../../../util/common/services';
import type { IDisposable } from '../../../util/vs/base/common/lifecycle';

export const TELEGRAM_REMOTE_MODEL_SELECTION_PROPERTY = 'telegramRemoteModelId';

export type TelegramModelSource = 'copilotcli' | 'vscode-lm';

/** Model descriptor shown by Telegram. `id` is stable for command/callback use. */
export interface TelegramSelectableModelInfo {
	readonly id: string;
	/** Provider-qualified id selected inside the Copilot SDK session. */
	readonly runtimeModelId?: string;
	readonly name: string;
	readonly provider: string;
	readonly source: TelegramModelSource;
	readonly maxContextWindowTokens: number;
	readonly supportsVision?: boolean;
	readonly supportsReasoningEffort?: boolean;
	readonly defaultReasoningEffort?: string;
	readonly supportedReasoningEfforts?: readonly string[];
}

export type TelegramAdditionalModelRegistry = {
	readonly providers: NonNullable<SessionOptions['providers']>;
	readonly models: NonNullable<SessionOptions['models']>;
};

/** Resolved SDK selection plus the additive provider registry needed to execute it. */
export interface TelegramLanguageModelSelection {
	readonly model: string;
	readonly registry: TelegramAdditionalModelRegistry;
}

export interface ITelegramLanguageModelBridge extends IDisposable {
	readonly _serviceBrand: undefined;
	getModels(): Promise<readonly TelegramSelectableModelInfo[]>;
	resolveModel(value: string): Promise<TelegramSelectableModelInfo | undefined>;
	resolveSelection(modelId: string): Promise<TelegramLanguageModelSelection | undefined>;
}

export const ITelegramLanguageModelBridge = createServiceIdentifier<ITelegramLanguageModelBridge>('ITelegramLanguageModelBridge');

export interface ITelegramLmTextPart {
	readonly type: 'text';
	readonly text: string;
}

export type TelegramLmImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';

export interface ITelegramLmImagePart {
	readonly type: 'image';
	readonly mimeType: TelegramLmImageMimeType;
	readonly data: string;
}

export type ITelegramLmContentPart = ITelegramLmTextPart | ITelegramLmImagePart;

export type ITelegramLmInputItem =
	| { readonly type: 'message'; readonly role: 'system' | 'developer' | 'user' | 'assistant'; readonly content: ITelegramLmContentPart[] }
	| { readonly type: 'reasoning'; readonly id?: string; readonly summary: string[]; readonly encryptedContent?: string; readonly metadata?: Record<string, unknown> }
	| { readonly type: 'function_call'; readonly callId: string; readonly name: string; readonly argumentsJson: string }
	| { readonly type: 'function_call_output'; readonly callId: string; readonly output: string }
	| { readonly type: 'custom_tool_call'; readonly callId: string; readonly name: string; readonly input: string }
	| { readonly type: 'custom_tool_call_output'; readonly callId: string; readonly output: string };

export type ITelegramLmTool =
	| { readonly type: 'function'; readonly name: string; readonly description?: string; readonly parametersSchema?: object }
	| { readonly type: 'custom'; readonly name: string; readonly description?: string };

export interface ITelegramLmChatRequest {
	readonly modelId: string;
	readonly instructions?: string;
	readonly input: ITelegramLmInputItem[];
	readonly tools?: ITelegramLmTool[];
	readonly previousResponseId?: string;
	readonly reasoningEffort?: string;
	readonly modelOptions?: Record<string, unknown>;
}

export type ITelegramLmOutputItem =
	| { readonly type: 'message'; readonly content: ITelegramLmTextPart[] }
	| { readonly type: 'reasoning'; readonly id?: string; readonly summary: string[]; readonly encryptedContent?: string; readonly metadata?: Record<string, unknown> }
	| { readonly type: 'function_call'; readonly callId: string; readonly name: string; readonly argumentsJson: string }
	| { readonly type: 'custom_tool_call'; readonly callId: string; readonly name: string; readonly input: string };

export interface ITelegramLmChatResult {
	readonly output: ITelegramLmOutputItem[];
	readonly responseId?: string;
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly reasoningTokens?: number;
	};
	readonly error?: string;
}
