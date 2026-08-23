/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent } from '@github/copilot/sdk';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import {
	IRemoteCommandContext,
	IRemoteControlRegistry,
	IRemoteControlSession,
	IRemoteControlSessionEvent,
	IRemoteControlTransport,
	IRemotePermissionRequest,
	IRemoteUserInputRequest,
	IRemoteUserInputResponse,
	RemoteCommandHandler,
	RemoteControlMode,
	RemotePermissionResult,
	RemoteRequestOrigin,
} from '../common/remoteControlTypes';

const maxSeenEventIds = 10_000;
const supportedPersistedEventTypes = new Set([
	'user.message',
	'assistant.message',
	'assistant.turn_start',
	'assistant.turn_complete',
	'tool.execution_start',
	'tool.execution_complete',
]);

interface ILogicalAttachment {
	readonly transportId: string;
	refCount: number;
	replaying: boolean;
	readonly replayBuffer: IRemoteControlSessionEvent[];
	readonly seenIds: Set<string>;
	readonly seenIdOrder: string[];
	publishQueue: Promise<void>;
	lastEventId: string | null;
}

interface ISessionBinding {
	readonly session: IRemoteControlSession;
	listener: IDisposable;
	readonly normalizedById: Map<string, IRemoteControlSessionEvent>;
	readonly normalizedByObject: WeakMap<object, IRemoteControlSessionEvent>;
	lastEventId: string | null;
	nextSyntheticEventId: number;
}

export class RemoteControlRegistry extends Disposable implements IRemoteControlRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly transports = new Map<string, IRemoteControlTransport>();
	private readonly attachmentsBySessionId = new Map<string, Map<string, ILogicalAttachment>>();
	private readonly bindingsBySessionId = new Map<string, ISessionBinding>();
	private readonly commandHandlers = new Map<string, RemoteCommandHandler>();
	private readonly trustedOrigins = new WeakSet<object>();

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	bindSession(session: IRemoteControlSession): IDisposable {
		const existing = this.bindingsBySessionId.get(session.sessionId);
		existing?.listener.dispose();

		const binding: ISessionBinding = {
			session,
			listener: undefined!,
			normalizedById: new Map(),
			normalizedByObject: new WeakMap(),
			lastEventId: null,
			nextSyntheticEventId: 0,
		};
		binding.listener = session.onDidReceiveSessionEvent(event => this.acceptLiveEvent(session.sessionId, binding, event));
		this.bindingsBySessionId.set(session.sessionId, binding);

		for (const attachment of this.attachmentsBySessionId.get(session.sessionId)?.values() ?? []) {
			this.replayAttachment(session.sessionId, binding, attachment);
		}

		return toDisposable(() => {
			if (this.bindingsBySessionId.get(session.sessionId) === binding) {
				this.bindingsBySessionId.delete(session.sessionId);
				binding.listener.dispose();
			}
		});
	}

	getSession(sessionId: string): IRemoteControlSession | undefined {
		return this.bindingsBySessionId.get(sessionId)?.session;
	}

	registerTransport(transport: IRemoteControlTransport): IDisposable {
		if (this.transports.has(transport.id)) {
			throw new Error(`Remote-control transport '${transport.id}' is already registered.`);
		}
		this.transports.set(transport.id, transport);
		return toDisposable(() => {
			if (this.transports.get(transport.id) !== transport) {
				return;
			}
			this.transports.delete(transport.id);
			for (const [sessionId, attachments] of this.attachmentsBySessionId) {
				attachments.delete(transport.id);
				if (attachments.size === 0) {
					this.attachmentsBySessionId.delete(sessionId);
				}
			}
		});
	}

	attachTransport(sessionId: string, transportId: string): IDisposable {
		if (!this.transports.has(transportId)) {
			throw new Error(`Remote-control transport '${transportId}' is not registered.`);
		}
		let attachments = this.attachmentsBySessionId.get(sessionId);
		if (!attachments) {
			attachments = new Map();
			this.attachmentsBySessionId.set(sessionId, attachments);
		}
		let attachment = attachments.get(transportId);
		if (attachment) {
			attachment.refCount++;
		} else {
			attachment = {
				transportId,
				refCount: 1,
				replaying: false,
				replayBuffer: [],
				seenIds: new Set(),
				seenIdOrder: [],
				publishQueue: Promise.resolve(),
				lastEventId: null,
			};
			attachments.set(transportId, attachment);
			const binding = this.bindingsBySessionId.get(sessionId);
			if (binding) {
				this.replayAttachment(sessionId, binding, attachment);
			}
		}

		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			const currentAttachments = this.attachmentsBySessionId.get(sessionId);
			const current = currentAttachments?.get(transportId);
			if (!current) {
				return;
			}
			if (--current.refCount <= 0) {
				currentAttachments?.delete(transportId);
			}
			if (currentAttachments?.size === 0) {
				this.attachmentsBySessionId.delete(sessionId);
			}
		});
	}

	isTransportAttached(sessionId: string, transportId?: string): boolean {
		const attachments = this.attachmentsBySessionId.get(sessionId);
		return transportId ? attachments?.has(transportId) === true : !!attachments?.size;
	}

	getAttachedTransportLabels(sessionId: string): readonly string[] {
		return [...(this.attachmentsBySessionId.get(sessionId)?.keys() ?? [])]
			.map(id => this.transports.get(id)?.label)
			.filter((label): label is string => !!label);
	}

	registerCommandHandler(command: string, handler: RemoteCommandHandler): IDisposable {
		if (this.commandHandlers.has(command)) {
			throw new Error(`Remote command handler '${command}' is already registered.`);
		}
		this.commandHandlers.set(command, handler);
		return toDisposable(() => {
			if (this.commandHandlers.get(command) === handler) {
				this.commandHandlers.delete(command);
			}
		});
	}

	async handleCommand(command: string, context: IRemoteCommandContext): Promise<boolean> {
		const handler = this.commandHandlers.get(command);
		if (!handler) {
			return false;
		}
		await handler(context);
		return true;
	}

	createMissionControlOrigin(commandId: string, mode?: RemoteControlMode): RemoteRequestOrigin {
		const origin: RemoteRequestOrigin = Object.freeze({ kind: 'missionControl', transportId: 'missionControl', commandId, mode });
		this.trustedOrigins.add(origin);
		return origin;
	}

	createTelegramOrigin(updateId: string): RemoteRequestOrigin {
		const origin: RemoteRequestOrigin = Object.freeze({ kind: 'telegram', transportId: 'telegram', updateId });
		this.trustedOrigins.add(origin);
		return origin;
	}

	getValidatedMissionControlMode(origin: RemoteRequestOrigin | undefined): RemoteControlMode | undefined {
		return origin && this.trustedOrigins.has(origin) && origin.kind === 'missionControl' ? origin.mode : undefined;
	}

	requestPermission(sessionId: string, request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> {
		return this.firstValidResponse(
			sessionId,
			transport => transport.requestPermission ? childToken => transport.requestPermission!(sessionId, request, childToken) : undefined,
			token,
		);
	}

	requestUserInput(sessionId: string, request: IRemoteUserInputRequest, token: CancellationToken): Promise<IRemoteUserInputResponse | undefined> {
		return this.firstValidResponse(
			sessionId,
			transport => transport.requestUserInput ? childToken => transport.requestUserInput!(sessionId, request, childToken) : undefined,
			token,
		);
	}

	abort(sessionId: string): Promise<void> {
		return this.bindingsBySessionId.get(sessionId)?.session.abort() ?? Promise.resolve();
	}

	private acceptLiveEvent(sessionId: string, binding: ISessionBinding, event: SessionEvent): void {
		if (this.bindingsBySessionId.get(sessionId) !== binding) {
			return;
		}
		const normalized = this.normalizeEvent(sessionId, binding, event);
		for (const attachment of this.attachmentsBySessionId.get(sessionId)?.values() ?? []) {
			if (attachment.replaying) {
				attachment.replayBuffer.push(normalized);
			} else {
				this.publishToAttachment(sessionId, attachment, normalized);
			}
		}
	}

	private replayAttachment(sessionId: string, binding: ISessionBinding, attachment: ILogicalAttachment): void {
		attachment.replaying = true;
		try {
			for (const event of binding.session.getReplayEvents()) {
				if (supportedPersistedEventTypes.has(event.type)) {
					this.publishToAttachment(sessionId, attachment, this.normalizeEvent(sessionId, binding, event));
				}
			}
		} finally {
			attachment.replaying = false;
			for (const event of attachment.replayBuffer.splice(0)) {
				this.publishToAttachment(sessionId, attachment, event);
			}
		}
	}

	private normalizeEvent(sessionId: string, binding: ISessionBinding, event: SessionEvent): IRemoteControlSessionEvent {
		const eventObject = event as object;
		const byObject = binding.normalizedByObject.get(eventObject);
		if (byObject) {
			return byObject;
		}

		const raw = event as { readonly id?: unknown; readonly timestamp?: unknown; readonly parentId?: unknown; readonly ephemeral?: unknown; readonly type?: unknown; readonly data?: unknown };
		const rawId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
		if (rawId) {
			const byId = binding.normalizedById.get(rawId);
			if (byId) {
				binding.normalizedByObject.set(eventObject, byId);
				return byId;
			}
		}

		const id = rawId ?? `${sessionId}:remote-event:${++binding.nextSyntheticEventId}`;
		const parentId = typeof raw.parentId === 'string' ? raw.parentId : binding.lastEventId;
		const normalized: IRemoteControlSessionEvent = {
			id,
			timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
			parentId: parentId ?? null,
			ephemeral: typeof raw.ephemeral === 'boolean' ? raw.ephemeral : undefined,
			type: typeof raw.type === 'string' ? raw.type : 'unknown',
			data: raw.data,
		};
		binding.lastEventId = id;
		binding.normalizedById.set(id, normalized);
		binding.normalizedByObject.set(eventObject, normalized);
		return normalized;
	}

	private publishToAttachment(sessionId: string, attachment: ILogicalAttachment, event: IRemoteControlSessionEvent): void {
		if (attachment.seenIds.has(event.id)) {
			return;
		}
		attachment.seenIds.add(event.id);
		attachment.seenIdOrder.push(event.id);
		while (attachment.seenIdOrder.length > maxSeenEventIds) {
			attachment.seenIds.delete(attachment.seenIdOrder.shift()!);
		}

		const publishedEvent = event.parentId === event.id ? { ...event, parentId: attachment.lastEventId } : event;
		attachment.lastEventId = event.id;
		attachment.publishQueue = attachment.publishQueue.then(async () => {
			const transport = this.transports.get(attachment.transportId);
			if (transport && this.attachmentsBySessionId.get(sessionId)?.get(attachment.transportId) === attachment) {
				await transport.publish(sessionId, publishedEvent);
			}
		}).catch(error => {
			this.logService.warn(`[RemoteControlRegistry] Failed to publish ${event.type} to ${attachment.transportId}: ${error}`);
		});
	}

	private firstValidResponse<T>(
		sessionId: string,
		getRequest: (transport: IRemoteControlTransport) => ((token: CancellationToken) => Promise<T | undefined>) | undefined,
		token: CancellationToken,
	): Promise<T | undefined> {
		const requests = [...(this.attachmentsBySessionId.get(sessionId)?.keys() ?? [])]
			.map(id => this.transports.get(id))
			.filter((transport): transport is IRemoteControlTransport => !!transport)
			.map(transport => ({ transport, request: getRequest(transport) }))
			.filter((entry): entry is { transport: IRemoteControlTransport; request: (token: CancellationToken) => Promise<T | undefined> } => !!entry.request);

		if (requests.length === 0 || token.isCancellationRequested) {
			return Promise.resolve(undefined);
		}

		return new Promise<T | undefined>(resolve => {
			let remaining = requests.length;
			let settled = false;
			const tokenSources = requests.map(() => new CancellationTokenSource(token));
			let cancellationListener: IDisposable = Disposable.None;
			const complete = (value: T | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				cancellationListener.dispose();
				for (const source of tokenSources) {
					source.dispose(true);
				}
				resolve(value);
			};
			cancellationListener = token.onCancellationRequested(() => complete(undefined));
			if (settled) {
				cancellationListener.dispose();
				return;
			}
			if (token.isCancellationRequested) {
				complete(undefined);
			}
			if (settled) {
				return;
			}

			requests.forEach(({ transport, request }, index) => {
				void request(tokenSources[index].token).then(value => {
					if (value !== undefined) {
						complete(value);
					} else if (--remaining === 0) {
						complete(undefined);
					}
				}, error => {
					this.logService.warn(`[RemoteControlRegistry] ${transport.id} response failed: ${error}`);
					if (--remaining === 0) {
						complete(undefined);
					}
				});
			});
		});
	}

	public override dispose(): void {
		for (const binding of this.bindingsBySessionId.values()) {
			binding.listener.dispose();
		}
		this.bindingsBySessionId.clear();
		this.attachmentsBySessionId.clear();
		this.commandHandlers.clear();
		this.transports.clear();
		super.dispose();
	}
}
