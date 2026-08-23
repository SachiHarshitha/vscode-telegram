/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { projectRemoteAgentEvent } from '../remoteAgentEvent';
import type { IRemoteControlSessionEvent } from '../remoteControlTypes';

describe('RemoteAgentEvent', () => {
	it('projects the verified persisted and ephemeral runtime variants', () => {
		const events = [
			event('session.start', { selectedModel: 'gpt-5' }, true),
			event('session.resume', { selectedModel: 'gpt-5' }),
			event('session.error', { message: 'Unavailable', errorType: 'network' }),
			event('session.task_complete', { success: true, summary: 'Done' }),
			event('session.shutdown', { shutdownType: 'error', errorReason: 'Crashed' }),
			event('abort', { reason: 'user' }),
			event('assistant.turn_start', { turnId: 'turn-1', model: 'gpt-5' }),
			event('assistant.turn_end', { turnId: 'turn-1' }),
			event('assistant.intent', { intent: 'Inspecting files' }),
			event('assistant.message', { messageId: 'message-1', content: 'Answer', reasoningText: 'Readable note' }),
			event('assistant.message_delta', { messageId: 'message-1', deltaContent: 'An' }),
			event('assistant.reasoning', { reasoningId: 'reason-1', content: 'Readable note' }),
			event('assistant.reasoning_delta', { reasoningId: 'reason-1', deltaContent: 'Read' }),
			event('tool.execution_start', { toolCallId: 'tool-1', toolName: 'shell' }),
			event('tool.execution_progress', { toolCallId: 'tool-1', progressMessage: 'Running' }),
			event('tool.execution_partial_result', { toolCallId: 'tool-1', partialOutput: 'line 1' }),
			event('tool.execution_complete', { toolCallId: 'tool-1', success: false, toolDescription: { name: 'shell' }, error: { message: 'Failed' }, result: { content: 'output' } }),
			event('subagent.started', { toolCallId: 'tool-2', agentDisplayName: 'Reviewer', agentName: 'reviewer', agentDescription: 'Reviews code' }),
			event('subagent.completed', { toolCallId: 'tool-2', agentDisplayName: 'Reviewer', agentName: 'reviewer', durationMs: 1200, totalToolCalls: 3 }),
			event('subagent.failed', { toolCallId: 'tool-3', agentDisplayName: 'Tester', agentName: 'tester', error: 'Tests failed' }),
			event('session.idle', { aborted: false }),
			event('session.usage_info', { currentTokens: 100, tokenLimit: 1000 }),
			event('assistant.usage', { model: 'gpt-5', inputTokens: 10, outputTokens: 20 }),
		].map(projectRemoteAgentEvent);

		expect(events.map(projected => projected && { kind: projected.kind, source: projected.source })).toEqual([
			{ kind: 'session.start', source: 'replay' },
			{ kind: 'session.resume', source: 'live' },
			{ kind: 'session.error', source: 'live' },
			{ kind: 'session.task_complete', source: 'live' },
			{ kind: 'session.shutdown', source: 'live' },
			{ kind: 'abort', source: 'live' },
			{ kind: 'assistant.turn_start', source: 'live' },
			{ kind: 'assistant.turn_end', source: 'live' },
			{ kind: 'assistant.intent', source: 'live' },
			{ kind: 'assistant.message', source: 'live' },
			{ kind: 'assistant.message_delta', source: 'live' },
			{ kind: 'assistant.reasoning', source: 'live' },
			{ kind: 'assistant.reasoning_delta', source: 'live' },
			{ kind: 'tool.execution_start', source: 'live' },
			{ kind: 'tool.execution_progress', source: 'live' },
			{ kind: 'tool.execution_partial_result', source: 'live' },
			{ kind: 'tool.execution_complete', source: 'live' },
			{ kind: 'subagent.started', source: 'live' },
			{ kind: 'subagent.completed', source: 'live' },
			{ kind: 'subagent.failed', source: 'live' },
			{ kind: 'session.idle', source: 'live' },
			{ kind: 'session.usage_info', source: 'live' },
			{ kind: 'assistant.usage', source: 'live' },
		]);
		expect(events[0]).toMatchObject({ id: 'event-session.start', timestamp: '2026-08-23T12:00:00.000Z', parentId: 'parent-1', agentId: 'agent-1' });
	});

	it('drops malformed, unknown, and interactive workflow events', () => {
		expect([
			projectRemoteAgentEvent(event('assistant.message_delta', { messageId: 'message-1' })),
			projectRemoteAgentEvent(event('tool.execution_start', { toolCallId: 'tool-1' })),
			projectRemoteAgentEvent(event('session.usage_info', { currentTokens: 10, tokenLimit: 0 })),
			projectRemoteAgentEvent(event('permission.requested', { requestId: 'permission-1' })),
			projectRemoteAgentEvent(event('user_input.requested', { requestId: 'input-1' })),
			projectRemoteAgentEvent(event('future.event', {})),
		]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});

function event(type: string, data: unknown, replay = false): IRemoteControlSessionEvent {
	return {
		id: `event-${type}`,
		timestamp: '2026-08-23T12:00:00.000Z',
		parentId: 'parent-1',
		agentId: 'agent-1',
		replay: replay ? true : undefined,
		type,
		data,
	};
}
