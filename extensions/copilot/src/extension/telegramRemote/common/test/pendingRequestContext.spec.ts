/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearPendingCopilotCLIRequestContext,
	createPendingCopilotCLIRequestCorrelationId,
	createPendingCopilotCLIRequestMarker,
	getPendingCopilotCLIRequestCorrelationId,
	setPendingCopilotCLIRequestContext,
	takePendingCopilotCLIRequestContext,
} from '../../../chatSessions/copilotcli/common/pendingRequestContext';

describe('pendingRequestContext', () => {
	afterEach(() => vi.useRealTimers());
	it('keeps rapid requests isolated by correlation and session', () => {
		const firstId = createPendingCopilotCLIRequestCorrelationId();
		const secondId = createPendingCopilotCLIRequestCorrelationId();
		setPendingCopilotCLIRequestContext('session-a', firstId, { prompt: 'first', attachments: [] });
		setPendingCopilotCLIRequestContext('session-a', secondId, { prompt: 'second', attachments: [] });

		expect(takePendingCopilotCLIRequestContext('session-b', firstId)).toBeUndefined();
		expect(takePendingCopilotCLIRequestContext('session-a', secondId)?.prompt).toBe('second');
		expect(takePendingCopilotCLIRequestContext('session-a', firstId)?.prompt).toBe('first');
		expect(takePendingCopilotCLIRequestContext('session-a', firstId)).toBeUndefined();
	});

	it('requires exactly one correlation marker so local requests cannot consume staged context', () => {
		const correlationId = createPendingCopilotCLIRequestCorrelationId();
		const marker = createPendingCopilotCLIRequestMarker(correlationId);
		setPendingCopilotCLIRequestContext('session-a', correlationId, { prompt: 'remote', attachments: [] });

		expect(getPendingCopilotCLIRequestCorrelationId([])).toBeUndefined();
		expect(getPendingCopilotCLIRequestCorrelationId([marker, marker])).toBeUndefined();
		expect(takePendingCopilotCLIRequestContext('session-a', correlationId)?.prompt).toBe('remote');
	});

	it('makes set and clear idempotent without allowing payload replacement', () => {
		const correlationId = createPendingCopilotCLIRequestCorrelationId();
		setPendingCopilotCLIRequestContext('session-a', correlationId, { prompt: 'original', attachments: [] });
		setPendingCopilotCLIRequestContext('session-a', correlationId, { prompt: 'replacement', attachments: [] });

		expect(takePendingCopilotCLIRequestContext('session-a', correlationId)?.prompt).toBe('original');
		clearPendingCopilotCLIRequestContext('session-a', correlationId);
		clearPendingCopilotCLIRequestContext('session-a', correlationId);
		expect(takePendingCopilotCLIRequestContext('session-a', correlationId)).toBeUndefined();
	});

	it('expires stale entries and bounds retained correlations', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const expiredId = createPendingCopilotCLIRequestCorrelationId();
		setPendingCopilotCLIRequestContext('session-a', expiredId, { prompt: 'expired', attachments: [] });
		vi.setSystemTime(new Date('2026-01-01T00:02:01.000Z'));
		expect(takePendingCopilotCLIRequestContext('session-a', expiredId)).toBeUndefined();

		const ids: string[] = [];
		for (let index = 0; index < 257; index++) {
			const correlationId = createPendingCopilotCLIRequestCorrelationId();
			ids.push(correlationId);
			setPendingCopilotCLIRequestContext('session-a', correlationId, { prompt: String(index), attachments: [] });
		}
		expect(takePendingCopilotCLIRequestContext('session-a', ids[0])).toBeUndefined();
		for (const correlationId of ids.slice(1)) {
			clearPendingCopilotCLIRequestContext('session-a', correlationId);
		}
	});
});
