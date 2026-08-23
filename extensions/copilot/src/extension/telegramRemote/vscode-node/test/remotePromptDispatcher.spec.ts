/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { getPendingCopilotCLIRequestCorrelationId, takePendingCopilotCLIRequestContext } from '../../../chatSessions/copilotcli/common/pendingRequestContext';
import type { RemoteRequestOrigin } from '../../common/remoteControlTypes';
import { RemotePromptDispatcher } from '../remotePromptDispatcher';

const vscodeMocks = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock('vscode', () => ({
	commands: { executeCommand: vscodeMocks.executeCommand },
}));

describe('RemotePromptDispatcher', () => {
	beforeEach(() => {
		vscodeMocks.executeCommand.mockReset();
	});

	it('returns accepted immediately and dispatches a correlated steering request', () => {
		vscodeMocks.executeCommand.mockReturnValue(new Promise<void>(() => { }));
		const dispatcher = new RemotePromptDispatcher(new class extends mock<ILogService>() { });
		const origin: RemoteRequestOrigin = { kind: 'telegram', transportId: 'telegram', updateId: '42' };

		const result = dispatcher.dispatch('session-1', 'steer this', origin);

		expect(result.accepted).toBe(true);
		expect(vscodeMocks.executeCommand).toHaveBeenCalledTimes(1);
		const [, options] = vscodeMocks.executeCommand.mock.calls[0] as [string, { queue: string; attachedContext: Array<{ id: string; value: unknown }> }];
		expect(options.queue).toBe('steering');
		const correlationId = getPendingCopilotCLIRequestCorrelationId(options.attachedContext);
		expect(correlationId).toBe(result.correlationId);
		expect(takePendingCopilotCLIRequestContext('session-1', correlationId!)?.origin).toBe(origin);
	});

	it('clears only its correlation when the native command rejects', async () => {
		vscodeMocks.executeCommand.mockRejectedValue(new Error('rejected'));
		const logService = new class extends mock<ILogService>() {
			override error = vi.fn();
		};
		const dispatcher = new RemotePromptDispatcher(logService);
		const origin: RemoteRequestOrigin = { kind: 'missionControl', transportId: 'missionControl', commandId: 'command-1' };

		const result = dispatcher.dispatch('session-1', 'steer this', origin);
		await expect(result.completion).rejects.toThrow('rejected');

		expect(takePendingCopilotCLIRequestContext('session-1', result.correlationId)).toBeUndefined();
		expect(logService.error).toHaveBeenCalledTimes(1);
	});
});
