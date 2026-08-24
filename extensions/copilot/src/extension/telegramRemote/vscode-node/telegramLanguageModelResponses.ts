/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ITelegramLmChatRequest,
	ITelegramLmChatResult,
	ITelegramLmContentPart,
	ITelegramLmInputItem,
	ITelegramLmOutputItem,
	ITelegramLmTool,
	TelegramLmImageMimeType,
} from '../common/telegramLanguageModelBridgeTypes';

interface IResponsesContentPart {
	readonly type?: string;
	readonly text?: string;
	readonly image_url?: string;
}

interface IResponsesInputItem {
	readonly type?: string;
	readonly role?: string;
	readonly content?: string | IResponsesContentPart[];
	readonly id?: string;
	readonly summary?: Array<{ readonly type?: string; readonly text?: string }>;
	readonly encrypted_content?: string | null;
	readonly call_id?: string;
	readonly name?: string;
	readonly arguments?: string;
	readonly input?: string;
	readonly output?: string;
}

interface IResponsesTool {
	readonly type?: string;
	readonly name?: string;
	readonly description?: string;
	readonly parameters?: object;
}

export interface IResponsesRequest {
	readonly model?: string;
	readonly instructions?: string;
	readonly input?: string | IResponsesInputItem[];
	readonly tools?: IResponsesTool[];
	readonly previous_response_id?: string;
	readonly reasoning?: { readonly effort?: string };
	readonly temperature?: number;
	readonly top_p?: number;
	readonly max_output_tokens?: number;
	readonly stream?: boolean;
	readonly [key: string]: unknown;
}

export class ResponsesTranslationError extends Error { }

function requiredString(value: string | undefined, path: string): string {
	if (!value) {
		throw new ResponsesTranslationError(`${path} is required`);
	}
	return value;
}

function toRole(role: string | undefined): 'system' | 'developer' | 'user' | 'assistant' {
	switch (role) {
		case 'system':
		case 'developer':
		case 'assistant':
		case 'user':
			return role;
		default:
			throw new ResponsesTranslationError(`Unsupported message role '${role ?? ''}'`);
	}
}

function isImageMimeType(value: string): value is TelegramLmImageMimeType {
	return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp' || value === 'image/bmp';
}

function toContentParts(content: string | IResponsesContentPart[] | undefined, itemIndex: number): ITelegramLmContentPart[] {
	if (typeof content === 'string') {
		return content ? [{ type: 'text', text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	return content.map((part, contentIndex) => {
		if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
			return { type: 'text' as const, text: part.text };
		}
		if (part.type === 'input_image' && typeof part.image_url === 'string') {
			const match = /^data:(?<mimeType>image\/[^;,]+)(?:;[^,]*)?;base64,(?<data>.*)$/.exec(part.image_url);
			if (!match?.groups || !isImageMimeType(match.groups.mimeType)) {
				throw new ResponsesTranslationError(`Unsupported input[${itemIndex}].content[${contentIndex}].image_url`);
			}
			try {
				Buffer.from(match.groups.data, 'base64');
			} catch {
				throw new ResponsesTranslationError(`Invalid input[${itemIndex}].content[${contentIndex}].image_url`);
			}
			return { type: 'image' as const, mimeType: match.groups.mimeType, data: match.groups.data };
		}
		throw new ResponsesTranslationError(`Unsupported input[${itemIndex}].content[${contentIndex}] type '${part.type ?? ''}'`);
	});
}

function toInputItem(item: IResponsesInputItem, index: number): ITelegramLmInputItem {
	switch (item.type) {
		case 'message':
			return { type: 'message', role: toRole(item.role), content: toContentParts(item.content, index) };
		case 'reasoning':
			return {
				type: 'reasoning',
				id: item.id,
				summary: (item.summary ?? []).map((part, summaryIndex) => {
					if (part.type !== 'summary_text' || typeof part.text !== 'string') {
						throw new ResponsesTranslationError(`Unsupported input[${index}].summary[${summaryIndex}]`);
					}
					return part.text;
				}),
				encryptedContent: item.encrypted_content ?? undefined,
			};
		case 'function_call':
			return { type: 'function_call', callId: requiredString(item.call_id, `input[${index}].call_id`), name: requiredString(item.name, `input[${index}].name`), argumentsJson: item.arguments ?? '{}' };
		case 'function_call_output':
			return { type: 'function_call_output', callId: requiredString(item.call_id, `input[${index}].call_id`), output: item.output ?? '' };
		case 'custom_tool_call':
			return { type: 'custom_tool_call', callId: requiredString(item.call_id, `input[${index}].call_id`), name: requiredString(item.name, `input[${index}].name`), input: item.input ?? '' };
		case 'custom_tool_call_output':
			return { type: 'custom_tool_call_output', callId: requiredString(item.call_id, `input[${index}].call_id`), output: item.output ?? '' };
		default:
			throw new ResponsesTranslationError(`Unsupported input[${index}] type '${item.type ?? ''}'`);
	}
}

function toTools(tools: IResponsesTool[] | undefined): ITelegramLmTool[] | undefined {
	if (!tools?.length) {
		return undefined;
	}
	return tools.map((tool, index) => {
		switch (tool.type) {
			case 'function':
				return { type: 'function' as const, name: requiredString(tool.name, `tools[${index}].name`), description: tool.description, parametersSchema: tool.parameters };
			case 'custom':
				return { type: 'custom' as const, name: requiredString(tool.name, `tools[${index}].name`), description: tool.description };
			default:
				throw new ResponsesTranslationError(`Unsupported tools[${index}] type '${tool.type ?? ''}'`);
		}
	});
}

export function responsesRequestToBridge(body: IResponsesRequest): ITelegramLmChatRequest {
	const modelId = requiredString(body.model, 'model');
	const input = typeof body.input === 'string'
		? [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const, text: body.input }] }]
		: Array.isArray(body.input) ? body.input.map(toInputItem) : [];
	const modelOptions: Record<string, unknown> = {};
	if (typeof body.temperature === 'number') {
		modelOptions.temperature = body.temperature;
	}
	if (typeof body.top_p === 'number') {
		modelOptions.top_p = body.top_p;
	}
	if (typeof body.max_output_tokens === 'number') {
		modelOptions.max_tokens = body.max_output_tokens;
	}
	return {
		modelId,
		instructions: body.instructions,
		input,
		tools: toTools(body.tools),
		previousResponseId: body.previous_response_id,
		reasoningEffort: body.reasoning?.effort,
		modelOptions: Object.keys(modelOptions).length ? modelOptions : undefined,
	};
}

let responseCounter = 0;

function nextId(prefix: string): string {
	responseCounter = (responseCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `${prefix}_telegram_${Date.now().toString(36)}_${responseCounter.toString(36)}`;
}

function sseEvent(eventName: string, data: unknown): string {
	return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

type ResponsesOutputItem =
	| { readonly id: string; readonly type: 'message'; readonly role: 'assistant'; readonly status: 'completed'; readonly content: Array<{ readonly type: 'output_text'; readonly text: string; readonly annotations: unknown[]; readonly logprobs: unknown[] }> }
	| { readonly id: string; readonly type: 'reasoning'; readonly status: 'completed'; readonly summary: Array<{ readonly type: 'summary_text'; readonly text: string }>; readonly encrypted_content: string | null }
	| { readonly id: string; readonly type: 'function_call'; readonly status: 'completed'; readonly call_id: string; readonly name: string; readonly arguments: string }
	| { readonly id: string; readonly type: 'custom_tool_call'; readonly status: 'completed'; readonly call_id: string; readonly name: string; readonly input: string };

function toOutputItem(item: ITelegramLmOutputItem): ResponsesOutputItem {
	switch (item.type) {
		case 'message':
			return { id: nextId('msg'), type: 'message', role: 'assistant', status: 'completed', content: item.content.map(part => ({ type: 'output_text', text: part.text, annotations: [], logprobs: [] })) };
		case 'reasoning':
			return { id: item.id?.startsWith('rs') ? item.id : nextId('rs'), type: 'reasoning', status: 'completed', summary: item.summary.map(text => ({ type: 'summary_text', text })), encrypted_content: item.encryptedContent ?? null };
		case 'function_call':
			return { id: nextId('fc'), type: 'function_call', status: 'completed', call_id: item.callId, name: item.name, arguments: item.argumentsJson };
		case 'custom_tool_call':
			return { id: nextId('ctc'), type: 'custom_tool_call', status: 'completed', call_id: item.callId, name: item.name, input: item.input };
	}
}

function inProgress(item: ResponsesOutputItem): object {
	switch (item.type) {
		case 'message': return { ...item, status: 'in_progress', content: [] };
		case 'reasoning': return { ...item, status: 'in_progress', summary: [], encrypted_content: null };
		case 'function_call': return { ...item, status: 'in_progress', arguments: '' };
		case 'custom_tool_call': return { ...item, status: 'in_progress', input: '' };
	}
}

function envelope(id: string, model: string, status: 'in_progress' | 'completed', output: readonly ResponsesOutputItem[], usage: unknown) {
	return {
		id,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		status,
		error: null,
		incomplete_details: null,
		instructions: null,
		model,
		output,
		output_text: output.filter((item): item is Extract<ResponsesOutputItem, { type: 'message' }> => item.type === 'message').flatMap(item => item.content).map(part => part.text).join(''),
		parallel_tool_calls: true,
		temperature: 1,
		tool_choice: 'auto',
		tools: [],
		top_p: 1,
		usage,
	};
}

function prepare(result: ITelegramLmChatResult, model: string) {
	const responseId = result.responseId ?? nextId('resp');
	const output = result.output.map(toOutputItem);
	const inputTokens = result.usage?.inputTokens ?? 0;
	const outputTokens = result.usage?.outputTokens ?? 0;
	const usage = {
		input_tokens: inputTokens,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: outputTokens,
		output_tokens_details: { reasoning_tokens: result.usage?.reasoningTokens ?? 0 },
		total_tokens: inputTokens + outputTokens,
	};
	return { responseId, output, completed: envelope(responseId, model, 'completed', output, usage) };
}

export function bridgeResultToResponsesBody(result: ITelegramLmChatResult, model: string): string {
	return JSON.stringify(prepare(result, model).completed);
}

export function bridgeResultToResponsesSseFrames(result: ITelegramLmChatResult, model: string): string[] {
	const { responseId, output, completed } = prepare(result, model);
	let sequence = 0;
	const frames: string[] = [];
	const skeleton = envelope(responseId, model, 'in_progress', [], undefined);
	frames.push(sseEvent('response.created', { type: 'response.created', sequence_number: sequence++, response: skeleton }));
	frames.push(sseEvent('response.in_progress', { type: 'response.in_progress', sequence_number: sequence++, response: skeleton }));

	output.forEach((item, outputIndex) => {
		frames.push(sseEvent('response.output_item.added', { type: 'response.output_item.added', sequence_number: sequence++, output_index: outputIndex, item: inProgress(item) }));
		if (item.type === 'message') {
			item.content.forEach((part, contentIndex) => {
				frames.push(sseEvent('response.content_part.added', { type: 'response.content_part.added', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } }));
				frames.push(sseEvent('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text, logprobs: [] }));
				frames.push(sseEvent('response.output_text.done', { type: 'response.output_text.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text, logprobs: [] }));
				frames.push(sseEvent('response.content_part.done', { type: 'response.content_part.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, content_index: contentIndex, part }));
			});
		} else if (item.type === 'reasoning') {
			item.summary.forEach((part, summaryIndex) => {
				frames.push(sseEvent('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, summary_index: summaryIndex, part: { type: 'summary_text', text: '' } }));
				frames.push(sseEvent('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, summary_index: summaryIndex, delta: part.text }));
				frames.push(sseEvent('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, summary_index: summaryIndex, text: part.text }));
				frames.push(sseEvent('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, summary_index: summaryIndex, part }));
			});
		} else if (item.type === 'function_call') {
			frames.push(sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, delta: item.arguments }));
			frames.push(sseEvent('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, arguments: item.arguments }));
		} else {
			frames.push(sseEvent('response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, delta: item.input }));
			frames.push(sseEvent('response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', sequence_number: sequence++, item_id: item.id, output_index: outputIndex, input: item.input }));
		}
		frames.push(sseEvent('response.output_item.done', { type: 'response.output_item.done', sequence_number: sequence++, output_index: outputIndex, item }));
	});

	frames.push(sseEvent('response.completed', { type: 'response.completed', sequence_number: sequence++, response: completed }));
	return frames;
}

export function responsesErrorBody(message: string, type = 'api_error'): string {
	return JSON.stringify({ error: { message, type } });
}
