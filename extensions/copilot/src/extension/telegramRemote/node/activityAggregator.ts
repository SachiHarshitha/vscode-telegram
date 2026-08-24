/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { ActivityRound, ActivityRoundDetail, ActivityRoundMutation, ActivityRoundStatus, ActivityRoundType } from '../common/activityRound';
import type { RemoteAgentEvent } from '../common/remoteAgentEvent';
import type { IRemotePermissionRequest, IRemoteUserInputRequest } from '../common/remoteControlTypes';

const maximumDetails = 32;
const maximumDetailLength = 4_000;
const maximumSummaryLength = 180;

interface MutableActivityRound {
	id: string;
	sessionId: string;
	requestId?: string;
	toolCallId?: string;
	type: ActivityRoundType;
	summary: string;
	status: ActivityRoundStatus;
	details: ActivityRoundDetail[];
	steerable: boolean;
	startedAt?: number;
	completedAt?: number;
	inspectionCount?: number;
}

/** Groups verified Copilot events into semantic, transport-neutral activity rounds. */
export class ActivityAggregator {
	private readonly rounds = new Map<string, MutableActivityRound>();
	private readonly toolRoundIds = new Map<string, string>();
	private readonly messageRoundIds = new Map<string, string>();
	private readonly inspectionTools = new Set<string>();
	private currentInspectionRoundId: string | undefined;
	private currentReasoningRoundId: string | undefined;
	private readonly currentReasoningSegments = new Map<string, string>();
	private sequence = 0;
	private terminal = false;
	private hasAssistantAnswer = false;

	constructor(
		private readonly sessionId: string,
		private readonly requestId: string | undefined,
		private readonly now: () => number = Date.now,
	) { }

	beginRequest(): ActivityRoundMutation {
		return this.create({
			id: this.id('request'),
			type: 'progress',
			summary: l10n.t('Prompt accepted'),
			status: 'completed',
			steerable: true,
			details: [],
		});
	}

	accept(event: RemoteAgentEvent): readonly ActivityRoundMutation[] {
		if (event.source === 'replay' || this.terminal) {
			return [];
		}
		const timestamp = parseTimestamp(event.timestamp) ?? this.now();
		switch (event.kind) {
			case 'assistant.turn_start':
				return [];
			case 'assistant.intent':
				this.closeInspectionBoundary();
				return [this.upsertReasoning(event.id, event.intent, false, timestamp)];
			case 'assistant.reasoning':
				this.closeInspectionBoundary();
				return [this.upsertReasoning(event.reasoningId, event.content, false, timestamp)];
			case 'assistant.reasoning_delta':
				this.closeInspectionBoundary();
				return [this.upsertReasoning(event.reasoningId, event.delta, true, timestamp)];
			case 'assistant.message':
				this.closeSemanticBoundary();
				return [this.upsertAssistantMessage(event.messageId, event.content, false, timestamp)];
			case 'assistant.message_delta':
				this.closeSemanticBoundary();
				return [this.upsertAssistantMessage(event.messageId, event.delta, true, timestamp)];
			case 'tool.execution_start':
				return [this.startTool(event, timestamp)];
			case 'tool.execution_progress':
				return this.updateTool(event.toolCallId, event.message, undefined, timestamp);
			case 'tool.execution_partial_result':
				return this.updateTool(event.toolCallId, event.output, undefined, timestamp);
			case 'tool.execution_complete':
				return this.completeTool(event.toolCallId, event.success, event.output, event.error, timestamp);
			case 'subagent.started': {
				this.closeSemanticBoundary();
				const mutation = this.create({
					id: this.id(`subagent:${event.toolCallId}`), type: 'subagent', toolCallId: event.toolCallId,
					summary: l10n.t('Subagent {0} started', event.name), status: 'running', steerable: true,
					details: event.description ? [{ label: l10n.t('Task'), value: event.description }] : [], startedAt: timestamp,
				});
				this.toolRoundIds.set(event.toolCallId, mutation.round.id);
				return [mutation];
			}
			case 'subagent.completed':
				return this.completeSubagent(event.toolCallId, l10n.t('Subagent {0} completed', event.name), undefined, timestamp, event.durationMs, event.totalToolCalls);
			case 'subagent.failed':
				return this.completeSubagent(event.toolCallId, l10n.t('Subagent {0} failed', event.name), event.error, timestamp);
			case 'session.error':
				return this.completeTimeline('failed', l10n.t('Copilot session failed'), event.message, timestamp);
			case 'session.shutdown':
				return this.completeTimeline('failed', l10n.t('Copilot session stopped'), event.reason, timestamp);
			case 'abort':
				return this.completeTimeline('failed', l10n.t('Request cancelled'), event.reason, timestamp);
			case 'session.task_complete':
				return this.completeTimeline(event.success === false ? 'failed' : 'completed', event.success === false ? l10n.t('Implementation failed') : l10n.t('Request complete'), event.summary, timestamp);
			case 'session.idle':
				return this.completeTimeline(event.aborted ? 'failed' : 'completed', event.aborted ? l10n.t('Request cancelled') : l10n.t('Request complete'), undefined, timestamp);
			case 'assistant.turn_end':
				this.closeSemanticBoundary();
				return [];
			case 'session.start':
			case 'session.resume':
			case 'session.usage_info':
			case 'assistant.usage':
				return [];
		}
	}

	createPermission(request: IRemotePermissionRequest): ActivityRoundMutation {
		this.closeSemanticBoundary();
		return this.create({
			id: this.id(`permission:${request.requestId}`), type: 'permission', toolCallId: request.permissionRequest.toolCallId,
			summary: permissionSummary(request.permissionRequest.kind), status: 'waiting', steerable: false,
			details: [{ label: l10n.t('Permission'), value: humanize(request.permissionRequest.kind) }],
		});
	}

	createQuestion(request: IRemoteUserInputRequest): ActivityRoundMutation {
		this.closeSemanticBoundary();
		return this.create({
			id: this.id(`question:${request.requestId}`), type: 'question', toolCallId: request.toolCallId,
			summary: boundedLine(request.question), status: 'waiting', steerable: false,
			details: request.choices.length > 0 ? [{ label: l10n.t('Choices'), value: request.choices.join('\n'), format: 'list' }] : [],
		});
	}

	completeInteractive(roundId: string, summary: string, status: 'completed' | 'failed'): ActivityRoundMutation | undefined {
		const round = this.rounds.get(roundId);
		if (!round) {
			return undefined;
		}
		round.summary = boundedLine(summary);
		round.status = status;
		round.completedAt = this.now();
		return { round: snapshot(round), isNew: false };
	}

	completeRequest(status: 'completed' | 'failed' | 'cancelled' | 'superseded'): ActivityRoundMutation | undefined {
		return this.completeTimeline(status === 'completed' ? 'completed' : 'failed',
			status === 'completed' ? l10n.t('Request complete')
				: status === 'failed' ? l10n.t('Implementation failed')
					: status === 'cancelled' ? l10n.t('Request cancelled') : l10n.t('Request superseded'),
			undefined, this.now())[0];
	}

	private startTool(event: Extract<RemoteAgentEvent, { kind: 'tool.execution_start' }>, timestamp: number): ActivityRoundMutation {
		this.closeReasoningBoundary();
		const type = classifyTool(event.toolName);
		const details = describeTool(event.toolName, event.arguments, event.mcpServerName, event.mcpToolName);
		if (type === 'read' || type === 'search') {
			let round = this.currentInspectionRoundId ? this.rounds.get(this.currentInspectionRoundId) : undefined;
			let isNew = false;
			if (!round) {
				isNew = true;
				round = this.mutable({
					id: this.id(`inspection:${++this.sequence}`), type, summary: l10n.t('Inspecting workspace'), status: 'running',
					steerable: true, details: [], startedAt: timestamp,
				});
				this.rounds.set(round.id, round);
				this.currentInspectionRoundId = round.id;
			}
			round.type = round.type === type ? type : 'search';
			round.status = 'running';
			round.completedAt = undefined;
			appendDetails(round, details.length > 0 ? details : [{ value: humanize(event.toolName) }]);
			round.inspectionCount = (round.inspectionCount ?? 0) + 1;
			this.inspectionTools.add(event.toolCallId);
			this.toolRoundIds.set(event.toolCallId, round.id);
			updateInspectionSummary(round);
			return { round: snapshot(round), isNew };
		}

		this.closeInspectionBoundary();
		const mutation = this.create({
			id: this.id(`tool:${event.toolCallId}`), type, toolCallId: event.toolCallId,
			summary: runningToolSummary(type, event.toolName, details), status: 'running', steerable: true,
			details, startedAt: timestamp,
		});
		this.toolRoundIds.set(event.toolCallId, mutation.round.id);
		return mutation;
	}

	private updateTool(toolCallId: string, detail: string, status: ActivityRoundStatus | undefined, timestamp: number): readonly ActivityRoundMutation[] {
		const round = this.rounds.get(this.toolRoundIds.get(toolCallId) ?? '');
		if (!round) {
			return [];
		}
		if (detail) {
			appendDetails(round, [{ label: l10n.t('Progress'), value: detail, format: round.type === 'command' ? 'code' : 'text', visibility: 'detailed' }]);
		}
		round.status = status ?? 'running';
		round.startedAt ??= timestamp;
		return [{ round: snapshot(round), isNew: false }];
	}

	private completeTool(toolCallId: string, success: boolean, output: string | undefined, error: string | undefined, timestamp: number): readonly ActivityRoundMutation[] {
		const round = this.rounds.get(this.toolRoundIds.get(toolCallId) ?? '');
		if (!round) {
			return [];
		}
		this.toolRoundIds.delete(toolCallId);
		if (this.inspectionTools.delete(toolCallId)) {
			round.status = [...this.inspectionTools].some(id => this.toolRoundIds.get(id) === round.id) ? 'running' : success ? 'completed' : 'failed';
			round.completedAt = round.status === 'running' ? undefined : timestamp;
			if (success && output) {
				appendDetails(round, [{ label: l10n.t('Result'), value: output, visibility: 'detailed' }]);
			} else if (!success && error) {
				appendDetails(round, [{ label: l10n.t('Failure'), value: error }]);
			}
			updateInspectionSummary(round);
			return [{ round: snapshot(round), isNew: false }];
		}
		round.status = success ? 'completed' : 'failed';
		round.completedAt = timestamp;
		round.summary = completedToolSummary(round, success);
		const result = success ? output : error ?? output;
		if (result) {
			appendDetails(round, [{ label: success ? l10n.t('Result') : l10n.t('Failure'), value: result, format: round.type === 'command' ? 'code' : 'text', visibility: success ? 'detailed' : 'summary' }]);
		}
		return [{ round: snapshot(round), isNew: false }];
	}

	private completeSubagent(toolCallId: string, summary: string, error: string | undefined, timestamp: number, durationMs?: number, totalToolCalls?: number): readonly ActivityRoundMutation[] {
		const round = this.rounds.get(this.toolRoundIds.get(toolCallId) ?? '');
		if (!round) {
			return [];
		}
		this.toolRoundIds.delete(toolCallId);
		round.summary = summary;
		round.status = error ? 'failed' : 'completed';
		round.completedAt = timestamp;
		if (durationMs !== undefined) {
			appendDetails(round, [{ label: l10n.t('Duration'), value: formatDuration(durationMs) }]);
		}
		if (totalToolCalls !== undefined) {
			appendDetails(round, [{ label: l10n.t('Tool calls'), value: String(totalToolCalls) }]);
		}
		if (error) {
			appendDetails(round, [{ label: l10n.t('Failure'), value: error }]);
		}
		return [{ round: snapshot(round), isNew: false }];
	}

	private upsertReasoning(sourceId: string, value: string, append: boolean, timestamp: number): ActivityRoundMutation {
		let round = this.currentReasoningRoundId ? this.rounds.get(this.currentReasoningRoundId) : undefined;
		let isNew = false;
		if (!round) {
			isNew = true;
			round = this.mutable({
				id: this.id(`reasoning:${++this.sequence}`), type: 'reasoning', summary: l10n.t('Thinking…'),
				status: 'running', steerable: true, details: [], startedAt: timestamp,
			});
			this.rounds.set(round.id, round);
			this.currentReasoningRoundId = round.id;
		}
		const current = this.currentReasoningSegments.get(sourceId) ?? '';
		this.currentReasoningSegments.set(sourceId, appendBounded(append ? `${current}${value}` : value));
		round.details = [{ value: appendBounded([...this.currentReasoningSegments.values()].filter(Boolean).join('\n\n')) }];
		round.status = 'running';
		return { round: snapshot(round), isNew };
	}

	private upsertAssistantMessage(messageId: string, value: string, append: boolean, timestamp: number): ActivityRoundMutation {
		if (value) {
			this.hasAssistantAnswer = true;
		}
		const existingId = this.messageRoundIds.get(messageId);
		const existing = existingId ? this.rounds.get(existingId) : undefined;
		if (existing) {
			const current = existing.details[0]?.value ?? '';
			existing.details = [{ value: appendBounded(append ? `${current}${value}` : value) }];
			existing.summary = summaryFromText(existing.details[0].value, l10n.t('Agent progress'));
			existing.status = append ? 'running' : 'completed';
			existing.completedAt = append ? undefined : timestamp;
			return { round: snapshot(existing), isNew: false };
		}
		const mutation = this.create({
			id: this.id(`message:${messageId}`), type: 'answer', summary: summaryFromText(value, l10n.t('Agent response')),
			status: append ? 'running' : 'completed', steerable: true, details: value ? [{ value }] : [], startedAt: timestamp,
			completedAt: append ? undefined : timestamp,
		});
		this.messageRoundIds.set(messageId, mutation.round.id);
		return mutation;
	}

	private completeTimeline(status: 'completed' | 'failed', summary: string, detail: string | undefined, timestamp: number): readonly ActivityRoundMutation[] {
		this.closeSemanticBoundary();
		this.terminal = true;
		if (status === 'completed' && this.hasAssistantAnswer && !detail) {
			return [];
		}
		return [this.create({
			id: this.id(`terminal:${++this.sequence}`), type: 'other', summary, status, steerable: false,
			details: detail ? [{ value: detail }] : [], startedAt: timestamp, completedAt: timestamp,
		})];
	}

	private create(input: Omit<MutableActivityRound, 'sessionId' | 'requestId'>): ActivityRoundMutation {
		const round = this.mutable(input);
		this.rounds.set(round.id, round);
		return { round: snapshot(round), isNew: true };
	}

	private mutable(input: Omit<MutableActivityRound, 'sessionId' | 'requestId'>): MutableActivityRound {
		return { ...input, sessionId: this.sessionId, requestId: this.requestId, summary: boundedLine(input.summary), details: input.details.slice(0, maximumDetails) };
	}

	private id(suffix: string): string {
		return `${this.requestId ?? 'live'}:${suffix}`;
	}

	private closeInspectionBoundary(): void {
		this.currentInspectionRoundId = undefined;
	}

	private closeReasoningBoundary(): void {
		this.currentReasoningRoundId = undefined;
		this.currentReasoningSegments.clear();
	}

	private closeSemanticBoundary(): void {
		this.closeInspectionBoundary();
		this.closeReasoningBoundary();
	}
}

function classifyTool(toolName: string): ActivityRoundType {
	const name = toolName.toLocaleLowerCase();
	if (/apply_patch|str_replace|edit|write|replace|create_file|delete_file/.test(name)) {
		return 'edit';
	}
	if (/grep|search|find|glob|list_dir|semantic_search/.test(name)) {
		return 'search';
	}
	if (/read|view|open_file|cat/.test(name)) {
		return 'read';
	}
	if (/bash|powershell|shell|terminal|command|exec|run_|task/.test(name)) {
		return 'command';
	}
	return 'other';
}

function describeTool(toolName: string, args: unknown, mcpServerName?: string, mcpToolName?: string): ActivityRoundDetail[] {
	const record = asRecord(args);
	const details: ActivityRoundDetail[] = [];
	const description = readString(record, ['description', 'summary', 'intent']);
	const command = readString(record, ['command', 'cmd', 'script']);
	const path = readString(record, ['path', 'file', 'filePath', 'file_path', 'uri']);
	const query = readString(record, ['query', 'pattern', 'search', 'regex']);
	const workingDirectory = readString(record, ['cwd', 'workingDirectory', 'working_directory']);
	if (description) {
		details.push({ label: l10n.t('Purpose'), value: description });
	}
	if (path) {
		details.push({ label: l10n.t('Path'), value: path, format: 'code' });
	}
	if (query) {
		details.push({ label: l10n.t('Query'), value: query, format: 'code' });
	}
	if (workingDirectory) {
		details.push({ label: l10n.t('Working directory'), value: workingDirectory, format: 'code' });
	}
	if (command) {
		details.push({ label: l10n.t('Command'), value: command, format: 'code', language: shellLanguage(toolName) });
	}
	if (mcpServerName || mcpToolName) {
		details.push({ label: l10n.t('MCP tool'), value: [mcpServerName, mcpToolName].filter(Boolean).join(' / ') });
	}
	if (details.length === 0 && args !== undefined) {
		const serialized = safeStringify(args);
		if (serialized && serialized !== '{}') {
			details.push({ label: l10n.t('Arguments'), value: serialized, format: 'code', language: 'json', visibility: 'detailed' });
		}
	}
	return details;
}

function runningToolSummary(type: ActivityRoundType, toolName: string, details: readonly ActivityRoundDetail[]): string {
	const primary = details.find(detail => detail.label === l10n.t('Command') || detail.label === l10n.t('Path') || detail.label === l10n.t('Query'))?.value;
	if (type === 'command') {
		return primary ? l10n.t('Running {0}', boundedLine(primary)) : l10n.t('Running {0}', humanize(toolName));
	}
	if (type === 'edit') {
		return primary ? l10n.t('Modifying {0}', boundedLine(primary)) : l10n.t('Modifying files');
	}
	return l10n.t('Running {0}', humanize(toolName));
}

function completedToolSummary(round: MutableActivityRound, success: boolean): string {
	const duration = round.startedAt !== undefined && round.completedAt !== undefined ? formatDuration(Math.max(0, round.completedAt - round.startedAt)) : undefined;
	const command = round.details.find(detail => detail.label === l10n.t('Command'))?.value;
	const path = round.details.find(detail => detail.label === l10n.t('Path'))?.value;
	const base = round.type === 'command' ? (command
		? success ? boundedLine(command) : l10n.t('{0} failed', boundedLine(command))
		: success ? l10n.t('Command completed') : l10n.t('Command failed'))
		: round.type === 'edit' ? (path
			? success ? l10n.t('Modified {0}', boundedLine(path)) : l10n.t('Failed to modify {0}', boundedLine(path))
			: success ? l10n.t('Files modified') : l10n.t('File modification failed'))
			: success ? l10n.t('Tool completed') : l10n.t('Tool failed');
	return duration ? `${base} · ${duration}` : base;
}

function updateInspectionSummary(round: MutableActivityRound): void {
	const count = round.inspectionCount ?? 0;
	round.summary = count === 1 ? l10n.t('Inspected 1 item') : l10n.t('Inspected {0} items', count);
}

function permissionSummary(kind: string): string {
	return kind === 'shell' ? l10n.t('Shell permission required')
		: kind === 'write' ? l10n.t('File write permission required')
			: kind === 'read' ? l10n.t('File read permission required')
				: kind === 'mcp' ? l10n.t('Tool permission required') : l10n.t('{0} permission required', humanize(kind));
}

function appendDetails(round: MutableActivityRound, details: readonly ActivityRoundDetail[]): void {
	for (const detail of details) {
		const value = truncate(detail.value, maximumDetailLength);
		const existing = round.details.findIndex(candidate => candidate.label === detail.label && candidate.format === detail.format);
		if (existing >= 0 && detail.label === l10n.t('Progress')) {
			round.details[existing] = { ...detail, value };
		} else {
			round.details.push({ ...detail, value });
		}
	}
	while (round.details.length > maximumDetails) {
		round.details.shift();
	}
}

function snapshot(round: MutableActivityRound): ActivityRound {
	return {
		id: round.id,
		sessionId: round.sessionId,
		requestId: round.requestId,
		toolCallId: round.toolCallId,
		type: round.type,
		summary: round.summary,
		status: round.status,
		details: round.details.map(detail => ({ ...detail })),
		steerable: round.steerable,
		startedAt: round.startedAt,
		completedAt: round.completedAt,
	};
}

function summaryFromText(value: string, fallback: string): string {
	const line = value.replace(/^[#>*\-\s]+/, '').split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim();
	return boundedLine(line || fallback);
}

function boundedLine(value: string): string {
	const line = value.replace(/\s+/g, ' ').trim();
	return truncate(line, maximumSummaryLength);
}

function appendBounded(value: string): string {
	return truncate(value, maximumDetailLength);
}

function truncate(value: string, length: number): string {
	return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}

function humanize(value: string): string {
	const text = value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
	return text ? `${text[0].toLocaleUpperCase()}${text.slice(1)}` : l10n.t('Tool');
}

function parseTimestamp(value: string): number | undefined {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatDuration(durationMs: number): string {
	return durationMs < 1_000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function readString(record: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		if (typeof record?.[key] === 'string' && record[key]) {
			return record[key] as string;
		}
	}
	return undefined;
}

function safeStringify(value: unknown): string | undefined {
	try {
		return truncate(JSON.stringify(value, undefined, 2), maximumDetailLength);
	} catch {
		return undefined;
	}
}

function shellLanguage(toolName: string): string | undefined {
	const name = toolName.toLocaleLowerCase();
	return name.includes('powershell') ? 'powershell' : name.includes('bash') || name.includes('shell') ? 'shell' : undefined;
}
