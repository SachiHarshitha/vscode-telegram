/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { RemoteAgentEvent } from '../common/remoteAgentEvent';

export const telegramMaximumMessageLength = 4096;
const maximumRenderedChunks = 4;
const maximumActionDetailLength = 600;

export interface TelegramActivityAction {
	readonly key: string;
	readonly text: string;
}

export interface TelegramActivityMutation {
	readonly action?: TelegramActivityAction;
	readonly response?: { readonly messageId: string; readonly text: string; readonly append: boolean };
	readonly reasoning?: { readonly reasoningId: string; readonly text: string; readonly append: boolean };
	readonly usage?: string;
	readonly terminal?: boolean;
	readonly urgent?: boolean;
}

export interface TelegramActivitySnapshot {
	readonly workstation: string;
	readonly workspace: string;
	readonly session: string;
	readonly actions: readonly string[];
	readonly response?: string;
	readonly reasoning?: string;
	readonly usage?: string;
	readonly complete: boolean;
}

/** Converts one projected event into bounded, presentation-ready activity state changes. */
export function renderTelegramEvent(event: RemoteAgentEvent): TelegramActivityMutation {
	switch (event.kind) {
		case 'session.start':
			return { action: action('session', event.model ? l10n.t('Session started with {0}.', event.model) : l10n.t('Session started.')) };
		case 'session.resume':
			return { action: action('session', event.model ? l10n.t('Session resumed with {0}.', event.model) : l10n.t('Session resumed.')) };
		case 'session.error':
			return { action: action('session-error', l10n.t('Session error: {0}', bounded(event.message))), urgent: true };
		case 'session.task_complete':
			return {
				action: action('task-complete', event.summary
					? l10n.t('{0}: {1}', event.success === false ? l10n.t('Task failed') : l10n.t('Task completed'), bounded(event.summary))
					: event.success === false ? l10n.t('Task failed.') : l10n.t('Task completed.')),
				terminal: true,
			};
		case 'session.shutdown':
			return { action: action('session', event.reason ? l10n.t('Session stopped: {0}', bounded(event.reason)) : l10n.t('Session stopped.')), terminal: true };
		case 'abort':
			return { action: action('abort', event.reason ? l10n.t('Task aborted: {0}', bounded(event.reason)) : l10n.t('Task aborted.')), terminal: true };
		case 'assistant.turn_start':
			return { action: action('turn', event.model ? l10n.t('Agent turn started with {0}.', event.model) : l10n.t('Agent turn started.')) };
		case 'assistant.turn_end':
			return { action: action('turn', l10n.t('Agent turn completed.')) };
		case 'assistant.intent':
			return { action: action('intent', l10n.t('Agent: {0}', bounded(event.intent))) };
		case 'assistant.message':
			return {
				response: { messageId: event.messageId, text: event.content, append: false },
				reasoning: event.reasoning ? { reasoningId: event.messageId, text: event.reasoning, append: false } : undefined,
				urgent: true,
			};
		case 'assistant.message_delta':
			return { response: { messageId: event.messageId, text: event.delta, append: true } };
		case 'assistant.reasoning':
			return { reasoning: { reasoningId: event.reasoningId, text: event.content, append: false } };
		case 'assistant.reasoning_delta':
			return { reasoning: { reasoningId: event.reasoningId, text: event.delta, append: true } };
		case 'tool.execution_start':
			return { action: action(`tool:${event.toolCallId}`, l10n.t('Running tool: {0}', event.toolName)) };
		case 'tool.execution_progress':
			return { action: action(`tool:${event.toolCallId}`, l10n.t('Tool progress: {0}', bounded(event.message))) };
		case 'tool.execution_partial_result':
			return { action: action(`tool:${event.toolCallId}`, l10n.t('Tool output: {0}', bounded(event.output))) };
		case 'tool.execution_complete': {
			const name = event.toolName ?? l10n.t('Tool');
			const detail = event.success ? event.output : event.error ?? event.output;
			return { action: action(`tool:${event.toolCallId}`, detail
				? l10n.t('{0} {1}: {2}', name, event.success ? l10n.t('completed') : l10n.t('failed'), bounded(detail))
				: l10n.t('{0} {1}.', name, event.success ? l10n.t('completed') : l10n.t('failed'))) };
		}
		case 'subagent.started':
			return { action: action(`subagent:${event.toolCallId}`, event.description
				? l10n.t('Subagent {0} started: {1}', event.name, bounded(event.description))
				: l10n.t('Subagent {0} started.', event.name)) };
		case 'subagent.completed': {
			const detail = [
				event.durationMs === undefined ? undefined : l10n.t('{0}s', Math.round(event.durationMs / 100) / 10),
				event.totalToolCalls === undefined ? undefined : l10n.t('{0} tools', event.totalToolCalls),
			].filter((value): value is string => !!value).join(', ');
			return { action: action(`subagent:${event.toolCallId}`, detail
				? l10n.t('Subagent {0} completed ({1}).', event.name, detail)
				: l10n.t('Subagent {0} completed.', event.name)) };
		}
		case 'subagent.failed':
			return { action: action(`subagent:${event.toolCallId}`, l10n.t('Subagent {0} failed: {1}', event.name, bounded(event.error))), urgent: true };
		case 'session.idle':
			return { action: action('session', event.aborted ? l10n.t('Session is idle after cancellation.') : l10n.t('Session is idle.')), terminal: true };
		case 'session.usage_info':
			return { usage: l10n.t('Context: {0}% ({1} / {2} tokens)', Math.min(100, Math.round(event.currentTokens / event.tokenLimit * 100)), event.currentTokens, event.tokenLimit) };
		case 'assistant.usage': {
			const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
			return { usage: tokens > 0 ? l10n.t('Latest model call: {0}, {1} tokens', event.model, tokens) : l10n.t('Latest model call: {0}', event.model) };
		}
	}
}

/** Renders a complete activity card as independently valid MarkdownV2 chunks. */
export function renderTelegramActivity(snapshot: TelegramActivitySnapshot): readonly string[] {
	const sections = [
		`*${escapeTelegramMarkdownV2(l10n.t('Copilot activity'))}*`,
		`*${escapeTelegramMarkdownV2(l10n.t('Workstation'))}:* ${escapeActivityValue(snapshot.workstation)}`,
		`*${escapeTelegramMarkdownV2(l10n.t('Workspace'))}:* ${escapeActivityValue(snapshot.workspace)}`,
		`*${escapeTelegramMarkdownV2(l10n.t('Session'))}:* ${escapeActivityValue(snapshot.session)}`,
		snapshot.actions.length > 0
			? `*${escapeTelegramMarkdownV2(l10n.t('Recent activity'))}*\n${snapshot.actions.map(item => `• ${escapeActivityValue(item)}`).join('\n')}`
			: undefined,
		snapshot.reasoning
			? `*${escapeTelegramMarkdownV2(l10n.t('Exposed model reasoning'))}*\n${escapeActivityValue(snapshot.reasoning)}`
			: undefined,
		snapshot.response
			? `*${escapeTelegramMarkdownV2(l10n.t('Response'))}*\n${escapeActivityValue(snapshot.response)}`
			: undefined,
		snapshot.usage
			? `*${escapeTelegramMarkdownV2(l10n.t('Usage'))}*\n${escapeActivityValue(snapshot.usage)}`
			: undefined,
		snapshot.complete ? `_${escapeTelegramMarkdownV2(l10n.t('Activity complete'))}_` : undefined,
	].filter((section): section is string => !!section);
	return splitTelegramMarkdownV2(sections.join('\n\n'));
}

/** Escapes all user/runtime-controlled characters required by Telegram MarkdownV2. */
export function escapeTelegramMarkdownV2(value: string): string {
	return value.replace(/([_\-*\[\]()~`>#+=|{}.!\\])/g, '\\$1');
}

function splitTelegramMarkdownV2(value: string): readonly string[] {
	const maximumTotalLength = telegramMaximumMessageLength * maximumRenderedChunks;
	const truncation = `\n\n_${escapeTelegramMarkdownV2(l10n.t('Output truncated'))}_`;
	const boundedValue = value.length > maximumTotalLength
		? `${value.slice(0, maximumTotalLength - truncation.length)}${truncation}`
		: value;
	const chunks: string[] = [];
	let remaining = boundedValue;
	while (remaining.length > telegramMaximumMessageLength && chunks.length < maximumRenderedChunks - 1) {
		let splitAt = remaining.lastIndexOf('\n', telegramMaximumMessageLength);
		if (splitAt < Math.floor(telegramMaximumMessageLength * 0.7)) {
			splitAt = telegramMaximumMessageLength;
		}
		if (remaining.charCodeAt(splitAt - 1) >= 0xD800 && remaining.charCodeAt(splitAt - 1) <= 0xDBFF) {
			splitAt--;
		}
		let trailingBackslashes = 0;
		for (let index = splitAt - 1; index >= 0 && remaining[index] === '\\'; index--) {
			trailingBackslashes++;
		}
		if (trailingBackslashes % 2 === 1) {
			splitAt--;
		}
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n+/, '');
	}
	if (remaining.length > telegramMaximumMessageLength) {
		let splitAt = telegramMaximumMessageLength - truncation.length;
		if (remaining.charCodeAt(splitAt - 1) >= 0xD800 && remaining.charCodeAt(splitAt - 1) <= 0xDBFF) {
			splitAt--;
		}
		if (remaining[splitAt - 1] === '\\') {
			splitAt--;
		}
		remaining = `${remaining.slice(0, splitAt)}${truncation}`;
	}
	if (remaining) {
		chunks.push(remaining);
	}
	return chunks;
}

function action(key: string, text: string): TelegramActivityAction {
	return { key, text: bounded(text) };
}

function bounded(value: string): string {
	return value.length <= maximumActionDetailLength ? value : `${value.slice(0, maximumActionDetailLength - 1)}…`;
}

function escapeActivityValue(value: string): string {
	return escapeTelegramMarkdownV2(redactActivitySecrets(value));
}

function redactActivitySecrets(value: string): string {
	return value
		.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted bot token]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
		.replace(/\b(api[_-]?key|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}
