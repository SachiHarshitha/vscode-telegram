/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { RemoteAgentEvent } from '../common/remoteAgentEvent';
import { escapeTelegramHtml, redactTelegramSecrets, telegramMaximumMessageLength } from './telegramMarkdown';

export type TelegramActivityDetail = 'compact' | 'detailed' | 'debug';

export interface TelegramActivityAction {
	readonly key: string;
	readonly text: string;
	readonly detail?: string;
}

export interface TelegramActivityMutation {
	readonly action?: TelegramActivityAction;
	readonly response?: { readonly messageId: string; readonly text: string; readonly append: boolean };
	readonly reasoning?: { readonly reasoningId: string; readonly text: string; readonly append: boolean };
	readonly usage?: string;
	readonly terminal?: TelegramActivityTerminalOutcome;
	readonly urgent?: boolean;
}

export type TelegramActivityTerminalOutcome = 'completed' | 'failed' | 'cancelled';

export interface TelegramActivitySnapshot {
	readonly workstation: string;
	readonly workspace: string;
	readonly session: string;
	readonly actions: readonly TelegramActivityAction[];
	readonly reasoning?: string;
	readonly usage?: string;
	readonly complete: boolean;
	readonly detail: TelegramActivityDetail;
}

export interface TelegramEventRenderOptions {
	readonly detail: TelegramActivityDetail;
	readonly correlatedToolName?: string;
}

/** Converts one projected event into bounded semantic activity changes without exposing raw output in compact mode. */
export function renderTelegramEvent(event: RemoteAgentEvent, options: TelegramEventRenderOptions): TelegramActivityMutation {
	switch (event.kind) {
		case 'session.start':
			return { action: action('session', event.model ? l10n.t('Session started with {0}', event.model) : l10n.t('Session started')) };
		case 'session.resume':
			return { action: action('session', event.model ? l10n.t('Session resumed with {0}', event.model) : l10n.t('Session resumed')) };
		case 'session.error':
			return { action: action('session-error', l10n.t('Session failed — {0}', safeFailureSummary(event.message))), urgent: true };
		case 'session.task_complete':
			return {
				action: action('task-complete', event.success === false ? l10n.t('Task failed') : l10n.t('Task completed'), options.detail === 'compact' ? undefined : event.summary),
				terminal: event.success === false ? 'failed' : 'completed',
			};
		case 'session.shutdown':
			return { action: action('session', l10n.t('Session stopped'), options.detail === 'compact' ? undefined : event.reason), terminal: 'failed' };
		case 'abort':
			return { action: action('abort', l10n.t('Task stopped'), options.detail === 'compact' ? undefined : event.reason), terminal: 'cancelled' };
		case 'assistant.turn_start':
			return { action: action('turn', l10n.t('Copilot is working')) };
		case 'assistant.turn_end':
			return { action: action('turn', l10n.t('Copilot finished the turn')) };
		case 'assistant.intent':
			return { action: action('intent', l10n.t('Copilot is planning')) };
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
			return { action: action(`tool:${event.toolCallId}`, runningToolSummary(event.toolName)) };
		case 'tool.execution_progress':
			return { action: action(`tool:${event.toolCallId}`, runningToolSummary(options.correlatedToolName), options.detail === 'compact' ? undefined : event.message) };
		case 'tool.execution_partial_result':
			return options.detail === 'compact'
				? { action: action(`tool:${event.toolCallId}`, runningToolSummary(options.correlatedToolName)) }
				: { action: action(`tool:${event.toolCallId}`, runningToolSummary(options.correlatedToolName), event.output) };
		case 'tool.execution_complete': {
			const name = event.toolName ?? options.correlatedToolName;
			const detail = event.success ? event.output : event.error ?? event.output;
			return {
				action: action(
					`tool:${event.toolCallId}`,
					event.success ? completedToolSummary(name) : l10n.t('{0} failed — {1}', humanizeToolName(name), safeFailureSummary(detail ?? l10n.t('unknown error'))),
					options.detail === 'compact' ? undefined : detail,
				),
				urgent: !event.success,
			};
		}
		case 'subagent.started':
			return { action: action(`subagent:${event.toolCallId}`, l10n.t('Subagent {0} started', event.name), options.detail === 'compact' ? undefined : event.description) };
		case 'subagent.completed':
			return { action: action(`subagent:${event.toolCallId}`, l10n.t('Subagent {0} completed', event.name)) };
		case 'subagent.failed':
			return { action: action(`subagent:${event.toolCallId}`, l10n.t('Subagent {0} failed — {1}', event.name, safeFailureSummary(event.error))), urgent: true };
		case 'session.idle':
			return { action: action('session', event.aborted ? l10n.t('Task cancelled') : l10n.t('Copilot is idle')), terminal: event.aborted ? 'cancelled' : 'completed' };
		case 'session.usage_info':
			return { usage: l10n.t('Context: {0}% ({1} / {2} tokens)', Math.min(100, Math.round(event.currentTokens / event.tokenLimit * 100)), event.currentTokens, event.tokenLimit) };
		case 'assistant.usage': {
			const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
			return { usage: tokens > 0 ? l10n.t('Latest model call: {0}, {1} tokens', event.model, tokens) : l10n.t('Latest model call: {0}', event.model) };
		}
	}
}

/** Renders one independently valid, bounded Telegram HTML activity card. */
export function renderTelegramActivity(snapshot: TelegramActivitySnapshot): string {
	const latestDetail = [...snapshot.actions].reverse().find(candidate => candidate.detail)?.detail;
	const sections = [
		`<b>${escapeTelegramHtml(l10n.t('Copilot activity'))}</b>`,
		`<b>${escapeTelegramHtml(l10n.t('Workstation'))}:</b> ${boundedEscaped(snapshot.workstation, 256)}`,
		`<b>${escapeTelegramHtml(l10n.t('Authorized workspace'))}:</b> ${boundedEscaped(snapshot.workspace, 256)}`,
		`<b>${escapeTelegramHtml(l10n.t('Session'))}:</b> ${boundedEscaped(snapshot.session, 256)}`,
		snapshot.actions.length > 0
			? `<b>${escapeTelegramHtml(l10n.t('Recent activity'))}</b>\n${snapshot.actions.map(item => `• ${boundedEscaped(item.text, 160)}`).join('\n')}`
			: undefined,
		latestDetail && snapshot.detail !== 'compact'
			? `<b>${escapeTelegramHtml(snapshot.detail === 'debug' ? l10n.t('Diagnostic tool detail') : l10n.t('Current tool detail'))}</b>\n<blockquote expandable>${boundedEscaped(latestDetail, 700)}</blockquote>`
			: undefined,
		snapshot.detail === 'debug' && snapshot.reasoning
			? `<b>${escapeTelegramHtml(l10n.t('Diagnostic exposed reasoning'))}</b>\n<blockquote expandable>${boundedEscaped(snapshot.reasoning, 400)}</blockquote>`
			: undefined,
		snapshot.usage ? `<b>${escapeTelegramHtml(l10n.t('Usage'))}:</b> ${boundedEscaped(snapshot.usage, 200)}` : undefined,
		snapshot.complete ? `<i>${escapeTelegramHtml(l10n.t('Activity complete'))}</i>` : undefined,
	].filter((section): section is string => !!section);
	const result = sections.join('\n\n');
	return result.length <= telegramMaximumMessageLength
		? result
		: `${sections.slice(0, 5).join('\n\n')}\n\n<i>${escapeTelegramHtml(l10n.t('Activity detail truncated'))}</i>`;
}

function action(key: string, text: string, detail?: string): TelegramActivityAction {
	return {
		key,
		text: boundedLine(text, 180),
		detail: detail ? redactTelegramSecrets(detail) : undefined,
	};
}

function runningToolSummary(toolName: string | undefined): string {
	const normalized = toolName?.toLocaleLowerCase() ?? '';
	if (/test|pytest|vitest|jest/.test(normalized)) {
		return l10n.t('Running tests');
	}
	if (/read|view|open/.test(normalized)) {
		return l10n.t('Reading files');
	}
	if (/search|grep|find/.test(normalized)) {
		return l10n.t('Searching workspace');
	}
	if (/edit|write|patch|replace/.test(normalized)) {
		return l10n.t('Updating files');
	}
	if (/diff|change|status/.test(normalized)) {
		return l10n.t('Inspecting changes');
	}
	if (/shell|terminal|command|exec/.test(normalized)) {
		return l10n.t('Running command');
	}
	return l10n.t('Running {0}', humanizeToolName(toolName));
}

function completedToolSummary(toolName: string | undefined): string {
	const normalized = toolName?.toLocaleLowerCase() ?? '';
	if (/test|pytest|vitest|jest/.test(normalized)) {
		return l10n.t('Ran tests — passed');
	}
	if (/read|view|open/.test(normalized)) {
		return l10n.t('Read files — completed');
	}
	if (/search|grep|find/.test(normalized)) {
		return l10n.t('Searched workspace — completed');
	}
	if (/edit|write|patch|replace/.test(normalized)) {
		return l10n.t('Updated files — completed');
	}
	if (/diff|change|status/.test(normalized)) {
		return l10n.t('Inspected changes — completed');
	}
	return l10n.t('{0} — completed', humanizeToolName(toolName));
}

function humanizeToolName(toolName: string | undefined): string {
	if (!toolName) {
		return l10n.t('Tool');
	}
	const value = toolName.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
	return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : l10n.t('Tool');
}

function safeFailureSummary(value: string): string {
	return boundedLine(redactTelegramSecrets(value).replace(/\s+/g, ' ').trim(), 140);
}

function boundedLine(value: string, maximumLength: number): string {
	const line = redactTelegramSecrets(value).replace(/\s+/g, ' ').trim();
	return line.length <= maximumLength ? line : `${line.slice(0, maximumLength - 1)}…`;
}

function boundedEscaped(value: string, maximumEscapedLength: number): string {
	let result = '';
	for (const character of redactTelegramSecrets(value)) {
		const escaped = escapeTelegramHtml(character);
		if (result.length + escaped.length > maximumEscapedLength - 1) {
			return `${result}…`;
		}
		result += escaped;
	}
	return result;
}

export { telegramMaximumMessageLength } from './telegramMarkdown';
