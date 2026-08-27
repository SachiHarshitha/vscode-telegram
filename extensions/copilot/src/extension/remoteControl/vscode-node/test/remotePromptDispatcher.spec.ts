/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { getPendingCopilotCLIRequestCorrelationId, takePendingCopilotCLIRequestContext, takePendingCopilotCLIRequestContextResult } from '../../../chatSessions/copilotcli/common/pendingRequestContext';
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
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'telegram', requestId: '42', mode: 'interactive' };

		const result = dispatcher.dispatch('session-1', 'steer this', origin);

		expect(result.accepted).toBe(true);
		expect(vscodeMocks.executeCommand).toHaveBeenCalledTimes(1);
		const [, options] = vscodeMocks.executeCommand.mock.calls[0] as [string, { queue: string; attachedContext: Array<{ id: string; value: unknown }> }];
		expect(options.queue).toBe('steering');
		const correlationId = getPendingCopilotCLIRequestCorrelationId(options.attachedContext);
		expect(correlationId).toBe(result.correlationId);
		expect(takePendingCopilotCLIRequestContext('session-1', correlationId!)?.origin).toBe(origin);
	});

	it('does not invoke the native command until a prepared dispatch starts', () => {
		vscodeMocks.executeCommand.mockResolvedValue(undefined);
		const dispatcher = new RemotePromptDispatcher(new class extends mock<ILogService>() { });
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'telegram', requestId: 'prepared-1', mode: 'interactive' };

		const prepared = dispatcher.prepare('session-1', 'build now', origin);

		expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
		const result = prepared.start();
		expect(result.correlationId).toBe(prepared.correlationId);
		expect(vscodeMocks.executeCommand).toHaveBeenCalledOnce();
		expect(() => prepared.start()).toThrow('already started');
	});

	it('cancels a started dispatch before the native request takes its context', () => {
		vscodeMocks.executeCommand.mockReturnValue(new Promise<void>(() => { }));
		const dispatcher = new RemotePromptDispatcher(new class extends mock<ILogService>() { });
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'telegram', requestId: 'cancel-1', mode: 'interactive' };
		const prepared = dispatcher.prepare('session-cancel', 'long task', origin);
		prepared.start();

		expect(prepared.cancel()).toBe(true);
		expect(takePendingCopilotCLIRequestContextResult('session-cancel', prepared.correlationId)).toEqual({ kind: 'cancelled' });
	});

	it('forwards a validated model and reasoning effort through the native ChatRequest options', () => {
		vscodeMocks.executeCommand.mockResolvedValue(undefined);
		const dispatcher = new RemotePromptDispatcher(new class extends mock<ILogService>() { });
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'telegram', requestId: 'model-1', mode: 'plan' };

		dispatcher.dispatch('session-model', 'plan this change', origin, { modelId: 'claude-sonnet', reasoningEffort: 'high' });

		expect(vscodeMocks.executeCommand).toHaveBeenCalledWith(
			'workbench.action.chat.openSessionWithPrompt.copilotcli',
			expect.objectContaining({
				userSelectedModelId: 'copilotcli/claude-sonnet',
				userSelectedModelConfiguration: { reasoningEffort: 'high' },
			}),
		);
	});

	it('forwards a VS Code model through the private configuration seam without forging a Copilot CLI id', () => {
		vscodeMocks.executeCommand.mockResolvedValue(undefined);
		const dispatcher = new RemotePromptDispatcher(new class extends mock<ILogService>() { });
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'telegram', requestId: 'model-custom', mode: 'interactive' };

		dispatcher.dispatch('session-custom', 'use my configured model', origin, { modelId: 'openai/work', modelSource: 'vscode-lm' });

		expect(vscodeMocks.executeCommand).toHaveBeenCalledWith(
			'workbench.action.chat.openSessionWithPrompt.copilotcli',
			expect.objectContaining({
				userSelectedModelId: undefined,
				userSelectedModelConfiguration: { remoteControlModelId: 'openai/work' },
			}),
		);
	});

	it('clears only its correlation when the native command rejects', async () => {
		vscodeMocks.executeCommand.mockRejectedValue(new Error('rejected'));
		const logService = new class extends mock<ILogService>() {
			override error = vi.fn();
		};
		const dispatcher = new RemotePromptDispatcher(logService);
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'missionControl', requestId: 'command-1', mode: 'interactive' };

		const result = dispatcher.dispatch('session-1', 'steer this', origin);
		await expect(result.completion).rejects.toThrow('rejected');

		expect(takePendingCopilotCLIRequestContext('session-1', result.correlationId)).toBeUndefined();
		expect(logService.error).toHaveBeenCalledTimes(1);
	});

	it('clears its correlation when command dispatch throws synchronously', () => {
		vscodeMocks.executeCommand.mockImplementation(() => { throw new Error('sync rejection'); });
		const logService = new class extends mock<ILogService>() {
			override error = vi.fn();
		};
		const dispatcher = new RemotePromptDispatcher(logService);
		const origin: RemoteRequestOrigin = { kind: 'remoteControl', transportId: 'telegram', requestId: '43', mode: 'interactive' };

		expect(() => dispatcher.dispatch('session-sync', 'prompt', origin)).toThrow('sync rejection');
		expect(logService.error).toHaveBeenCalledOnce();
	});
});
