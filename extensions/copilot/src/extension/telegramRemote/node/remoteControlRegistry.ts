/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent } from '@github/copilot/sdk';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { isReplayableRemoteAgentEventType } from '../common/remoteAgentEvent';
import {
	IRemoteCommandContext,
	IRemoteControlRegistry,
	IRemoteAttachmentInfo,
	IRemoteControlSession,
	IRemoteControlSessionEvent,
	IRemoteControlTransport,
	IRemoteExitPlanModeRequest,
	IRemoteExitPlanModeResponse,
	IRemotePermissionRequest,
	IRemoteUserInputRequest,
	IRemoteUserInputResponse,
	RemoteCommandHandler,
	RemoteControlMode,
	RemoteNonElevatingMode,
	RemotePermissionResult,
	RemoteRequestOrigin,
} from '../common/remoteControlTypes';

const maxSeenEventIds = 10_000;
interface ILogicalAttachment {
	readonly transportId: string;
	refCount: number;
	suspended: boolean;
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
	readonly normalizedIdOrder: string[];
	readonly normalizedByObject: WeakMap<object, IRemoteControlSessionEvent>;
	readonly syntheticIdPrefix: string;
	lastEventId: string | null;
	nextSyntheticEventId: number;
}

export class RemoteControlRegistry extends Disposable implements IRemoteControlRegistry {
	declare readonly _serviceBrand: undefined;
	private readonly attachmentEmitter = this._register(new Emitter<string>());
	readonly onDidChangeAttachments: Event<string> = this.attachmentEmitter.event;

	private readonly transports = new Map<string, IRemoteControlTransport>();
	private readonly attachmentsBySessionId = new Map<string, Map<string, ILogicalAttachment>>();
	private readonly bindingsBySessionId = new Map<string, ISessionBinding>();
	private readonly commandHandlers = new Map<string, RemoteCommandHandler>();
	private readonly trustedOrigins = new WeakSet<object>();
	private nextBindingId = 0;

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
			normalizedIdOrder: [],
			normalizedByObject: new WeakMap(),
			syntheticIdPrefix: `${session.sessionId}:remote-event:${++this.nextBindingId}`,
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
				if (!attachments.delete(transport.id)) {
					continue;
				}
				if (attachments.size === 0) {
					this.attachmentsBySessionId.delete(sessionId);
				}
				this.attachmentEmitter.fire(sessionId);
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
			if (attachment.suspended) {
				attachment.suspended = false;
				this.attachmentEmitter.fire(sessionId);
			}
		} else {
			attachment = {
				transportId,
				refCount: 1,
				suspended: false,
				replaying: false,
				replayBuffer: [],
				seenIds: new Set(),
				seenIdOrder: [],
				publishQueue: Promise.resolve(),
				lastEventId: null,
			};
			attachments.set(transportId, attachment);
			this.attachmentEmitter.fire(sessionId);
			const binding = this.bindingsBySessionId.get(sessionId);
			if (binding) {
				this.replayAttachment(sessionId, binding, attachment);
				const transport = this.transports.get(transportId)!;
				binding.session.notifyRemoteAttachment(transport.label, !!transport.requestPermission);
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
				this.attachmentEmitter.fire(sessionId);
			}
			if (currentAttachments?.size === 0) {
				this.attachmentsBySessionId.delete(sessionId);
			}
		});
	}

	/** Hides a transport from routing and UI while retaining event delivery for an in-flight turn. */
	suspendTransport(transportId: string): void {
		for (const [sessionId, attachments] of this.attachmentsBySessionId) {
			const attachment = attachments.get(transportId);
			if (!attachment || attachment.suspended) {
				continue;
			}
			attachment.suspended = true;
			this.attachmentEmitter.fire(sessionId);
		}
	}

	detachTransport(transportId: string): void {
		for (const [sessionId, attachments] of this.attachmentsBySessionId) {
			if (!attachments.delete(transportId)) {
				continue;
			}
			if (attachments.size === 0) {
				this.attachmentsBySessionId.delete(sessionId);
			}
			this.attachmentEmitter.fire(sessionId);
		}
	}

	isTransportAttached(sessionId: string, transportId?: string): boolean {
		const attachments = this.attachmentsBySessionId.get(sessionId);
		return transportId
			? attachments?.get(transportId)?.suspended === false
			: [...(attachments?.values() ?? [])].some(attachment => !attachment.suspended);
	}

	getAttachments(sessionId: string): readonly IRemoteAttachmentInfo[] {
		return [...(this.attachmentsBySessionId.get(sessionId)?.values() ?? [])]
			.filter(attachment => !attachment.suspended)
			.map(attachment => attachment.transportId)
			.map(transportId => this.transports.get(transportId))
			.filter((transport): transport is IRemoteControlTransport => !!transport)
			.map(transport => ({
				transportId: transport.id,
				label: transport.label,
				themeIcon: transport.themeIcon,
				remotePermissionResponses: !!transport.requestPermission,
			}));
	}

	getAttachedSessionIds(transportId: string): readonly string[] {
		return [...this.attachmentsBySessionId.entries()]
			.filter(([, attachments]) => attachments.get(transportId)?.suspended === false)
			.map(([sessionId]) => sessionId);
	}

	getAttachedTransportLabels(sessionId: string): readonly string[] {
		return this.getAttachments(sessionId).map(attachment => attachment.label);
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

	createTelegramOrigin(updateId: string, mode: RemoteNonElevatingMode = 'interactive'): RemoteRequestOrigin {
		if (mode !== 'interactive' && mode !== 'plan') {
			throw new Error('Telegram cannot create a permission-elevating request origin.');
		}
		const origin: RemoteRequestOrigin = Object.freeze({ kind: 'telegram', transportId: 'telegram', updateId, mode });
		this.trustedOrigins.add(origin);
		return origin;
	}

	getValidatedMissionControlMode(origin: RemoteRequestOrigin | undefined): RemoteControlMode | undefined {
		return origin && this.trustedOrigins.has(origin) && origin.kind === 'missionControl' ? origin.mode : undefined;
	}

	getValidatedRemoteMode(origin: RemoteRequestOrigin | undefined): RemoteControlMode | undefined {
		if (!origin || !this.trustedOrigins.has(origin)) {
			return undefined;
		}
		return origin.kind === 'telegram'
			? (origin.mode === 'plan' || origin.mode === 'interactive' ? origin.mode : undefined)
			: origin.mode;
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

	requestExitPlanMode(sessionId: string, request: IRemoteExitPlanModeRequest, token: CancellationToken): Promise<IRemoteExitPlanModeResponse | undefined> {
		return this.firstValidResponse(
			sessionId,
			transport => transport.requestExitPlanMode ? async childToken => sanitizeExitPlanModeResponse(request, await transport.requestExitPlanMode!(sessionId, request, childToken)) : undefined,
			token,
		);
	}

	async abort(sessionId: string): Promise<boolean> {
		const session = this.bindingsBySessionId.get(sessionId)?.session;
		if (!session) {
			return false;
		}
		await session.abort();
		return true;
	}

	private acceptLiveEvent(sessionId: string, binding: ISessionBinding, event: SessionEvent): void {
		if (this.bindingsBySessionId.get(sessionId) !== binding) {
			return;
		}
		const normalized = this.normalizeEvent(binding, event);
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
				if (isReplayableRemoteAgentEventType(event.type)) {
					this.publishToAttachment(sessionId, attachment, { ...this.normalizeEvent(binding, event), replay: true });
				}
			}
		} finally {
			attachment.replaying = false;
			for (const event of attachment.replayBuffer.splice(0)) {
				this.publishToAttachment(sessionId, attachment, event);
			}
		}
	}

	private normalizeEvent(binding: ISessionBinding, event: SessionEvent): IRemoteControlSessionEvent {
		const eventObject = event as object;
		const byObject = binding.normalizedByObject.get(eventObject);
		if (byObject) {
			return byObject;
		}

		const raw = event as { readonly id?: unknown; readonly timestamp?: unknown; readonly parentId?: unknown; readonly agentId?: unknown; readonly ephemeral?: unknown; readonly type?: unknown; readonly data?: unknown };
		const rawId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
		if (rawId) {
			const byId = binding.normalizedById.get(rawId);
			if (byId) {
				binding.normalizedByObject.set(eventObject, byId);
				return byId;
			}
		}

		const id = rawId ?? `${binding.syntheticIdPrefix}:${++binding.nextSyntheticEventId}`;
		const parentId = typeof raw.parentId === 'string' ? raw.parentId : binding.lastEventId;
		const normalized: IRemoteControlSessionEvent = {
			id,
			timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
			parentId: parentId ?? null,
			agentId: typeof raw.agentId === 'string' ? raw.agentId : undefined,
			ephemeral: typeof raw.ephemeral === 'boolean' ? raw.ephemeral : undefined,
			type: typeof raw.type === 'string' ? raw.type : 'unknown',
			data: raw.data,
		};
		binding.lastEventId = id;
		binding.normalizedById.set(id, normalized);
		binding.normalizedIdOrder.push(id);
		while (binding.normalizedIdOrder.length > maxSeenEventIds) {
			binding.normalizedById.delete(binding.normalizedIdOrder.shift()!);
		}
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
		const requests = [...(this.attachmentsBySessionId.get(sessionId)?.values() ?? [])]
			.filter(attachment => !attachment.suspended)
			.map(attachment => attachment.transportId)
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

function sanitizeExitPlanModeResponse(request: IRemoteExitPlanModeRequest, response: IRemoteExitPlanModeResponse | undefined): IRemoteExitPlanModeResponse | undefined {
	if (!response || typeof response.approved !== 'boolean') {
		return undefined;
	}
	const feedback = typeof response.feedback === 'string' ? response.feedback.trim().slice(0, 4_096) || undefined : undefined;
	if (!response.approved) {
		return { approved: false, feedback };
	}
	if ((response.selectedAction !== 'interactive' && response.selectedAction !== 'exit_only') || !request.actions.includes(response.selectedAction)) {
		return undefined;
	}
	return { approved: true, selectedAction: response.selectedAction };
}
