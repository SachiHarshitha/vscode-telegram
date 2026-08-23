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
import { Disposable, DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import type { IWorkspaceInfo } from '../../../chatSessions/common/workspaceInfo';
import type { IRemoteControlSession, IRemoteControlSessionEvent, IRemoteControlTransport, IRemotePermissionRequest, RemotePermissionResult, RemoteRequestOrigin } from '../../common/remoteControlTypes';
import { RemoteControlRegistry } from '../remoteControlRegistry';

const emptyWorkspace: IWorkspaceInfo = { folder: undefined, repository: undefined, worktree: undefined, worktreeProperties: undefined };

class TestSession implements IRemoteControlSession {
	readonly title = undefined;
	readonly pendingPrompt = undefined;
	readonly workspace = emptyWorkspace;
	private readonly eventEmitter = new Emitter<SessionEvent>();
	readonly onDidReceiveSessionEvent = this.eventEmitter.event;

	constructor(readonly sessionId: string, private readonly replay: () => readonly SessionEvent[]) { }
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

	constructor(readonly id: string) {
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

	it('takes the first valid permission response and cancels losing transports', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		let loserCancelled = false;
		const loser = Object.assign(new TestTransport('loser'), {
			requestPermission: async (_sessionId: string, _request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> =>
				new Promise(resolve => token.onCancellationRequested(() => { loserCancelled = true; resolve(undefined); })),
		});
		const winner = Object.assign(new TestTransport('winner'), {
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

	it('only trusts origins created by this registry instance', () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const trusted = registry.createMissionControlOrigin('command-1', 'plan');
		const forged = { ...trusted } as RemoteRequestOrigin;

		expect(registry.getValidatedMissionControlMode(trusted)).toBe('plan');
		expect(registry.getValidatedMissionControlMode(forged)).toBeUndefined();
	});

	it('aborts only an already-bound live wrapper and reports whether one existed', async () => {
		const registry = new RemoteControlRegistry(new class extends mock<ILogService>() { });
		const session = new TestSession('session-1', () => []);

		await expect(registry.abort(session.sessionId)).resolves.toBe(false);
		const binding = registry.bindSession(session);
		await expect(registry.abort(session.sessionId)).resolves.toBe(true);
		expect(session.abort).toHaveBeenCalledOnce();
		binding.dispose();
		await expect(registry.abort(session.sessionId)).resolves.toBe(false);
		expect(session.abort).toHaveBeenCalledOnce();
	});
});
