/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IRemoteLanguageModelBridge,
	REMOTE_CONTROL_MODEL_SELECTION_PROPERTY,
	type RemoteAdditionalModelRegistry,
	type RemoteLanguageModelSelection,
	type RemoteModelSource,
	type RemoteSelectableModelInfo,
} from '../../remoteControl/common/remoteLanguageModelBridgeTypes';

export const TELEGRAM_REMOTE_MODEL_SELECTION_PROPERTY = REMOTE_CONTROL_MODEL_SELECTION_PROPERTY;
export type TelegramModelSource = RemoteModelSource;
export type TelegramSelectableModelInfo = RemoteSelectableModelInfo;
export type TelegramAdditionalModelRegistry = RemoteAdditionalModelRegistry;
export type TelegramLanguageModelSelection = RemoteLanguageModelSelection;
export type ITelegramLanguageModelBridge = IRemoteLanguageModelBridge;
export const ITelegramLanguageModelBridge = IRemoteLanguageModelBridge;

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
