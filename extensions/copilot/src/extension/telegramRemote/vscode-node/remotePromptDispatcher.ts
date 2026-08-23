/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../util/common/services';
import {
	clearPendingCopilotCLIRequestContext,
	createPendingCopilotCLIRequestCorrelationId,
	createPendingCopilotCLIRequestMarker,
	setPendingCopilotCLIRequestContext,
} from '../../chatSessions/copilotcli/common/pendingRequestContext';
import type { RemoteRequestOrigin } from '../common/remoteControlTypes';
import { SessionIdForCLI } from '../../chatSessions/copilotcli/common/utils';

export interface IRemotePromptDispatchResult {
	readonly accepted: true;
	readonly correlationId: string;
	readonly completion: Promise<void>;
}

export interface IRemotePromptDispatcher {
	readonly _serviceBrand: undefined;
	dispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin): IRemotePromptDispatchResult;
}

export const IRemotePromptDispatcher = createServiceIdentifier<IRemotePromptDispatcher>('IRemotePromptDispatcher');

export class RemotePromptDispatcher implements IRemotePromptDispatcher {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	dispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin): IRemotePromptDispatchResult {
		const correlationId = createPendingCopilotCLIRequestCorrelationId();
		const marker = createPendingCopilotCLIRequestMarker(correlationId);
		const source: `command-${string}` | undefined = origin.kind === 'missionControl'
			? `command-${origin.commandId}`
			: undefined;

		setPendingCopilotCLIRequestContext(sessionId, correlationId, {
			prompt,
			attachments: [],
			source,
			origin,
		});

		let dispatched: Thenable<unknown>;
		try {
			dispatched = vscode.commands.executeCommand(
				'workbench.action.chat.openSessionWithPrompt.copilotcli',
				{
					resource: SessionIdForCLI.getResource(sessionId),
					prompt,
					queue: 'steering',
					attachedContext: [marker],
				}
			);
		} catch (error) {
			clearPendingCopilotCLIRequestContext(sessionId, correlationId);
			this.logService.error(error, `[RemotePromptDispatcher] Failed to dispatch remote prompt for session ${sessionId}`);
			throw error;
		}

		const completion = Promise.resolve(dispatched).then(() => undefined, error => {
			clearPendingCopilotCLIRequestContext(sessionId, correlationId);
			this.logService.error(error, `[RemotePromptDispatcher] Failed to dispatch remote prompt for session ${sessionId}`);
			throw error;
		});

		return { accepted: true, correlationId, completion };
	}
}
