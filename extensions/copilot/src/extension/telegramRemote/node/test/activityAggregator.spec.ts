/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { RemoteAgentEvent } from '../../common/remoteAgentEvent';
import { ActivityAggregator } from '../activityAggregator';

describe('ActivityAggregator', () => {
	it('groups a semantic burst of read and search tools into one round', () => {
		const aggregator = new ActivityAggregator('session-1', 'request-1', () => 1_000);
		const first = aggregator.accept(event('tool.execution_start', { toolCallId: 'read-1', toolName: 'read_file', arguments: { path: 'src/a.ts' } }));
		const second = aggregator.accept(event('tool.execution_complete', { toolCallId: 'read-1', success: true }));
		const third = aggregator.accept(event('tool.execution_start', { toolCallId: 'search-1', toolName: 'grep', arguments: { query: 'RemoteControlRegistry' } }));

		expect(first[0].isNew).toBe(true);
		expect(second[0].round.id).toBe(first[0].round.id);
		expect(third[0].round).toMatchObject({ id: first[0].round.id, type: 'search', status: 'running' });
		expect(third[0].round.details?.map(detail => detail.value)).toEqual(['src/a.ts', 'RemoteControlRegistry']);
	});

	it('uses toolCallId to update one command round from running to completed', () => {
		const aggregator = new ActivityAggregator('session-1', 'request-1');
		const start = aggregator.accept(event('tool.execution_start', {
			toolCallId: 'command-1', toolName: 'bash', arguments: { command: 'npm test', cwd: 'C:\\workspace' },
		}, '1970-01-01T00:00:01.000Z'))[0];
		const complete = aggregator.accept(event('tool.execution_complete', {
			toolCallId: 'command-1', toolName: 'bash', success: true, output: '347 passed',
		}, '1970-01-01T00:00:05.800Z'))[0];

		expect(start.round).toMatchObject({ type: 'command', status: 'running' });
		expect(complete).toMatchObject({ isNew: false, round: { id: start.round.id, type: 'command', status: 'completed' } });
		expect(complete.round.summary).toContain('4.8s');
		expect(complete.round.details?.map(detail => detail.value)).toContain('347 passed');
	});

	it('keeps failed command output in the same failed round', () => {
		const aggregator = new ActivityAggregator('session-1', 'request-1');
		const start = aggregator.accept(event('tool.execution_start', { toolCallId: 'command-1', toolName: 'powershell', arguments: { command: 'npm test' } }))[0];
		const failed = aggregator.accept(event('tool.execution_complete', { toolCallId: 'command-1', success: false, error: '4 tests failed' }))[0];

		expect(failed).toMatchObject({ isNew: false, round: { id: start.round.id, status: 'failed' } });
		expect(failed.round.details?.at(-1)?.value).toBe('4 tests failed');
	});

	it('creates separate SDK-visible reasoning rounds at semantic boundaries', () => {
		const aggregator = new ActivityAggregator('session-1', 'request-1');
		const reasoning = aggregator.accept(event('assistant.reasoning', { reasoningId: 'reason-1', content: 'Need to verify the native request path.' }))[0];
		const edit = aggregator.accept(event('tool.execution_start', { toolCallId: 'edit-1', toolName: 'apply_patch', arguments: { path: 'telegram.ts' } }))[0];

		expect(reasoning.round).toMatchObject({ type: 'reasoning', steerable: true });
		expect(edit.round).toMatchObject({ type: 'edit', steerable: true });
		expect(edit.round.id).not.toBe(reasoning.round.id);
	});
});

function event<K extends RemoteAgentEvent['kind']>(kind: K, data: Omit<Extract<RemoteAgentEvent, { kind: K }>, 'kind' | 'id' | 'timestamp' | 'parentId' | 'source'>, timestamp = '1970-01-01T00:00:01.000Z'): Extract<RemoteAgentEvent, { kind: K }> {
	return { kind, id: `${kind}-${Math.random()}`, timestamp, parentId: null, source: 'live', ...data } as Extract<RemoteAgentEvent, { kind: K }>;
}
