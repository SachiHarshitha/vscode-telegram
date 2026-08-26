/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent } from '@github/copilot/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from '../../../../util/vs/base/common/lifecycle';
import type { IWorkspaceInfo } from '../../../chatSessions/common/workspaceInfo';
import type { IRemoteControlSession, IRemoteControlSessionEvent, IRemoteControlTransport, IRemoteControlTransportCapabilities, IRemoteExitPlanModeRequest, IRemotePermissionRequest, RemotePermissionResult, RemoteRequestOrigin } from '../../common/remoteControlTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';

const emptyWorkspace: IWorkspaceInfo = { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined };

class TestSession implements IRemoteControlSession {
	readonly title = undefined;
	readonly pendingPrompt = undefined;
	readonly workspace = emptyWorkspace;
	private readonly eventEmitter = new Emitter<SessionEvent>();
	readonly onDidReceiveSessionEvent = this.eventEmitter.event;

	constructor(readonly sessionId: string, private readonly replay: () => readonly SessionEvent[] = () => []) { }
	emit(event: SessionEvent): void { this.eventEmitter.fire(event); }
	getReplayEvents(): readonly SessionEvent[] { return this.replay(); }
	abort = vi.fn(async () => { });
	notifyRemoteAttachment = vi.fn();
	getCurrentMode(): string | undefined { return undefined; }
}

class TestTransport extends Disposable implements IRemoteControlTransport {
	readonly label: string;
	readonly themeIcon = 'radio-tower';
	readonly events: IRemoteControlSessionEvent[] = [];

	constructor(readonly id: string, readonly capabilities?: IRemoteControlTransportCapabilities) {
		super();
		this.label = id;
	}

	publish(_sessionId: string, event: IRemoteControlSessionEvent): void {
		this.events.push(event);
	}
}

function event(id: string, type: string, parentId: string | null = null): SessionEvent {
	return { id, type, timestamp: `2026-01-01T00:00:0${id.length}.000Z`, parentId, data: {} } as SessionEvent;
}

async function drainPublishQueue(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

describe('RemoteControlRegistry', () => {
	it('buffers live events during replay, preserves order, deduplicates, and repairs self-parent ids', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const transport = new TestTransport('missionControl');
		registry.registerTransport(transport);
		const replayEvent = event('replay', 'session.start', 'replay');
		const liveEvent = event('live', 'assistant.message', 'replay');
		const session = new TestSession('session-1', () => {
			session.emit(liveEvent);
			return [replayEvent, liveEvent];
		});
		registry.bindSession(session);
		registry.attachTransport(session.sessionId, transport.id);
		await drainPublishQueue();

		expect(transport.events.map(item => ({ id: item.id, parentId: item.parentId, replay: item.replay }))).toEqual([
			{ id: 'replay', parentId: null, replay: true },
			{ id: 'live', parentId: 'replay', replay: true },
		]);
	});

	it('filters unsupported persisted events without filtering the live stream', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const transport = new TestTransport('missionControl');
		registry.registerTransport(transport);
		const session = new TestSession('session-1', () => [
			event('persisted', 'assistant.message'),
			event('stale-delta', 'assistant.message_delta'),
		]);
		registry.bindSession(session);
		registry.attachTransport(session.sessionId, transport.id);
		session.emit(event('live-delta', 'assistant.message_delta', 'persisted'));
		await drainPublishQueue();

		expect(transport.events.map(item => item.id)).toEqual(['persisted', 'live-delta']);
	});

	it('fans out once to multiple transports and keeps logical attachments across wrapper churn', async () => {
		const store = new DisposableStore();
		const registry = store.add(new RemoteControlRegistry(new class extends mock<ILogService>() { }));
		const first = store.add(new TestTransport('first'));
		const second = store.add(new TestTransport('second'));
		store.add(registry.registerTransport(first));
		store.add(registry.registerTransport(second));
		const firstEvent = event('one', 'assistant.turn_start');
		const secondEvent = event('two', 'assistant.message', 'one');
		const firstBinding = registry.bindSession(new TestSession('session-1', () => [firstEvent]));
		store.add(registry.attachTransport('session-1', first.id));
		store.add(registry.attachTransport('session-1', second.id));
		await drainPublishQueue();
		firstBinding.dispose();
		store.add(registry.bindSession(new TestSession('session-1', () => [firstEvent, secondEvent])));
		await drainPublishQueue();

		expect(first.events.map(item => item.id)).toEqual(['one', 'two']);
		expect(second.events.map(item => item.id)).toEqual(['one', 'two']);
		store.dispose();
	});

	it('publishes logical attachment changes and detaches a transport synchronously', () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const transport = new TestTransport('telegram');
		registry.registerTransport(transport);
		const changes: string[] = [];
		registry.onDidChangeAttachments(sessionId => changes.push(sessionId));
		const attachment = registry.attachTransport('session-1', transport.id);

		expect(registry.getAttachments('session-1')).toEqual([
			{ transportId: 'telegram', label: 'telegram', themeIcon: 'radio-tower', remotePermissionResponses: false },
		]);
		expect(registry.getAttachedSessionIds('telegram')).toEqual(['session-1']);

		registry.detachTransport('telegram');
		expect({ attachments: registry.getAttachments('session-1'), changes }).toEqual({
			attachments: [],
			changes: ['session-1', 'session-1'],
		});
		attachment.dispose();
	});

	it('restores the native attachment notice when a session binds after its transport', () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const transport = Object.assign(new TestTransport('synthetic', { permissionResponses: true }), {
			requestPermission: async (): Promise<RemotePermissionResult | undefined> => undefined,
		});
		registry.registerTransport(transport);
		registry.attachTransport('session-1', transport.id);
		const session = new TestSession('session-1');

		registry.bindSession(session);

		expect(session.notifyRemoteAttachment).toHaveBeenCalledWith('synthetic', true);
	});

	it('takes the first valid permission response and cancels losing transports', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		let loserCancelled = false;
		const loser = Object.assign(new TestTransport('loser', { permissionResponses: true }), {
			requestPermission: async (_sessionId: string, _request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> =>
				new Promise(resolve => token.onCancellationRequested(() => { loserCancelled = true; resolve(undefined); })),
		});
		const winner = Object.assign(new TestTransport('winner', { permissionResponses: true }), {
			requestPermission: async (): Promise<RemotePermissionResult> => ({ kind: 'denied-interactively-by-user' }),
		});
		registry.registerTransport(loser);
		registry.registerTransport(winner);
		registry.attachTransport('session-1', loser.id);
		registry.attachTransport('session-1', winner.id);

		const result = await registry.requestPermission('session-1', {
			requestId: 'request-1',
			permissionRequest: { kind: 'shell', toolCallId: 'tool-1' },
		}, CancellationToken.None);

		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
		expect(loserCancelled).toBe(true);
	});

	it('cancels and settles pending responses when a transport is removed', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		let cancelled = false;
		const transport = Object.assign(new TestTransport('removable', { permissionResponses: true }), {
			requestPermission: async (_sessionId: string, _request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> =>
				new Promise(resolve => token.onCancellationRequested(() => {
					cancelled = true;
					resolve(undefined);
				})),
		});
		const registration = registry.registerTransport(transport);
		registry.attachTransport('session-1', transport.id);
		const response = registry.requestPermission('session-1', {
			requestId: 'request-1', permissionRequest: { kind: 'shell' },
		}, CancellationToken.None);

		registration.dispose();

		await expect(response).resolves.toBeUndefined();
		expect(cancelled).toBe(true);
	});

	it('settles pending responses across every session and extension teardown boundary', async () => {
		const triggers: readonly [string, (registry: RemoteControlRegistry, binding: IDisposable, attachment: IDisposable) => void][] = [
			['attachment disposal', (_registry, _binding, attachment) => attachment.dispose()],
			['transport suspension', registry => registry.suspendTransport('pending')],
			['session disposal', (_registry, binding) => binding.dispose()],
			['session replacement', registry => { registry.bindSession(new TestSession('session-1')); }],
			['registry disposal', registry => registry.dispose()],
		];
		for (const [name, trigger] of triggers) {
			const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
			let cancelled = false;
			const transport = Object.assign(new TestTransport('pending', { permissionResponses: true }), {
				requestPermission: async (_sessionId: string, _request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> =>
					new Promise(resolve => token.onCancellationRequested(() => {
						cancelled = true;
						resolve(undefined);
					})),
			});
			registry.registerTransport(transport);
			const binding = registry.bindSession(new TestSession('session-1'));
			const attachment = registry.attachTransport('session-1', transport.id);
			const response = registry.requestPermission('session-1', {
				requestId: `request-${name}`, permissionRequest: { kind: 'shell' },
			}, CancellationToken.None);

			trigger(registry, binding, attachment);

			await expect(response, name).resolves.toBeUndefined();
			expect(cancelled, name).toBe(true);
			registry.dispose();
		}
	});

	it('rejects permission-elevating plan responses before selecting the first safe response', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const unsafe = Object.assign(new TestTransport('unsafe', { exitPlanResponses: true }), {
			requestExitPlanMode: async () => ({ approved: true, selectedAction: 'autopilot' }) as never,
		});
		const safe = Object.assign(new TestTransport('safe', { exitPlanResponses: true }), {
			requestExitPlanMode: async (_sessionId: string, _request: IRemoteExitPlanModeRequest) => ({ approved: true as const, selectedAction: 'interactive' as const }),
		});
		registry.registerTransport(unsafe);
		registry.registerTransport(safe);
		registry.attachTransport('session-1', unsafe.id);
		registry.attachTransport('session-1', safe.id);

		const result = await registry.requestExitPlanMode('session-1', {
			requestId: 'plan-1',
			summary: 'Plan ready',
			actions: ['interactive', 'exit_only'],
		}, CancellationToken.None);

		expect(result).toEqual({ approved: true, selectedAction: 'interactive' });
	});

	it('races Mission Control and Telegram plan responses and cancels the loser', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		let missionControlCancelled = false;
		const missionControl = Object.assign(new TestTransport('missionControl', { exitPlanResponses: true }), {
			requestExitPlanMode: async (_sessionId: string, _request: IRemoteExitPlanModeRequest, token: CancellationToken) =>
				new Promise<undefined>(resolve => token.onCancellationRequested(() => {
					missionControlCancelled = true;
					resolve(undefined);
				})),
		});
		const telegram = Object.assign(new TestTransport('telegram', { exitPlanResponses: true }), {
			requestExitPlanMode: async () => ({ approved: false as const, feedback: 'Revise the tests' }),
		});
		registry.registerTransport(missionControl);
		registry.registerTransport(telegram);
		registry.attachTransport('session-1', missionControl.id);
		registry.attachTransport('session-1', telegram.id);

		const result = await registry.requestExitPlanMode('session-1', {
			requestId: 'plan-1',
			summary: 'Plan ready',
			actions: ['interactive'],
		}, CancellationToken.None);

		expect(result).toEqual({ approved: false, feedback: 'Revise the tests' });
		expect(missionControlCancelled).toBe(true);
	});

	it('supports a synthetic third transport through only the generic lifecycle and declared capabilities', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const synthetic = Object.assign(new TestTransport('synthetic', {
			submitPrompt: true,
			requestModes: ['interactive', 'plan'],
			permissionResponses: true,
			userInputResponses: true,
			exitPlanResponses: true,
			abort: true,
		}), {
			requestPermission: vi.fn(async () => ({ kind: 'approved' as const })),
			requestUserInput: vi.fn(async () => ({ answer: 'Choice A', wasFreeform: false })),
			requestExitPlanMode: vi.fn(async () => ({ approved: true as const, selectedAction: 'interactive' as const })),
		});
		const registration = registry.registerTransport(synthetic);
		const session = new TestSession('session-1', () => [event('replay', 'session.start')]);
		const binding = registry.bindSession(session);
		const attachment = registry.attachTransport(session.sessionId, synthetic.id);
		session.emit(event('live', 'assistant.message', 'replay'));
		await drainPublishQueue();

		const origin = registry.createRequestOrigin(synthetic.id, 'request-1', 'plan');
		const permission = await registry.requestPermission(session.sessionId, {
			requestId: 'request-1', permissionRequest: { kind: 'shell' },
		}, CancellationToken.None);
		const answer = await registry.requestUserInput(session.sessionId, {
			requestId: 'request-1', question: 'Choose', choices: ['Choice A'], allowFreeform: false,
		}, CancellationToken.None);
		const plan = await registry.requestExitPlanMode(session.sessionId, {
			requestId: 'request-1', summary: 'Ready', actions: ['interactive'],
		}, CancellationToken.None);
		const aborted = await registry.abort(session.sessionId, synthetic.id);

		expect({
			events: synthetic.events.map(item => item.id),
			mode: registry.getValidatedRemoteMode(origin),
			permission,
			answer,
			plan,
			aborted,
		}).toEqual({
			events: ['replay', 'live'],
			mode: 'plan',
			permission: { kind: 'approved' },
			answer: { answer: 'Choice A', wasFreeform: false },
			plan: { approved: true, selectedAction: 'interactive' },
			aborted: true,
		});

		attachment.dispose();
		registration.dispose();
		binding.dispose();
		expect(registry.getAttachments(session.sessionId)).toEqual([]);
		registry.dispose();
	});

	it('only trusts origins created by this registry instance and a prompt-capable transport', () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		registry.registerTransport(new TestTransport('missionControl', {
			submitPrompt: true,
			requestModes: ['interactive', 'plan', 'autopilot'],
			elevatedModes: true,
		}));
		const trusted = registry.createRequestOrigin('missionControl', 'command-1', 'plan');
		const forged = { ...trusted } as RemoteRequestOrigin;

		expect(registry.getValidatedRemoteMode(trusted)).toBe('plan');
		expect(registry.getValidatedRemoteMode(forged)).toBeUndefined();
	});

	it('defaults third-party transports to non-elevating prompt capabilities', () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		registry.registerTransport(new TestTransport('synthetic', { submitPrompt: true, requestModes: ['interactive', 'plan'] }));
		const plan = registry.createRequestOrigin('synthetic', 'update-1', 'plan');
		const interactive = registry.createRequestOrigin('synthetic', 'update-2');
		const forged = { ...plan } as RemoteRequestOrigin;

		expect(registry.getValidatedRemoteMode(plan)).toBe('plan');
		expect(registry.getValidatedRemoteMode(interactive)).toBe('interactive');
		expect(registry.getValidatedRemoteMode(forged)).toBeUndefined();
		expect(() => registry.createRequestOrigin('synthetic', 'update-3', 'autopilot')).toThrow();
	});

	it('aborts only an already-bound live wrapper and reports whether one existed', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		registry.registerTransport(new TestTransport('synthetic', { abort: true }));
		registry.attachTransport('session-1', 'synthetic');
		const session = new TestSession('session-1', () => []);

		await expect(registry.abort(session.sessionId, 'synthetic')).resolves.toBe(false);
		const binding = registry.bindSession(session);
		await expect(registry.abort(session.sessionId, 'synthetic')).resolves.toBe(true);
		expect(session.abort).toHaveBeenCalledOnce();
		binding.dispose();
		await expect(registry.abort(session.sessionId, 'synthetic')).resolves.toBe(false);
		expect(session.abort).toHaveBeenCalledOnce();
	});
});
