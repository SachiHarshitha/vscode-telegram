/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { RemoteAgentEvent } from '../../common/remoteAgentEvent';
import { escapeTelegramMarkdownV2, renderTelegramActivity, renderTelegramEvent, telegramMaximumMessageLength } from '../telegramEventRenderer';

const base = { id: 'event-1', timestamp: '2026-08-23T12:00:00.000Z', parentId: null, source: 'live' as const };

describe('TelegramEventRenderer', () => {
	it('renders every supported projected event variant without relying on missing fields', () => {
		const events: RemoteAgentEvent[] = [
			{ ...base, kind: 'session.start', model: 'gpt-5' },
			{ ...base, kind: 'session.resume' },
			{ ...base, kind: 'session.error', message: 'offline' },
			{ ...base, kind: 'session.task_complete', success: true, summary: 'done' },
			{ ...base, kind: 'session.shutdown', shutdownType: 'routine' },
			{ ...base, kind: 'abort' },
			{ ...base, kind: 'assistant.turn_start', turnId: '1', model: 'gpt-5' },
			{ ...base, kind: 'assistant.turn_end', turnId: '1' },
			{ ...base, kind: 'assistant.intent', intent: 'checking' },
			{ ...base, kind: 'assistant.message', messageId: 'm1', content: 'answer' },
			{ ...base, kind: 'assistant.message_delta', messageId: 'm1', delta: 'ans' },
			{ ...base, kind: 'assistant.reasoning', reasoningId: 'r1', content: 'note' },
			{ ...base, kind: 'assistant.reasoning_delta', reasoningId: 'r1', delta: 'no' },
			{ ...base, kind: 'tool.execution_start', toolCallId: 't1', toolName: 'shell' },
			{ ...base, kind: 'tool.execution_progress', toolCallId: 't1', message: 'running' },
			{ ...base, kind: 'tool.execution_partial_result', toolCallId: 't1', output: 'line' },
			{ ...base, kind: 'tool.execution_complete', toolCallId: 't1', success: true },
			{ ...base, kind: 'subagent.started', toolCallId: 't2', name: 'Reviewer' },
			{ ...base, kind: 'subagent.completed', toolCallId: 't2', name: 'Reviewer' },
			{ ...base, kind: 'subagent.failed', toolCallId: 't3', name: 'Tester', error: 'failed' },
			{ ...base, kind: 'session.idle', aborted: false },
			{ ...base, kind: 'session.usage_info', currentTokens: 50, tokenLimit: 100 },
			{ ...base, kind: 'assistant.usage', model: 'gpt-5' },
		];

		expect(events.map(event => renderTelegramEvent(event))).toMatchInlineSnapshot(`
			[
			  {
			    "action": {
			      "key": "session",
			      "text": "Session started with gpt-5.",
			    },
			  },
			  {
			    "action": {
			      "key": "session",
			      "text": "Session resumed.",
			    },
			  },
			  {
			    "action": {
			      "key": "session-error",
			      "text": "Session error: offline",
			    },
			    "urgent": true,
			  },
			  {
			    "action": {
			      "key": "task-complete",
			      "text": "Task completed: done",
			    },
			    "terminal": true,
			  },
			  {
			    "action": {
			      "key": "session",
			      "text": "Session stopped.",
			    },
			    "terminal": true,
			  },
			  {
			    "action": {
			      "key": "abort",
			      "text": "Task aborted.",
			    },
			    "terminal": true,
			  },
			  {
			    "action": {
			      "key": "turn",
			      "text": "Agent turn started with gpt-5.",
			    },
			  },
			  {
			    "action": {
			      "key": "turn",
			      "text": "Agent turn completed.",
			    },
			  },
			  {
			    "action": {
			      "key": "intent",
			      "text": "Agent: checking",
			    },
			  },
			  {
			    "reasoning": undefined,
			    "response": {
			      "append": false,
			      "messageId": "m1",
			      "text": "answer",
			    },
			    "urgent": true,
			  },
			  {
			    "response": {
			      "append": true,
			      "messageId": "m1",
			      "text": "ans",
			    },
			  },
			  {
			    "reasoning": {
			      "append": false,
			      "reasoningId": "r1",
			      "text": "note",
			    },
			  },
			  {
			    "reasoning": {
			      "append": true,
			      "reasoningId": "r1",
			      "text": "no",
			    },
			  },
			  {
			    "action": {
			      "key": "tool:t1",
			      "text": "Running tool: shell",
			    },
			  },
			  {
			    "action": {
			      "key": "tool:t1",
			      "text": "Tool progress: running",
			    },
			  },
			  {
			    "action": {
			      "key": "tool:t1",
			      "text": "Tool output: line",
			    },
			  },
			  {
			    "action": {
			      "key": "tool:t1",
			      "text": "Tool completed.",
			    },
			  },
			  {
			    "action": {
			      "key": "subagent:t2",
			      "text": "Subagent Reviewer started.",
			    },
			  },
			  {
			    "action": {
			      "key": "subagent:t2",
			      "text": "Subagent Reviewer completed.",
			    },
			  },
			  {
			    "action": {
			      "key": "subagent:t3",
			      "text": "Subagent Tester failed: failed",
			    },
			    "urgent": true,
			  },
			  {
			    "action": {
			      "key": "session",
			      "text": "Session is idle.",
			    },
			    "terminal": true,
			  },
			  {
			    "usage": "Context: 50% (50 / 100 tokens)",
			  },
			  {
			    "usage": "Latest model call: gpt-5",
			  },
			]
		`);
	});

	it('escapes MarkdownV2 and splits bounded activity output', () => {
		expect(escapeTelegramMarkdownV2('_*[]()~`>#+-=|{}.!\\')).toMatchInlineSnapshot(`"\\_\\*\\[\\]\\(\\)\\~\\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\"`);
		const chunks = renderTelegramActivity({
			workstation: 'host_[1]',
			workspace: 'C:\\work (main)',
			session: 'Fix *all* things!',
			actions: ['Ran `npm test`.', 'Result: [ok](url)'],
			reasoning: 'Readable _summary_',
			response: `token=super-secret-value ${'#'.repeat(20_000)}`,
			usage: 'Context: 50%',
			complete: true,
		});

		expect(chunks).toHaveLength(4);
		expect(chunks.every(chunk => chunk.length <= telegramMaximumMessageLength)).toBe(true);
		expect(chunks[0]).toContain('*Workstation:* host\\_\\[1\\]');
		expect(chunks[0]).toContain('*Workspace:* C:\\\\work \\(main\\)');
		expect(chunks[0]).toContain('• Result: \\[ok\\]\\(url\\)');
		expect(chunks.join('')).toContain('token\\=\\[redacted\\]');
		expect(chunks.join('')).not.toContain('super-secret-value');
		expect(chunks.at(-1)?.endsWith('_Output truncated_')).toBe(true);
	});
});
