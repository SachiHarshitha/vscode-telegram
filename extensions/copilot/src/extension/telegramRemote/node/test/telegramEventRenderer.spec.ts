/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { RemoteAgentEvent } from '../../common/remoteAgentEvent';
import { renderTelegramActivity, renderTelegramEvent, telegramMaximumMessageLength } from '../telegramEventRenderer';

const base = { id: 'event-1', timestamp: '2026-08-23T12:00:00.000Z', parentId: null, source: 'live' as const };

describe('TelegramEventRenderer', () => {
	it('renders every projected variant without exposing compact raw tool output', () => {
		const events: RemoteAgentEvent[] = [
			{ ...base, kind: 'session.start', model: 'gpt-5' },
			{ ...base, kind: 'session.resume' },
			{ ...base, kind: 'session.error', message: 'offline' },
			{ ...base, kind: 'session.task_complete', success: true, summary: 'private summary' },
			{ ...base, kind: 'session.shutdown', shutdownType: 'routine', reason: 'private reason' },
			{ ...base, kind: 'abort', reason: 'private reason' },
			{ ...base, kind: 'assistant.turn_start', turnId: '1', model: 'gpt-5' },
			{ ...base, kind: 'assistant.turn_end', turnId: '1' },
			{ ...base, kind: 'assistant.intent', intent: 'private intent' },
			{ ...base, kind: 'assistant.message', messageId: 'm1', content: 'answer' },
			{ ...base, kind: 'assistant.message_delta', messageId: 'm1', delta: 'ans' },
			{ ...base, kind: 'assistant.reasoning', reasoningId: 'r1', content: 'private reasoning' },
			{ ...base, kind: 'assistant.reasoning_delta', reasoningId: 'r1', delta: 'private delta' },
			{ ...base, kind: 'tool.execution_start', toolCallId: 't1', toolName: 'run_tests' },
			{ ...base, kind: 'tool.execution_progress', toolCallId: 't1', message: 'raw progress' },
			{ ...base, kind: 'tool.execution_partial_result', toolCallId: 't1', output: 'raw diff' },
			{ ...base, kind: 'tool.execution_complete', toolCallId: 't1', success: true, output: 'raw stdout' },
			{ ...base, kind: 'subagent.started', toolCallId: 't2', name: 'Reviewer', description: 'private description' },
			{ ...base, kind: 'subagent.completed', toolCallId: 't2', name: 'Reviewer' },
			{ ...base, kind: 'subagent.failed', toolCallId: 't3', name: 'Tester', error: 'permission denied' },
			{ ...base, kind: 'session.idle', aborted: false },
			{ ...base, kind: 'session.usage_info', currentTokens: 50, tokenLimit: 100 },
			{ ...base, kind: 'assistant.usage', model: 'gpt-5' },
		];

		const mutations = events.map(event => renderTelegramEvent(event, { detail: 'compact', correlatedToolName: 'run_tests' }));
		const serialized = JSON.stringify(mutations);
		expect({
			count: mutations.length,
			testSummary: serialized.includes('Ran tests — passed'),
			rawProgress: serialized.includes('raw progress'),
			rawDiff: serialized.includes('raw diff'),
			rawStdout: serialized.includes('raw stdout'),
		}).toEqual({ count: events.length, testSummary: true, rawProgress: false, rawDiff: false, rawStdout: false });
	});

	it('renders a bounded HTML activity card with collapsed detailed content', () => {
		const card = renderTelegramActivity({
			workstation: 'host<&>',
			workspace: 'C:\\authorized workspace',
			session: 'Fix <all> things',
			actions: [
				{ key: 'read', text: 'Reading files' },
				{ key: 'tool', text: 'Ran tests — passed', detail: `token=super-secret-value ${'x'.repeat(2_000)}` },
			],
			detail: 'detailed',
			complete: true,
		});

		expect(card).toContain('<b>Authorized workspace:</b> C:\\authorized workspace');
		expect(card).toContain('<blockquote expandable>token=redacted');
		expect(card).not.toContain('super-secret-value');
		expect(card).toContain('host&lt;&amp;&gt;');
		expect(card.length).toBeLessThanOrEqual(telegramMaximumMessageLength);
	});

	it('labels model usage as input, output, and total tokens', () => {
		const rendered = renderTelegramEvent({
			...base,
			kind: 'assistant.usage',
			model: 'claude-haiku-4.5',
			inputTokens: 86_435,
			outputTokens: 197,
		}, { detail: 'compact' });

		expect(rendered.usage).toBe('Latest model call: claude-haiku-4.5 — 86435 input, 197 output (86632 total)');
	});
});
