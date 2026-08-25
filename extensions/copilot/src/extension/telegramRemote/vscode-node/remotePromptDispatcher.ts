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
import { TELEGRAM_REMOTE_MODEL_SELECTION_PROPERTY, type TelegramModelSource } from '../common/telegramLanguageModelBridgeTypes';
import { SessionIdForCLI } from '../../chatSessions/copilotcli/common/utils';

export interface IRemotePromptDispatchResult {
	readonly accepted: true;
	readonly correlationId: string;
	readonly completion: Promise<void>;
}

export interface IPreparedRemotePromptDispatch {
	readonly correlationId: string;
	start(): IRemotePromptDispatchResult;
}

export interface IRemotePromptRequestOptions {
	readonly modelId?: string;
	readonly modelSource?: TelegramModelSource;
	readonly reasoningEffort?: string;
}

export interface IRemotePromptDispatcher {
	readonly _serviceBrand: undefined;
	prepare(sessionId: string, prompt: string, origin: RemoteRequestOrigin, options?: IRemotePromptRequestOptions): IPreparedRemotePromptDispatch;
	dispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin, options?: IRemotePromptRequestOptions): IRemotePromptDispatchResult;
}

export const IRemotePromptDispatcher = createServiceIdentifier<IRemotePromptDispatcher>('IRemotePromptDispatcher');

export class RemotePromptDispatcher implements IRemotePromptDispatcher {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	dispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin, options?: IRemotePromptRequestOptions): IRemotePromptDispatchResult {
		const correlationId = createPendingCopilotCLIRequestCorrelationId();
		return this.prepareDispatch(sessionId, prompt, origin, options, correlationId).start();
	}

	prepare(sessionId: string, prompt: string, origin: RemoteRequestOrigin, options?: IRemotePromptRequestOptions): IPreparedRemotePromptDispatch {
		return this.prepareDispatch(sessionId, prompt, origin, options, createPendingCopilotCLIRequestCorrelationId());
	}

	private prepareDispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin, options: IRemotePromptRequestOptions | undefined, correlationId: string): IPreparedRemotePromptDispatch {
		let started = false;
		return {
			correlationId,
			start: () => {
				if (started) {
					throw new Error('Remote prompt dispatch has already started.');
				}
				started = true;
				return this.startDispatch(sessionId, prompt, origin, options, correlationId);
			},
		};
	}

	private startDispatch(sessionId: string, prompt: string, origin: RemoteRequestOrigin, options: IRemotePromptRequestOptions | undefined, correlationId: string): IRemotePromptDispatchResult {
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
			const isVSCodeModel = options?.modelSource === 'vscode-lm';
			const modelConfiguration = {
				...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
				...(isVSCodeModel && options.modelId ? { [TELEGRAM_REMOTE_MODEL_SELECTION_PROPERTY]: options.modelId } : {}),
			};
			dispatched = vscode.commands.executeCommand(
				'workbench.action.chat.openSessionWithPrompt.copilotcli',
				{
					resource: SessionIdForCLI.getResource(sessionId),
					prompt,
					queue: 'steering',
					attachedContext: [marker],
					userSelectedModelId: options?.modelId && !isVSCodeModel ? `copilotcli/${options.modelId}` : undefined,
					userSelectedModelConfiguration: Object.keys(modelConfiguration).length ? modelConfiguration : undefined,
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
