/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, SendOptions } from '@github/copilot/sdk';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import type { RemoteRequestOrigin } from '../../../remoteControl/common/remoteControlTypes';

export const COPILOT_CLI_PENDING_REQUEST_MARKER_ID = 'github.copilot.cli.pendingRemoteRequest';

const pendingRequestContextTtlMs = 2 * 60 * 1000;
const maxPendingRequestContexts = 256;

export interface ICopilotCLIPendingRequestContext {
	readonly prompt: string;
	readonly attachments: Attachment[];
	readonly source?: SendOptions['source'];
	readonly origin?: RemoteRequestOrigin;
}

interface IPendingEntry {
	readonly sessionId: string;
	readonly context: ICopilotCLIPendingRequestContext;
	readonly expiresAt: number;
}

export interface ICopilotCLIPendingRequestMarker {
	readonly id: typeof COPILOT_CLI_PENDING_REQUEST_MARKER_ID;
	readonly name: typeof COPILOT_CLI_PENDING_REQUEST_MARKER_ID;
	readonly value: string;
	readonly kind: 'generic';
	readonly isHidden: true;
}

const pendingRequestContextByCorrelationId = new Map<string, IPendingEntry>();

function prunePendingRequestContexts(now = Date.now()): void {
	for (const [correlationId, entry] of pendingRequestContextByCorrelationId) {
		if (entry.expiresAt <= now) {
			pendingRequestContextByCorrelationId.delete(correlationId);
		}
	}
	while (pendingRequestContextByCorrelationId.size >= maxPendingRequestContexts) {
		const oldestCorrelationId = pendingRequestContextByCorrelationId.keys().next().value as string | undefined;
		if (!oldestCorrelationId) {
			break;
		}
		pendingRequestContextByCorrelationId.delete(oldestCorrelationId);
	}
}

export function createPendingCopilotCLIRequestCorrelationId(): string {
	let correlationId: string;
	do {
		correlationId = generateUuid();
	} while (pendingRequestContextByCorrelationId.has(correlationId));
	return correlationId;
}

export function createPendingCopilotCLIRequestMarker(correlationId: string): ICopilotCLIPendingRequestMarker {
	return {
		id: COPILOT_CLI_PENDING_REQUEST_MARKER_ID,
		name: COPILOT_CLI_PENDING_REQUEST_MARKER_ID,
		value: correlationId,
		kind: 'generic',
		isHidden: true,
	};
}

export function getPendingCopilotCLIRequestCorrelationId(references: readonly { readonly id: string; readonly value: unknown }[]): string | undefined {
	const markers = references.filter(reference => reference.id === COPILOT_CLI_PENDING_REQUEST_MARKER_ID);
	return markers.length === 1 && typeof markers[0].value === 'string' && markers[0].value.length > 0
		? markers[0].value
		: undefined;
}

export function setPendingCopilotCLIRequestContext(sessionId: string, correlationId: string, context: ICopilotCLIPendingRequestContext): void {
	prunePendingRequestContexts();
	const existing = pendingRequestContextByCorrelationId.get(correlationId);
	if (existing) {
		if (existing.sessionId !== sessionId) {
			throw new Error('Pending Copilot CLI request correlation belongs to a different session.');
		}
		return;
	}
	pendingRequestContextByCorrelationId.set(correlationId, {
		sessionId,
		context,
		expiresAt: Date.now() + pendingRequestContextTtlMs,
	});
}

export function takePendingCopilotCLIRequestContext(sessionId: string, correlationId: string): ICopilotCLIPendingRequestContext | undefined {
	prunePendingRequestContexts();
	const entry = pendingRequestContextByCorrelationId.get(correlationId);
	if (!entry || entry.sessionId !== sessionId) {
		return undefined;
	}
	pendingRequestContextByCorrelationId.delete(correlationId);
	return entry.context;
}

export function clearPendingCopilotCLIRequestContext(sessionId: string, correlationId: string): void {
	const entry = pendingRequestContextByCorrelationId.get(correlationId);
	if (entry?.sessionId === sessionId) {
		pendingRequestContextByCorrelationId.delete(correlationId);
	}
}
