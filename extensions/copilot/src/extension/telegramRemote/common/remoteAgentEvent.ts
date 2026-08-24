/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRemoteControlSessionEvent } from './remoteControlTypes';

const maximumAssistantTextLength = 16_000;
const maximumDetailLength = 2_000;
const maximumLabelLength = 256;
const replayableRemoteAgentEventTypes = new Set([
	'session.start',
	'session.resume',
	'session.error',
	'session.task_complete',
	'session.shutdown',
	'abort',
	'assistant.message',
	'assistant.reasoning',
	'assistant.turn_start',
	'assistant.turn_end',
	'tool.execution_start',
	'tool.execution_complete',
	'subagent.started',
	'subagent.completed',
	'subagent.failed',
]);

interface RemoteAgentEventBase {
	readonly id: string;
	readonly timestamp: string;
	readonly parentId: string | null;
	readonly agentId?: string;
	readonly source: 'live' | 'replay';
}

/** Durable SDK events that may be delivered both from history replay and live execution. */
export type PersistedRemoteAgentEvent =
	| RemoteAgentEventBase & { readonly kind: 'session.start' | 'session.resume'; readonly model?: string }
	| RemoteAgentEventBase & { readonly kind: 'session.error'; readonly message: string; readonly errorType?: string }
	| RemoteAgentEventBase & { readonly kind: 'session.task_complete'; readonly success?: boolean; readonly summary?: string }
	| RemoteAgentEventBase & { readonly kind: 'session.shutdown'; readonly shutdownType: string; readonly reason?: string }
	| RemoteAgentEventBase & { readonly kind: 'abort'; readonly reason?: string }
	| RemoteAgentEventBase & { readonly kind: 'assistant.turn_start' | 'assistant.turn_end'; readonly turnId: string; readonly model?: string }
	| RemoteAgentEventBase & { readonly kind: 'assistant.message'; readonly messageId: string; readonly content: string; readonly reasoning?: string }
	| RemoteAgentEventBase & { readonly kind: 'assistant.reasoning'; readonly reasoningId: string; readonly content: string }
	| RemoteAgentEventBase & {
		readonly kind: 'tool.execution_start';
		readonly toolCallId: string;
		readonly toolName: string;
		readonly arguments?: unknown;
		readonly mcpServerName?: string;
		readonly mcpToolName?: string;
	}
	| RemoteAgentEventBase & { readonly kind: 'tool.execution_complete'; readonly toolCallId: string; readonly toolName?: string; readonly success: boolean; readonly output?: string; readonly error?: string }
	| RemoteAgentEventBase & { readonly kind: 'subagent.started'; readonly toolCallId: string; readonly name: string; readonly description?: string }
	| RemoteAgentEventBase & { readonly kind: 'subagent.completed'; readonly toolCallId: string; readonly name: string; readonly durationMs?: number; readonly totalToolCalls?: number }
	| RemoteAgentEventBase & { readonly kind: 'subagent.failed'; readonly toolCallId: string; readonly name: string; readonly error: string };

/** Transient SDK events that exist only on the live wrapper event stream. */
export type LiveRemoteAgentEvent =
	| RemoteAgentEventBase & { readonly kind: 'assistant.intent'; readonly intent: string }
	| RemoteAgentEventBase & { readonly kind: 'assistant.message_delta'; readonly messageId: string; readonly delta: string }
	| RemoteAgentEventBase & { readonly kind: 'assistant.reasoning_delta'; readonly reasoningId: string; readonly delta: string }
	| RemoteAgentEventBase & { readonly kind: 'tool.execution_progress'; readonly toolCallId: string; readonly message: string }
	| RemoteAgentEventBase & { readonly kind: 'tool.execution_partial_result'; readonly toolCallId: string; readonly output: string }
	| RemoteAgentEventBase & { readonly kind: 'session.idle'; readonly aborted: boolean }
	| RemoteAgentEventBase & { readonly kind: 'session.usage_info'; readonly currentTokens: number; readonly tokenLimit: number }
	| RemoteAgentEventBase & { readonly kind: 'assistant.usage'; readonly model: string; readonly inputTokens?: number; readonly outputTokens?: number };

export type RemoteAgentEvent = PersistedRemoteAgentEvent | LiveRemoteAgentEvent;

export function isReplayableRemoteAgentEventType(type: string): boolean {
	return replayableRemoteAgentEventTypes.has(type);
}

/** Projects the verified @github/copilot 1.0.73 event subset without exposing SDK objects to Telegram. */
export function projectRemoteAgentEvent(event: IRemoteControlSessionEvent): RemoteAgentEvent | undefined {
	const data = asRecord(event.data);
	if (!data) {
		return undefined;
	}
	const base: RemoteAgentEventBase = {
		id: event.id,
		timestamp: event.timestamp,
		parentId: event.parentId,
		agentId: event.agentId,
		source: event.replay ? 'replay' : 'live',
	};

	switch (event.type) {
		case 'session.start':
		case 'session.resume':
			return { ...base, kind: event.type, model: readString(data, 'selectedModel', maximumLabelLength) };
		case 'session.error': {
			const message = readRequiredString(data, 'message', maximumDetailLength);
			return message ? { ...base, kind: event.type, message, errorType: readString(data, 'errorType', maximumLabelLength) } : undefined;
		}
		case 'session.task_complete':
			return {
				...base,
				kind: event.type,
				success: readBoolean(data, 'success'),
				summary: readString(data, 'summary', maximumDetailLength),
			};
		case 'session.shutdown': {
			const shutdownType = readRequiredString(data, 'shutdownType', maximumLabelLength);
			return shutdownType ? { ...base, kind: event.type, shutdownType, reason: readString(data, 'errorReason', maximumDetailLength) } : undefined;
		}
		case 'abort':
			return { ...base, kind: event.type, reason: readString(data, 'reason', maximumLabelLength) };
		case 'assistant.turn_start':
		case 'assistant.turn_end': {
			const turnId = readRequiredString(data, 'turnId', maximumLabelLength);
			return turnId ? { ...base, kind: event.type, turnId, model: readString(data, 'model', maximumLabelLength) } : undefined;
		}
		case 'assistant.intent': {
			const intent = readRequiredString(data, 'intent', maximumDetailLength);
			return intent ? { ...base, kind: event.type, intent } : undefined;
		}
		case 'assistant.message': {
			const messageId = readRequiredString(data, 'messageId', maximumLabelLength);
			const content = readString(data, 'content', maximumAssistantTextLength);
			return messageId && content !== undefined ? {
				...base,
				kind: event.type,
				messageId,
				content,
				reasoning: readString(data, 'reasoningText', maximumDetailLength),
			} : undefined;
		}
		case 'assistant.message_delta': {
			const messageId = readRequiredString(data, 'messageId', maximumLabelLength);
			const delta = readRequiredString(data, 'deltaContent', maximumDetailLength);
			return messageId && delta ? { ...base, kind: event.type, messageId, delta } : undefined;
		}
		case 'assistant.reasoning': {
			const reasoningId = readRequiredString(data, 'reasoningId', maximumLabelLength);
			const content = readRequiredString(data, 'content', maximumAssistantTextLength);
			return reasoningId && content ? { ...base, kind: event.type, reasoningId, content } : undefined;
		}
		case 'assistant.reasoning_delta': {
			const reasoningId = readRequiredString(data, 'reasoningId', maximumLabelLength);
			const delta = readRequiredString(data, 'deltaContent', maximumDetailLength);
			return reasoningId && delta ? { ...base, kind: event.type, reasoningId, delta } : undefined;
		}
		case 'tool.execution_start': {
			const toolCallId = readRequiredString(data, 'toolCallId', maximumLabelLength);
			const toolName = readRequiredString(data, 'toolName', maximumLabelLength);
			return toolCallId && toolName ? {
				...base,
				kind: event.type,
				toolCallId,
				toolName,
				arguments: projectBoundedValue(data.arguments),
				mcpServerName: readString(data, 'mcpServerName', maximumLabelLength),
				mcpToolName: readString(data, 'mcpToolName', maximumLabelLength),
			} : undefined;
		}
		case 'tool.execution_progress': {
			const toolCallId = readRequiredString(data, 'toolCallId', maximumLabelLength);
			const message = readRequiredString(data, 'progressMessage', maximumDetailLength);
			return toolCallId && message ? { ...base, kind: event.type, toolCallId, message } : undefined;
		}
		case 'tool.execution_partial_result': {
			const toolCallId = readRequiredString(data, 'toolCallId', maximumLabelLength);
			const output = readRequiredString(data, 'partialOutput', maximumDetailLength);
			return toolCallId && output ? { ...base, kind: event.type, toolCallId, output } : undefined;
		}
		case 'tool.execution_complete': {
			const toolCallId = readRequiredString(data, 'toolCallId', maximumLabelLength);
			const success = readBoolean(data, 'success');
			if (!toolCallId || success === undefined) {
				return undefined;
			}
			const result = asRecord(data.result);
			const error = asRecord(data.error);
			return {
				...base,
				kind: event.type,
				toolCallId,
				toolName: readString(data, 'toolName', maximumLabelLength) ?? readString(asRecord(data.toolDescription), 'name', maximumLabelLength),
				success,
				output: result ? readString(result, 'detailedContent', maximumDetailLength) ?? readString(result, 'content', maximumDetailLength) : undefined,
				error: error ? readString(error, 'message', maximumDetailLength) : undefined,
			};
		}
		case 'subagent.started': {
			const common = readSubagent(data);
			return common ? { ...base, kind: event.type, ...common, description: readString(data, 'agentDescription', maximumDetailLength) } : undefined;
		}
		case 'subagent.completed': {
			const common = readSubagent(data);
			return common ? {
				...base,
				kind: event.type,
				...common,
				durationMs: readNonNegativeNumber(data, 'durationMs'),
				totalToolCalls: readNonNegativeNumber(data, 'totalToolCalls'),
			} : undefined;
		}
		case 'subagent.failed': {
			const common = readSubagent(data);
			const error = readRequiredString(data, 'error', maximumDetailLength);
			return common && error ? { ...base, kind: event.type, ...common, error } : undefined;
		}
		case 'session.idle':
			return { ...base, kind: event.type, aborted: readBoolean(data, 'aborted') ?? false };
		case 'session.usage_info': {
			const currentTokens = readNonNegativeNumber(data, 'currentTokens');
			const tokenLimit = readNonNegativeNumber(data, 'tokenLimit');
			return currentTokens !== undefined && tokenLimit !== undefined && tokenLimit > 0
				? { ...base, kind: event.type, currentTokens, tokenLimit }
				: undefined;
		}
		case 'assistant.usage': {
			const model = readRequiredString(data, 'model', maximumLabelLength);
			return model ? {
				...base,
				kind: event.type,
				model,
				inputTokens: readNonNegativeNumber(data, 'inputTokens'),
				outputTokens: readNonNegativeNumber(data, 'outputTokens'),
			} : undefined;
		}
		default:
			// Interactive request events are deliberately handled by registry workflows in later phases.
			return undefined;
	}
}

function readSubagent(data: Readonly<Record<string, unknown>>): { readonly toolCallId: string; readonly name: string } | undefined {
	const toolCallId = readRequiredString(data, 'toolCallId', maximumLabelLength);
	const name = readRequiredString(data, 'agentDisplayName', maximumLabelLength) ?? readRequiredString(data, 'agentName', maximumLabelLength);
	return toolCallId && name ? { toolCallId, name } : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function readString(record: Readonly<Record<string, unknown>> | undefined, key: string, maximumLength: number): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' ? truncate(value, maximumLength) : undefined;
}

function readRequiredString(record: Readonly<Record<string, unknown>>, key: string, maximumLength: number): string | undefined {
	const value = readString(record, key, maximumLength);
	return value && value.trim().length > 0 ? value : undefined;
}

function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
	return typeof record[key] === 'boolean' ? record[key] : undefined;
}

function readNonNegativeNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function projectBoundedValue(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		return truncate(value, maximumDetailLength);
	}
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
		return value;
	}
	if (depth >= 4) {
		return '[nested value omitted]';
	}
	if (Array.isArray(value)) {
		return value.slice(0, 32).map(item => projectBoundedValue(item, depth + 1));
	}
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	return Object.fromEntries(Object.entries(record).slice(0, 32).map(([key, item]) => [truncate(key, maximumLabelLength), projectBoundedValue(item, depth + 1)]));
}
