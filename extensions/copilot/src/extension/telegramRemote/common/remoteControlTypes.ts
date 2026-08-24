/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionEvent } from '@github/copilot/sdk';
import { createServiceIdentifier } from '../../../util/common/services';
import type { CancellationToken } from '../../../util/vs/base/common/cancellation';
import type { Event } from '../../../util/vs/base/common/event';
import type { IDisposable } from '../../../util/vs/base/common/lifecycle';
import type { IWorkspaceInfo } from '../../chatSessions/common/workspaceInfo';
import type { Session } from '../../chatSessions/copilotcli/common/utils';

export type RemoteControlMode = 'plan' | 'autopilot' | 'interactive';
export type RemoteNonElevatingMode = Exclude<RemoteControlMode, 'autopilot'>;

/**
 * Provenance attached to requests submitted by a remote-control transport.
 * Values are created and validated by {@link IRemoteControlRegistry}; callers
 * must not infer trust from the structurally visible fields alone.
 */
export type RemoteRequestOrigin =
	| {
		readonly kind: 'missionControl';
		readonly transportId: 'missionControl';
		readonly commandId: string;
		readonly mode?: RemoteControlMode;
	}
	| {
		readonly kind: 'telegram';
		readonly transportId: 'telegram';
		readonly updateId: string;
		readonly mode: RemoteNonElevatingMode;
	};

export interface IRemoteControlSessionEvent {
	readonly id: string;
	readonly timestamp: string;
	readonly parentId: string | null;
	readonly agentId?: string;
	readonly ephemeral?: boolean;
	readonly replay?: true;
	readonly type: string;
	readonly data: unknown;
}

export interface IRemoteUserInputRequest {
	readonly requestId: string;
	readonly toolCallId?: string;
	readonly question: string;
	readonly choices: readonly string[];
	readonly allowFreeform: boolean;
}

export interface IRemoteUserInputResponse {
	readonly answer: string;
	readonly wasFreeform: boolean;
}

/** Plan-exit actions that preserve the current permission level. */
export type RemoteExitPlanModeAction = 'interactive' | 'exit_only';

export interface IRemoteExitPlanModeRequest {
	readonly requestId: string;
	readonly toolCallId?: string;
	readonly summary: string;
	readonly planContent?: string;
	readonly actions: readonly RemoteExitPlanModeAction[];
	readonly recommendedAction?: RemoteExitPlanModeAction;
}

/** A remote plan decision cannot represent permission-elevating SDK fields. */
export interface IRemoteExitPlanModeResponse {
	readonly approved: boolean;
	readonly selectedAction?: RemoteExitPlanModeAction;
	readonly feedback?: string;
}

export type RemotePermissionResult = Parameters<Session['respondToPermission']>[1];

export interface IRemotePermissionDetails {
	readonly kind: string;
	readonly toolCallId?: string;
}

export interface IRemotePermissionRequest {
	readonly requestId: string;
	readonly permissionRequest: IRemotePermissionDetails;
}

/** The deliberately small bridge exposed by a live Copilot CLI wrapper. */
export interface IRemoteControlSession {
	readonly sessionId: string;
	readonly title?: string;
	readonly pendingPrompt?: string;
	readonly workspace: IWorkspaceInfo;
	readonly onDidReceiveSessionEvent: Event<SessionEvent>;
	getReplayEvents(): readonly SessionEvent[];
	abort(): Promise<void>;
	notifyRemoteAttachment(label: string, remotePermissionResponses: boolean): void;
	getCurrentMode(): string | undefined;
}

export interface IRemoteCommandOutput {
	progress(message: string): void;
	markdown(message: string): void;
	warning(message: string): void;
	button(title: string, url: string): void;
}

export interface IRemoteCommandContext {
	readonly sessionId: string;
	readonly args: string;
	readonly workspace: IWorkspaceInfo;
	readonly output: IRemoteCommandOutput;
}

export type RemoteCommandHandler = (context: IRemoteCommandContext) => Promise<void>;

/** Transport-neutral metadata rendered by native remote-control indicators. */
export interface IRemoteAttachmentInfo {
	readonly transportId: string;
	readonly label: string;
	readonly themeIcon: string;
	readonly remotePermissionResponses: boolean;
}

/** Adapter implemented by Mission Control now and Telegram in later phases. */
export interface IRemoteControlTransport extends IDisposable {
	readonly id: string;
	readonly label: string;
	readonly themeIcon: string;
	publish(sessionId: string, event: IRemoteControlSessionEvent): void | Promise<void>;
	requestPermission?(sessionId: string, request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined>;
	requestUserInput?(sessionId: string, request: IRemoteUserInputRequest, token: CancellationToken): Promise<IRemoteUserInputResponse | undefined>;
	requestExitPlanMode?(sessionId: string, request: IRemoteExitPlanModeRequest, token: CancellationToken): Promise<IRemoteExitPlanModeResponse | undefined>;
}

export interface IRemoteControlRegistry {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAttachments: Event<string>;

	bindSession(session: IRemoteControlSession): IDisposable;
	getSession(sessionId: string): IRemoteControlSession | undefined;

	registerTransport(transport: IRemoteControlTransport): IDisposable;
	attachTransport(sessionId: string, transportId: string): IDisposable;
	suspendTransport(transportId: string): void;
	detachTransport(transportId: string): void;
	isTransportAttached(sessionId: string, transportId?: string): boolean;
	getAttachments(sessionId: string): readonly IRemoteAttachmentInfo[];
	getAttachedSessionIds(transportId: string): readonly string[];
	getAttachedTransportLabels(sessionId: string): readonly string[];

	registerCommandHandler(command: string, handler: RemoteCommandHandler): IDisposable;
	handleCommand(command: string, context: IRemoteCommandContext): Promise<boolean>;

	createMissionControlOrigin(commandId: string, mode?: RemoteControlMode): RemoteRequestOrigin;
	createTelegramOrigin(updateId: string, mode?: RemoteNonElevatingMode): RemoteRequestOrigin;
	getValidatedMissionControlMode(origin: RemoteRequestOrigin | undefined): RemoteControlMode | undefined;
	getValidatedRemoteMode(origin: RemoteRequestOrigin | undefined): RemoteControlMode | undefined;

	requestPermission(sessionId: string, request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined>;
	requestUserInput(sessionId: string, request: IRemoteUserInputRequest, token: CancellationToken): Promise<IRemoteUserInputResponse | undefined>;
	requestExitPlanMode(sessionId: string, request: IRemoteExitPlanModeRequest, token: CancellationToken): Promise<IRemoteExitPlanModeResponse | undefined>;
	abort(sessionId: string): Promise<boolean>;
}

export const IRemoteControlRegistry = createServiceIdentifier<IRemoteControlRegistry>('IRemoteControlRegistry');
