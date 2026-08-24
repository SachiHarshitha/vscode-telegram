/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ActivityRound } from '../../common/activityRound';
import { renderTelegramActivityRound } from '../telegramRichRenderer';

describe('TelegramRichRenderer', () => {
	it('renders one activity round as one InputRichBlockDetails message', () => {
		const message = renderTelegramActivityRound(round({
			type: 'command', summary: 'npm test', status: 'completed',
			details: [{ label: 'Command', value: 'npm test', format: 'code', language: 'shell' }],
		}));

		expect(message.blocks).toHaveLength(1);
		expect(message.blocks?.[0]).toMatchObject({
			type: 'details',
			blocks: expect.arrayContaining([expect.objectContaining({ type: 'pre', text: 'npm test', language: 'shell' })]),
		});
	});

	it('labels reasoning as SDK-visible agent activity and redacts secrets', () => {
		const message = renderTelegramActivityRound(round({
			type: 'reasoning', summary: 'Thinking…', status: 'running',
			details: [{ value: 'authorization=secret-value' }],
		}));
		const serialized = JSON.stringify(message);

		expect(serialized).toContain('🧠');
		expect(serialized).toContain('Thinking…');
		expect(serialized).toContain('authorization=redacted');
		expect(serialized).not.toContain('secret-value');
		expect(serialized).not.toContain('running');
		expect(serialized).not.toContain('Started');
	});

	it('preserves expandable tool details and timing', () => {
		const message = renderTelegramActivityRound(round({
			type: 'search', summary: 'Inspected 2 items', status: 'running',
			details: [{ label: 'Path', value: 'src/a.ts', format: 'code' }],
		}));
		const serialized = JSON.stringify(message);

		expect(message.blocks?.[0]).toMatchObject({ type: 'details' });
		expect(serialized).toContain('running');
		expect(serialized).toContain('Started');
		expect(serialized).toContain('src/a.ts');
	});

	it('keeps raw successful output behind the local detailed disclosure setting', () => {
		const activity = round({
			type: 'command', summary: 'Command completed', status: 'completed',
			details: [
				{ label: 'Command', value: 'npm test', format: 'code' },
				{ label: 'Result', value: 'private stdout', format: 'code', visibility: 'detailed' },
			],
		});

		expect(JSON.stringify(renderTelegramActivityRound(activity, 'compact'))).not.toContain('private stdout');
		expect(JSON.stringify(renderTelegramActivityRound(activity, 'detailed'))).toContain('private stdout');
		expect(JSON.stringify(renderTelegramActivityRound(activity, 'debug'))).toContain('activity=round-1');
	});

	it('redacts credential-shaped JSON and environment variables in detailed output', () => {
		const message = renderTelegramActivityRound(round({
			type: 'command', summary: 'Command failed', status: 'failed',
			details: [{ label: 'Failure', value: '{"GH_TOKEN":"secret-value","DATABASE_PASSWORD":"hunter2"}', format: 'code' }],
		}), 'detailed');
		const serialized = JSON.stringify(message);

		expect(serialized).not.toContain('secret-value');
		expect(serialized).not.toContain('hunter2');
		expect(serialized.match(/redacted/g)).toHaveLength(2);
	});

	it('renders a short lifecycle update without an empty expandable body or timing noise', () => {
		const message = renderTelegramActivityRound(round({
			type: 'progress', summary: 'Prompt accepted', status: 'completed', details: [],
		}));
		const serialized = JSON.stringify(message);

		expect(serialized).toContain('Prompt accepted');
		expect(serialized).not.toContain('details');
		expect(serialized).not.toContain('Duration');
		expect(serialized).not.toContain('This activity');
	});

	it('renders the final assistant answer as sanitized rich HTML instead of literal Markdown', () => {
		const message = renderTelegramActivityRound(round({
			type: 'answer', summary: 'The result', status: 'completed',
			details: [{ value: '**Result**: `c77774e`\n\n- first\n- second' }],
		}));

		expect(message).toMatchObject({ html: expect.stringContaining('<b>Result</b>') });
		expect(message.html).toContain('<code>c77774e</code>');
		expect(message.html).toContain('• first');
		expect(message.html).not.toContain('**Result**');
	});
});

function round(overrides: Partial<ActivityRound>): ActivityRound {
	return {
		id: 'round-1', sessionId: 'session-1', requestId: 'request-1', type: 'progress', summary: 'Working',
		status: 'running', steerable: true, startedAt: 1_000, ...overrides,
	};
}
