/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import type { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import type { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import type { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import type { IChatSessionMetadataStore } from '../../../chatSessions/common/chatSessionMetadataStore';
import { RemoteControlRegistry } from '../../node/remoteControlRegistry';
import { MissionControlTransport } from '../missionControlTransport';
import type { IRemotePromptDispatcher, IRemotePromptDispatchResult } from '../remotePromptDispatcher';

function createState() {
	return {
		sessionId: 'session-1',
		mcSessionId: 'mc-session-1',
		eventBuffer: [] as Array<{ id: string; timestamp: string; parentId: string | null; type: string; data: Record<string, unknown> }>,
		completedCommandIds: [] as string[],
		processedCommandIds: new Set<string>(),
		pendingCommandCompletionIds: new Set<string>(),
		pendingPermissionRequests: new Map(),
		pendingUserInputRequests: new Set(),
		pendingExitPlanModeRequests: new Set(),
		attachment: Disposable.None,
		lastEventId: null,
		lastSubmitAttemptTimeMs: Date.now(),
	};
}

function createTransport(commands: unknown[] = []) {
	const logService = new class extends mock<ILogService>() {
		override warn = vi.fn();
		override error = vi.fn();
	};
	const registry = new RemoteControlRegistry(logService);
	const dispatch = vi.fn((_sessionId: string, _prompt: string, _origin: unknown): IRemotePromptDispatchResult => ({
		accepted: true,
		correlationId: 'correlation-1',
		completion: Promise.resolve(),
	}));
	const promptDispatcher = {
		_serviceBrand: undefined,
		dispatch,
		prepare: vi.fn(() => ({ correlationId: 'correlation-1', start: () => dispatch('', '', undefined) })),
	} as unknown as IRemotePromptDispatcher;
	const apiClient = {
		getPendingCommands: vi.fn(async () => commands),
		submitEvents: vi.fn(async (_sessionId: string, _events: unknown[], _completedCommandIds: string[]) => true),
	};
	const instantiationService = {
		createInstance: vi.fn(() => apiClient),
	} as unknown as IInstantiationService;
	const transport = new MissionControlTransport(
		registry,
		promptDispatcher,
		new class extends mock<IAuthenticationService>() { },
		new class extends mock<IConfigurationService>() { },
		logService,
		new class extends mock<IChatSessionMetadataStore>() {
			override getCustomTitle = vi.fn(async () => undefined);
		},
		instantiationService,
	);
	return { transport, registry, dispatch, apiClient };
}

describe('MissionControlTransport', () => {
	it('owns event sanitization and command completion acknowledgement', () => {
		const { transport } = createTransport();
		const state = createState();
		state.pendingCommandCompletionIds.add('command-1');
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);

		transport.publish(state.sessionId, {
			id: 'event-1',
			timestamp: '2026-01-01T00:00:00.000Z',
			parentId: null,
			type: 'user.message',
			data: { content: 'hello <reminder>hidden</reminder>', source: 'command-command-1' },
		});
		transport.publish(state.sessionId, {
			id: 'event-2',
			timestamp: '2026-01-01T00:00:01.000Z',
			parentId: 'event-1',
			type: 'tool.execution_start',
			data: { toolName: 'bash', arguments: { command: 'echo hello', description: 'description' } },
		});

		expect(state.completedCommandIds).toEqual(['command-1']);
		expect((state.eventBuffer[0].data as { content: string }).content).toBe('hello');
		expect((state.eventBuffer[1].data as { arguments: unknown }).arguments).toEqual({ command: 'echo hello' });
	});

	it('handles mode commands inside the transport and dispatches a trusted steering origin', async () => {
		const commands = [
			{ id: 'mode-1', content: JSON.stringify({ mode: 'plan' }), state: 'in_progress', type: 'user_message' },
			{ id: 'prompt-1', content: 'make a plan', state: 'in_progress', type: 'user_message' },
		];
		const { transport, registry, dispatch } = createTransport(commands);
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);

		await (transport as unknown as { pollCommands(state: unknown): Promise<void> }).pollCommands(state);

		expect(state.completedCommandIds).toContain('mode-1');
		expect(dispatch).toHaveBeenCalledTimes(1);
		const origin = dispatch.mock.calls[0][2];
		expect(registry.getValidatedRemoteMode(origin as never)).toBe('plan');
	});

	it('rejects stale permission responses and accepts a fully correlated response', async () => {
		const { transport } = createTransport();
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);
		const responsePromise = transport.requestPermission(state.sessionId, {
			requestId: 'request-1',
			permissionRequest: { kind: 'shell', toolCallId: 'tool-1' },
		}, CancellationToken.None);
		const accept = (transport as unknown as { acceptPermissionResponse(state: unknown, command: unknown): void }).acceptPermissionResponse.bind(transport);

		accept(state, { id: 'stale', content: JSON.stringify({ promptId: 'tool-1', requestId: 'request-2', approved: true }) });
		expect(state.pendingPermissionRequests.size).toBe(1);
		accept(state, { id: 'valid', content: JSON.stringify({ promptId: 'tool-1', requestId: 'request-1', toolCallId: 'tool-1', approved: true }) });

		await expect(responsePromise).resolves.toEqual({ kind: 'approve-once' });
		expect(state.pendingPermissionRequests.size).toBe(0);
	});

	it('rejects stale user input and accepts a fully correlated answer', async () => {
		const { transport } = createTransport();
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);
		const responsePromise = transport.requestUserInput(state.sessionId, {
			requestId: 'request-1',
			toolCallId: 'tool-1',
			question: 'Continue?',
			choices: ['Yes', 'No'],
			allowFreeform: false,
		}, CancellationToken.None);
		const accept = (transport as unknown as { acceptUserInputResponse(state: unknown, command: unknown): void }).acceptUserInputResponse.bind(transport);

		accept(state, { id: 'stale', content: JSON.stringify({ requestId: 'request-2', toolCallId: 'tool-1', answer: 'No' }) });
		expect(state.pendingUserInputRequests.size).toBe(1);
		accept(state, { id: 'valid', content: JSON.stringify({ requestId: 'request-1', toolCallId: 'tool-1', answer: 'Yes' }) });

		await expect(responsePromise).resolves.toEqual({ answer: 'Yes', wasFreeform: false });
		expect(state.pendingUserInputRequests.size).toBe(0);
	});

	it('accepts a correlated safe plan action through command polling', async () => {
		const commands = [{
			id: 'plan-response-1',
			content: JSON.stringify({ requestId: 'plan-1', toolCallId: 'tool-1', approved: true, selectedAction: 'interactive' }),
			state: 'in_progress',
			type: 'exit_plan_mode_response',
		}];
		const { transport } = createTransport(commands);
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);
		const responsePromise = transport.requestExitPlanMode(state.sessionId, {
			requestId: 'plan-1',
			toolCallId: 'tool-1',
			summary: 'Plan ready',
			actions: ['interactive', 'exit_only'],
		}, CancellationToken.None);

		await (transport as unknown as { pollCommands(state: unknown): Promise<void> }).pollCommands(state);

		await expect(responsePromise).resolves.toEqual({ approved: true, selectedAction: 'interactive' });
		expect(state.completedCommandIds).toEqual(['plan-response-1']);
	});

	it('keeps waiting after stale or permission-elevating plan responses', async () => {
		const { transport } = createTransport();
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);
		const responsePromise = transport.requestExitPlanMode(state.sessionId, {
			requestId: 'plan-1',
			toolCallId: 'tool-1',
			summary: 'Plan ready',
			actions: ['interactive', 'exit_only'],
		}, CancellationToken.None);
		const accept = (transport as unknown as { acceptExitPlanModeResponse(state: unknown, command: unknown): void }).acceptExitPlanModeResponse.bind(transport);

		accept(state, { id: 'stale', content: JSON.stringify({ requestId: 'plan-2', toolCallId: 'tool-1', approved: true, selectedAction: 'interactive' }) });
		accept(state, { id: 'unsafe', content: JSON.stringify({ requestId: 'plan-1', toolCallId: 'tool-1', approved: true, selectedAction: 'autopilot' }) });
		expect(state.pendingExitPlanModeRequests.size).toBe(1);
		accept(state, { id: 'denied', content: JSON.stringify({ requestId: 'plan-1', toolCallId: 'tool-1', approved: false, feedback: 'Revise tests' }) });

		await expect(responsePromise).resolves.toEqual({ approved: false, feedback: 'Revise tests' });
		expect(state.pendingExitPlanModeRequests.size).toBe(0);
	});

	it('routes abort through the registry and acknowledges the command', async () => {
		const commands = [{ id: 'abort-1', content: '', state: 'in_progress', type: 'abort' }];
		const { transport, registry } = createTransport(commands);
		const abort = vi.spyOn(registry, 'abort').mockResolvedValue(true);
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);

		await (transport as unknown as { pollCommands(state: unknown): Promise<void> }).pollCommands(state);

		expect(abort).toHaveBeenCalledWith(state.sessionId, 'missionControl');
		expect(state.completedCommandIds).toContain('abort-1');
	});

	it('does not retain interactive waiters for an already-cancelled request', async () => {
		const { transport } = createTransport();
		const state = createState();
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);
		const cancellation = new CancellationTokenSource();
		cancellation.cancel();

		await expect(transport.requestPermission(state.sessionId, {
			requestId: 'request-1',
			permissionRequest: { kind: 'shell', toolCallId: 'tool-1' },
		}, cancellation.token)).resolves.toBeUndefined();
		await expect(transport.requestUserInput(state.sessionId, {
			requestId: 'question-1',
			question: 'Continue?',
			choices: [],
			allowFreeform: true,
		}, cancellation.token)).resolves.toBeUndefined();
		await expect(transport.requestExitPlanMode(state.sessionId, {
			requestId: 'plan-1',
			summary: 'Plan ready',
			actions: ['interactive'],
		}, cancellation.token)).resolves.toBeUndefined();

		expect(state.pendingPermissionRequests.size).toBe(0);
		expect(state.pendingUserInputRequests.size).toBe(0);
		expect(state.pendingExitPlanModeRequests.size).toBe(0);
		cancellation.dispose();
	});

	it('requeues events and command acknowledgements when submission throws', async () => {
		const { transport, apiClient } = createTransport();
		const state = createState();
		state.eventBuffer.push({ id: 'event-1', timestamp: '2026-01-01T00:00:00.000Z', parentId: null, type: 'user.message', data: {} });
		state.completedCommandIds.push('command-1');
		apiClient.submitEvents.mockRejectedValueOnce(new Error('offline'));

		await (transport as unknown as { flushEvents(state: unknown): Promise<void> }).flushEvents(state);

		expect(state.eventBuffer.map(event => event.id)).toEqual(['event-1']);
		expect(state.completedCommandIds).toEqual(['command-1']);
	});

	it('tears down attachment and pending responders before flushing terminal events', async () => {
		const { transport, apiClient } = createTransport();
		const state = createState();
		const disposeAttachment = vi.fn();
		state.attachment = { dispose: disposeAttachment };
		(transport as unknown as { states: Map<string, unknown> }).states.set(state.sessionId, state);
		const permission = transport.requestPermission(state.sessionId, {
			requestId: 'request-1',
			permissionRequest: { kind: 'shell', toolCallId: 'tool-1' },
		}, CancellationToken.None);
		const userInput = transport.requestUserInput(state.sessionId, {
			requestId: 'question-1',
			question: 'Continue?',
			choices: [],
			allowFreeform: true,
		}, CancellationToken.None);
		const plan = transport.requestExitPlanMode(state.sessionId, {
			requestId: 'plan-1',
			summary: 'Plan ready',
			actions: ['exit_only'],
		}, CancellationToken.None);

		await (transport as unknown as { teardown(sessionId: string): Promise<void> }).teardown(state.sessionId);

		expect(disposeAttachment).toHaveBeenCalledOnce();
		await expect(permission).resolves.toBeUndefined();
		await expect(userInput).resolves.toBeUndefined();
		await expect(plan).resolves.toBeUndefined();
		expect((transport as unknown as { states: Map<string, unknown> }).states.has(state.sessionId)).toBe(false);
		const submittedEvents = apiClient.submitEvents.mock.calls.flatMap(call => call[1] as Array<{ type: string }>);
		expect(submittedEvents.map(event => event.type)).toEqual([
			'session.remote_steerable_changed',
			'session.idle',
		]);
	});
});
