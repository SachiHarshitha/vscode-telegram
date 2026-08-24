/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, SendOptions, SessionEvent, SessionOptions, ToolExecutionCompleteEvent, ToolExecutionStartEvent } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import type { ChatParticipantToolToken } from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IChatQuotaService, QuotaSnapshot, QuotaSnapshots } from '../../../../platform/chat/common/chatQuotaService';
import { getQuotaMessageForPlan } from '../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IGitService } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { GenAiMetrics } from '../../../../platform/otel/common/genAiMetrics';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName, GenAiProviderName, IOTelService, ISpanHandle, resolveWorkspaceOTelMetadata, SpanKind, SpanStatusCode, TraceContext, truncateForOTel, workspaceMetadataToOTelAttributes } from '../../../../platform/otel/common/index';
import { CapturingToken } from '../../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger, LoggedRequestKind } from '../../../../platform/requestLogger/common/requestLogger';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { PromptTokenCategory, PromptTokenLabel } from '../../../../platform/tokenizer/node/promptTokenDetails';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { raceCancellation } from '../../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Codicon } from '../../../../util/vs/base/common/codicons';
import { Emitter } from '../../../../util/vs/base/common/event';
import { createSingleCallFunction } from '../../../../util/vs/base/common/functional';
import { DisposableStore, IDisposable, toDisposable } from '../../../../util/vs/base/common/lifecycle';
import { truncate } from '../../../../util/vs/base/common/strings';
import { ThemeIcon } from '../../../../util/vs/base/common/themables';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseMarkdownPart, ChatResponseThinkingProgressPart, ChatSessionStatus, ChatToolInvocationPart, EventEmitter, Uri } from '../../../../vscodeTypes';
import { IToolsService } from '../../../tools/common/toolsService';
import { IChatSessionMetadataStore } from '../../common/chatSessionMetadataStore';
import { ExternalEditTracker } from '../../common/externalEditTracker';
import { getWorkingDirectory, isIsolationEnabled, IWorkspaceInfo } from '../../common/workspaceInfo';
import { clearTodoList, enrichToolInvocationWithSubagentMetadata, isCopilotCliEditToolCall, isCopilotCLIToolThatCouldRequirePermissions, isTodoRelatedSqlQuery, processToolExecutionComplete, processToolExecutionStart, ToolCall, updateTodoListFromSqlItems } from '../common/copilotCLITools';
import { IRemoteControlRegistry, IRemoteUserInputResponse, type RemoteExitPlanModeAction, RemoteRequestOrigin } from '../../../telegramRemote/common/remoteControlTypes';
import type { TelegramAdditionalModelRegistry } from '../../../telegramRemote/common/telegramLanguageModelBridgeTypes';
import { LocalSession, Session } from '../common/utils';
import { getCopilotCLISessionDir } from './cliHelpers';
import type { CopilotCliBridgeSpanProcessor } from './copilotCliBridgeSpanProcessor';
import { ICopilotCLIImageSupport } from './copilotCLIImageSupport';
import { handleExitPlanMode, type ExitPlanModeResponse } from './exitPlanModeHandler';
import { handleMcpPermission, handleReadPermission, handleShellPermission, handleWritePermission, type PermissionRequest, type PermissionRequestResult, showInteractivePermissionPrompt } from './permissionHelpers';
import { TodoSqlQuery } from './todoSqlQuery';
import { IQuestion, IQuestionAnswer, IUserQuestionHandler } from './userInputHelpers';

/**
 * Known commands that can be sent to a CopilotCLI session instead of a free-form prompt.
 */
export type CopilotCLICommand = 'compact' | 'plan' | 'fleet' | 'remote';

/**
 * The set of all known CopilotCLI commands.  Used by callers that need to
 * distinguish a slash-command from a regular prompt at runtime.
 */
export const copilotCLICommands: readonly CopilotCLICommand[] = ['compact', 'plan', 'fleet', 'remote'] as const;

export class CopilotCLIQuotaExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CopilotCLIQuotaExceededError';
	}
}


class CopilotCLIResponseStreamRouter {
	private _stream: vscode.ChatResponseStream | undefined;
	private readonly _routedStream: vscode.ChatResponseStream = {
		markdown: (value: string | vscode.MarkdownString): void => { this._call('markdown', [value]); },
		anchor: (value: vscode.Uri | vscode.Location, title?: string): void => { this._call('anchor', [value, title]); },
		button: (command: vscode.Command): void => { this._call('button', [command]); },
		filetree: (value: vscode.ChatResponseFileTree[], baseUri: vscode.Uri): void => { this._call('filetree', [value, baseUri]); },
		progress: (value: string, task?: (progress: vscode.Progress<vscode.ChatResponseWarningPart | vscode.ChatResponseReferencePart>) => Thenable<string | void>): void => { this._call('progress', [value, task]); },
		reference: (value: vscode.Uri | vscode.Location | { variableName: string; value?: vscode.Uri | vscode.Location }, iconPath?: vscode.Uri | vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri }): void => { this._call('reference', [value, iconPath]); },
		push: (part: vscode.ExtendedChatResponsePart): void => { this._call('push', [part]); },
		thinkingProgress: (thinkingDelta: vscode.ThinkingDelta): void => { this._call('thinkingProgress', [thinkingDelta]); },
		hookProgress: (hookType: vscode.ChatHookType, stopReason?: string, systemMessage?: string): void => { this._call('hookProgress', [hookType, stopReason, systemMessage]); },
		voiceProgress: (id: string, value: string): void => { this._call('voiceProgress', [id, value]); },
		textEdit: (target: vscode.Uri, editsOrDone: vscode.TextEdit | vscode.TextEdit[] | true): void => { this._call('textEdit', [target, editsOrDone]); },
		notebookEdit: (target: vscode.Uri, editsOrDone: vscode.NotebookEdit | vscode.NotebookEdit[] | true): void => { this._call('notebookEdit', [target, editsOrDone]); },
		workspaceEdit: (edits: vscode.ChatWorkspaceFileEdit[]): void => { this._call('workspaceEdit', [edits]); },
		externalEdit: (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>): Thenable<string> => this._call('externalEdit', [target, createSingleCallFunction(callback)]) as Thenable<string>,
		markdownWithVulnerabilities: (value: string | vscode.MarkdownString, vulnerabilities: vscode.ChatVulnerability[]): void => { this._call('markdownWithVulnerabilities', [value, vulnerabilities]); },
		codeblockUri: (uri: vscode.Uri, isEdit?: boolean): void => { this._call('codeblockUri', [uri, isEdit]); },
		confirmation: (title: string, message: string | vscode.MarkdownString, data: unknown, buttons?: string[]): void => { this._call('confirmation', [title, message, data, buttons]); },
		questionCarousel: (questions: vscode.ChatQuestion[], allowSkip?: boolean): Thenable<Record<string, unknown> | undefined> => this._call('questionCarousel', [questions, allowSkip]) as Thenable<Record<string, unknown> | undefined>,
		warning: (message: string | vscode.MarkdownString): void => { this._call('warning', [message]); },
		info: (message: string | vscode.MarkdownString): void => { this._call('info', [message]); },
		reference2: (value: vscode.Uri | vscode.Location | string | { variableName: string; value?: vscode.Uri | vscode.Location }, iconPath?: vscode.Uri | vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri }, options?: { status?: { description: string; kind: vscode.ChatResponseReferencePartStatusKind } }): void => { this._call('reference2', [value, iconPath, options]); },
		codeCitation: (value: vscode.Uri, license: string, snippet: string): void => { this._call('codeCitation', [value, license, snippet]); },
		beginToolInvocation: (toolCallId: string, toolName: string, streamData?: vscode.ChatToolInvocationStreamData & { subagentInvocationId?: string }): void => { this._call('beginToolInvocation', [toolCallId, toolName, streamData]); },
		updateToolInvocation: (toolCallId: string, streamData: vscode.ChatToolInvocationStreamData): void => { this._call('updateToolInvocation', [toolCallId, streamData]); },
		clearToPreviousToolInvocation: (reason: vscode.ChatResponseClearToPreviousToolInvocationReason): void => { this._call('clearToPreviousToolInvocation', [reason]); },
		usage: (usage: vscode.ChatResultUsage): void => { this._call('usage', [usage]); },
	};
	private static readonly _closedStreamErrorFragment = 'Response stream has been closed'.toLowerCase();

	constructor(
		private readonly _logService: ILogService,
		private readonly _sessionId: string,
	) { }

	get stream(): vscode.ChatResponseStream {
		return this._routedStream;
	}

	get hasAttachedStream(): boolean {
		return this._stream !== undefined;
	}

	attach(stream: vscode.ChatResponseStream): IDisposable {
		this._stream = stream;
		return toDisposable(() => {
			if (this._stream === stream) {
				this._stream = undefined;
			}
		});
	}

	private static _isClosedStreamError(error: unknown): boolean {
		if (!error) {
			return false;
		}
		const message = error instanceof Error ? error.message : String(error);
		return message.toLowerCase().includes(CopilotCLIResponseStreamRouter._closedStreamErrorFragment);
	}

	private _call(method: string, args: unknown[]): unknown {
		const stream = this._stream;
		if (!stream) {
			return this._fallback(method, args);
		}

		const fn = (stream as unknown as Record<string, unknown>)[method];
		if (typeof fn !== 'function') {
			return this._fallback(method, args);
		}

		try {
			const result = fn.apply(stream, args);
			if (method === 'externalEdit' || method === 'questionCarousel') {
				return Promise.resolve(result).catch(error => this._handleCallError(error, method, args, stream));
			}
			return result;
		} catch (error) {
			return this._handleCallError(error, method, args, stream);
		}
	}

	private _handleCallError(error: unknown, method: string, args: unknown[], stream: vscode.ChatResponseStream): unknown {
		if (CopilotCLIResponseStreamRouter._isClosedStreamError(error)) {
			if (this._stream === stream) {
				this._stream = undefined;
			}
			this._logService.trace(`[CopilotCLISession] Dropping ${method} for closed response stream in session ${this._sessionId}`);
			return this._fallback(method, args);
		}
		throw error;
	}

	private _fallback(method: string, args: unknown[]): unknown {
		if (method === 'externalEdit') {
			const callback = args[1];
			if (typeof callback === 'function') {
				// The callback is the caller's proceed signal; dropping it would stall the tool when only the UI stream is gone.
				return Promise.resolve().then(() => (callback as () => Thenable<unknown>)()).then(() => '');
			}
			return Promise.resolve('');
		}
		if (method === 'questionCarousel') {
			return Promise.resolve(undefined);
		}
		return undefined;
	}
}


export { builtinSlashCommands as builtinSlashSCommands } from '../../common/builtinSlashCommands';

/**
 * Either a free-form prompt **or** a known command.
 */
export type CopilotCLISessionInput =
	| { readonly prompt: string; readonly source?: SendOptions['source']; readonly origin?: RemoteRequestOrigin }
	| { readonly prompt?: string; readonly command: CopilotCLICommand; readonly source?: SendOptions['source']; readonly origin?: RemoteRequestOrigin };

function getPromptLabel(input: CopilotCLISessionInput): string {
	if ('command' in input) {
		const prompt = input.prompt ?? '';
		return prompt ? `/${input.command} ${prompt}` : `/${input.command}`;
	}
	return input.prompt;
}

function toSdkUserInputResponse(answer: IQuestionAnswer | undefined): IRemoteUserInputResponse {
	if (!answer) {
		return { answer: '', wasFreeform: false };
	}
	return answer.freeText
		? { answer: answer.freeText, wasFreeform: true }
		: { answer: answer.selected.join(', '), wasFreeform: false };
}

export interface ICopilotCLISession extends IDisposable {
	readonly sessionId: string;
	readonly title?: string;
	readonly createdPullRequestUrl: string | undefined;
	readonly onDidChangeTitle: vscode.Event<string>;
	readonly status: vscode.ChatSessionStatus | undefined;
	readonly onDidChangeStatus: vscode.Event<vscode.ChatSessionStatus | undefined>;
	readonly workspace: IWorkspaceInfo;
	readonly additionalWorkspaces: IWorkspaceInfo[];
	readonly pendingPrompt: string | undefined;
	readonly onDidReceiveSessionEvent: vscode.Event<SessionEvent>;
	attachStream(stream: vscode.ChatResponseStream): IDisposable;
	getReplayEvents(): readonly SessionEvent[];
	abort(): Promise<void>;
	notifyRemoteAttachment(label: string, remotePermissionResponses: boolean): void;
	ensureAdditionalModels(registry: TelegramAdditionalModelRegistry): void;
	getCurrentMode(): string | undefined;
	selectCustomAgent(name: string | undefined): Promise<void>;
	renameSdkSession(title: string): Promise<void>;
	updateSdkSessionSummary(title: string): Promise<void>;
	setPermissionLevel(level: string | undefined): void;
	handleRequest(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken; sessionResource?: vscode.Uri },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		model: { model: string; reasoningEffort?: string; contextTier?: 'default' | 'long_context' } | undefined,
		authInfo: NonNullable<SessionOptions['authInfo']>,
		token: vscode.CancellationToken
	): Promise<void>;
	addUserMessage(content: string): void;
	addUserAssistantMessage(content: string): void;
	getSelectedModelId(): Promise<string | undefined>;
	getLastResponseModelId(): string | undefined;
}

export class CopilotCLISession extends DisposableStore implements ICopilotCLISession {
	public readonly sessionId: string;
	private _createdPullRequestUrl: string | undefined;
	public get createdPullRequestUrl(): string | undefined {
		return this._createdPullRequestUrl;
	}
	private _status?: vscode.ChatSessionStatus;
	public get status(): vscode.ChatSessionStatus | undefined {
		return this._status;
	}
	private readonly _statusChange = this.add(new EventEmitter<vscode.ChatSessionStatus | undefined>());

	public readonly onDidChangeStatus = this._statusChange.event;

	private _title?: string;
	public get title(): string | undefined {
		return this._title;
	}
	private _onDidChangeTitle = this.add(new Emitter<string>());
	public onDidChangeTitle = this._onDidChangeTitle.event;
	private readonly _onDidReceiveSessionEvent = this.add(new Emitter<SessionEvent>());
	public readonly onDidReceiveSessionEvent = this._onDidReceiveSessionEvent.event;
	private readonly _streamRouter: CopilotCLIResponseStreamRouter;
	private readonly _stream: vscode.ChatResponseStream;
	private _toolInvocationToken?: ChatParticipantToolToken;
	public get workspace() {
		return this._workspaceInfo;
	}
	public get additionalWorkspaces() {
		return this._additionalWorkspaces;
	}
	private _lastUsedModel: string | undefined;
	private _permissionLevel: string | undefined;
	private _lastResponseModelId: string | undefined;
	private _pendingPrompt: string | undefined;
	private _bridgeProcessor: CopilotCliBridgeSpanProcessor | undefined;
	private readonly _todoSqlQuery = new TodoSqlQuery();
	private readonly _remoteAttachmentNotifications = new Set<string>();
	private _cancelPendingCancellationAbort: (() => void) | undefined;

	/** Callback to propagate trace context to the SDK's OtelLifecycle. */
	private _updateSdkTraceContext: ((traceparent?: string, tracestate?: string) => void) | undefined;
	public get pendingPrompt(): string | undefined {
		return this._pendingPrompt;
	}
	/** Set the bridge processor for forwarding SDK spans to the debug panel. */
	setBridgeProcessor(bridge: CopilotCliBridgeSpanProcessor | undefined): void {
		this._bridgeProcessor = bridge;
	}
	/** Set the SDK OTel trace context updater (pre-bound with sessionId). */
	setSdkTraceContextUpdater(updater: ((traceparent?: string, tracestate?: string) => void) | undefined): void {
		this._updateSdkTraceContext = updater;
	}
	constructor(
		private readonly _workspaceInfo: IWorkspaceInfo,
		private readonly _agentName: string | undefined,
		private readonly _sdkSession: Session,
		private readonly _additionalWorkspaces: IWorkspaceInfo[],
		private readonly _sandboxConfig: SessionOptions['sandboxConfig'],
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IChatSessionMetadataStore private readonly _chatSessionMetadataStore: IChatSessionMetadataStore,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ICopilotCLIImageSupport private readonly _imageSupport: ICopilotCLIImageSupport,
		@IToolsService private readonly _toolsService: IToolsService,
		@IUserQuestionHandler private readonly _userQuestionHandler: IUserQuestionHandler,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IOTelService private readonly _otelService: IOTelService,
		@IGitService private readonly _gitService: IGitService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IChatQuotaService private readonly _chatQuotaService: IChatQuotaService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IRemoteControlRegistry private readonly _remoteControlRegistry: IRemoteControlRegistry,
	) {
		super();
		this.sessionId = _sdkSession.sessionId;
		this._streamRouter = new CopilotCLIResponseStreamRouter(this.logService, this.sessionId);
		this._stream = this._streamRouter.stream;
		this.add(toDisposable(this._sdkSession.on('*', event => {
			this._logSessionEvent(event);
			this._onDidReceiveSessionEvent.fire(event);
		})));
		this.add(this._remoteControlRegistry.bindSession(this));
		this.add(toDisposable(() => this._todoSqlQuery.dispose()));
	}

	attachStream(stream: vscode.ChatResponseStream): IDisposable {
		return this._streamRouter.attach(stream);
	}

	getReplayEvents(): readonly SessionEvent[] {
		return [...this._sdkSession.getEvents()];
	}

	async abort(): Promise<void> {
		await this._sdkSession.abort();
	}

	notifyRemoteAttachment(label: string, remotePermissionResponses: boolean): void {
		if (!this._streamRouter.hasAttachedStream || this._remoteAttachmentNotifications.has(label)) {
			return;
		}
		this._remoteAttachmentNotifications.add(label);
		this._stream.warning(remotePermissionResponses
			? l10n.t('This session is now remotely controllable from {0}. Supported permission prompts may be answered remotely.', label)
			: l10n.t('This session is now remotely controllable from {0}. Permission prompts must be answered locally.', label));
	}

	ensureAdditionalModels(registry: TelegramAdditionalModelRegistry): void {
		const models = registry.models.filter(model => !this._sdkSession.isByokSelection(`${model.provider}/${model.id}`));
		if (models.length === 0) {
			return;
		}
		const providers = registry.providers.filter(provider => !registry.models.some(model => model.provider === provider.name && this._sdkSession.isByokSelection(`${model.provider}/${model.id}`)));
		this._sdkSession.registerByokEntries(providers, models);
		this.logService.info(`[CopilotCLISession] Registered ${models.length} additional Telegram model(s) across ${providers.length} new provider(s)`);
	}

	getCurrentMode(): string | undefined {
		return this._sdkSession.currentMode;
	}

	async selectCustomAgent(name: string | undefined): Promise<void> {
		if (name) {
			await this._sdkSession.selectCustomAgent(name);
		} else {
			this._sdkSession.clearCustomAgent();
		}
	}

	async renameSdkSession(title: string): Promise<void> {
		await (this._sdkSession as LocalSession).renameSession(title);
	}

	async updateSdkSessionSummary(title: string): Promise<void> {
		await (this._sdkSession as LocalSession).updateSessionSummary(title);
	}

	public setPermissionLevel(level: string | undefined): void {
		this._permissionLevel = level;
	}

	/** Whether the session was configured with the sandbox enabled. */
	private get _sandboxEnabled(): boolean {
		return !!this._sandboxConfig?.enabled;
	}

	/**
	 * Apply the sandbox policy for the request that is about to be sent. The
	 * configured sandbox is independent of the permission level. Pushing
	 * `{ enabled: false }` when no sandbox is configured ensures the SDK never
	 * retains a stale or auto-discovered sandbox.
	 */
	private _applyEffectiveSandboxConfig(): void {
		const base = this._sandboxConfig;
		const sandboxConfig = base?.enabled ? base : { enabled: false };
		try {
			this._sdkSession.updateOptions({ sandboxConfig });
		} catch (error) {
			this.logService.error(error, '[CopilotCLISession] Failed to update sandbox config for request');
		}
	}

	// TODO: This should be pre-populated when we restore a session based on its original context.
	// E.g. if we're resuming a session, and it tries to read a file, we shouldn't prompt for permissions again.
	/**
	 * Accumulated attachments across all requests in this session.
	 * Used for permission auto-approval: if a file was attached by the user in any
	 * request, read access is auto-approved for that file in subsequent turns.
	 */
	private readonly attachments: Attachment[] = [];
	/**
	 * Promise chain that serialises request completion tracking.
	 * When a steering request arrives while a previous request is still running,
	 * the steering handler awaits both `previousRequest` and its own SDK send so
	 * that the steering message does not resolve until the original request finishes.
	 */
	private previousRequest: Promise<unknown> = Promise.resolve();

	/**
	 * Entry point for every chat request against this session.
	 *
	 * **Steering behaviour**: if the session is already busy (`InProgress` or
	 * `NeedsInput`), the incoming message is treated as a *steering* request.
	 * Steering sends the new prompt to the SDK with `mode: 'immediate'` so it is
	 * injected into the running conversation as additional context. The steering
	 * request only resolves once *both* the steering send and the original
	 * in-flight request have completed, keeping the session's promise chain
	 * consistent.
	 *
	 * When the session is idle, a normal full request is started instead.
	 */
	public async handleRequest(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken; sessionResource?: vscode.Uri },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		model: { model: string; reasoningEffort?: string; contextTier?: 'default' | 'long_context' } | undefined,
		authInfo: NonNullable<SessionOptions['authInfo']>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.isDisposed) {
			throw new Error('Session disposed');
		}
		const label = getPromptLabel(input);
		const promptLabel = truncate(label, 50);
		const capturingToken = new CapturingToken(`Copilot CLI | ${promptLabel}`, 'worktree', undefined, undefined, this.sessionId);
		const isAlreadyBusyWithAnotherRequest = !!this._status && (this._status === ChatSessionStatus.InProgress || this._status === ChatSessionStatus.NeedsInput);
		this._toolInvocationToken = request.toolInvocationToken;

		const previousRequestSnapshot = this.previousRequest;

		const handled = this._requestLogger.captureInvocation(capturingToken, async () => {
			await this.updateModel(model?.model, model?.reasoningEffort, model?.contextTier, authInfo, token);

			if (isAlreadyBusyWithAnotherRequest) {
				return this._handleRequestSteering(input, attachments, model, previousRequestSnapshot, token);
			} else {
				return this._handleRequestImpl(request, input, attachments, model, token);
			}
		});

		this.previousRequest = this.previousRequest.then(() => handled).catch(() => { /* prevent unhandled rejection on the serialisation chain */ });
		return handled;
	}

	/**
	 * Handles a steering request - a message sent while the session is already
	 * busy with a previous request.
	 *
	 * The steering prompt is sent to the SDK with `mode: 'immediate'` (via
	 * {@link sendRequestInternal}) so the SDK injects it into the running
	 * conversation as additional user context. The SDK send itself typically
	 * completes quickly (it only enqueues the message), but we also await
	 * `previousRequestPromise` so that this method does not resolve until the
	 * original in-flight request is fully done. This ensures callers see the
	 * correct session state when the returned promise settles.
	 *
	 * @param previousRequestPromise A snapshot of `this.previousRequest` captured
	 *   *before* the promise chain was extended with the current call. Using the
	 *   snapshot avoids a circular await that would deadlock.
	 */
	private async _handleRequestSteering(
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		model: { model: string; reasoningEffort?: string; contextTier?: 'default' | 'long_context' } | undefined,
		previousRequestPromise: Promise<unknown>,
		token: vscode.CancellationToken,
	): Promise<void> {
		this.attachments.push(...attachments);
		const prompt = getPromptLabel(input);
		this._pendingPrompt = prompt;
		const disposables = new DisposableStore();
		const logStartTime = Date.now();
		disposables.add(token.onCancellationRequested(() => {
			this._cancelPendingCancellationAbort?.();
			this._sdkSession.abort();
		}));
		disposables.add(toDisposable(() => this._sdkSession.abort()));

		try {
			if ('command' in input && input.command !== 'plan') {
				this._cancelPendingCancellationAbort?.();
				await previousRequestPromise;
				if (!token.isCancellationRequested) {
					this._stream?.markdown('\n\n');
					await this.sendRequestInternal(input, attachments, false, logStartTime);
				}
			} else {
				// Send the steering prompt (completes quickly) and also wait for the
				// previous request to finish, so this promise settles only once all
				// in-flight work is done.
				await Promise.all([previousRequestPromise, this.sendRequestInternal(input, attachments, true, logStartTime)]);
			}
			this._logConversation(prompt, '', model?.model || '', attachments, logStartTime, 'Completed');
		} catch (error) {
			this._logConversation(prompt, '', model?.model || '', attachments, logStartTime, 'Failed', error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			disposables.dispose();
		}
	}

	private async _handleRequestImpl(
		request: { id: string; toolInvocationToken: ChatParticipantToolToken; sessionResource?: vscode.Uri },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		model: { model: string; reasoningEffort?: string; contextTier?: 'default' | 'long_context' } | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		const modelId = model?.model;
		const promptLabel = getPromptLabel(input);
		return this._otelService.startActiveSpan(
			'invoke_agent copilotcli',
			{
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
					[GenAiAttr.AGENT_NAME]: 'copilotcli',
					[GenAiAttr.PROVIDER_NAME]: GenAiProviderName.GITHUB,
					[GenAiAttr.CONVERSATION_ID]: this.sessionId,
					[CopilotChatAttr.SESSION_ID]: this.sessionId,
					[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
					...(modelId ? { [GenAiAttr.REQUEST_MODEL]: modelId } : {}),
					[CopilotChatAttr.USER_REQUEST]: truncateForOTel(promptLabel, this._otelService.config.maxAttributeSizeChars),
					...workspaceMetadataToOTelAttributes(resolveWorkspaceOTelMetadata(this._gitService)),
				},
			},
			async span => {
				// Emit user_message event so chronicle can extract turns and summary
				span.addEvent('user_message', { content: truncateForOTel(promptLabel, this._otelService.config.maxAttributeSizeChars) });

				// Register the trace context so the bridge processor can inject CHAT_SESSION_ID
				const traceCtx = span.getSpanContext();
				if (traceCtx && this._bridgeProcessor) {
					this._bridgeProcessor.registerTrace(traceCtx.traceId, this.sessionId);
				}
				// Propagate trace context to SDK so its spans are children of this span
				if (traceCtx && this._updateSdkTraceContext) {
					const traceparent = `00-${traceCtx.traceId}-${traceCtx.spanId}-01`;
					this._updateSdkTraceContext(traceparent);
				}
				try {
					return await this._handleRequestImplInner(span, request, input, attachments, modelId, token);
				} finally {
					if (traceCtx && this._bridgeProcessor) {
						this._bridgeProcessor.unregisterTrace(traceCtx.traceId);
					}
					// Clear SDK trace context so it doesn't leak to next request
					if (this._updateSdkTraceContext) {
						this._updateSdkTraceContext(undefined);
					}
				}
			},
		);
	}

	private async _handleRequestImplInner(
		invokeAgentSpan: ISpanHandle,
		request: { id: string; toolInvocationToken: ChatParticipantToolToken; sessionResource?: vscode.Uri },
		input: CopilotCLISessionInput,
		attachments: Attachment[],
		modelId: string | undefined,
		token: vscode.CancellationToken
	): Promise<void> {
		this.attachments.push(...attachments);
		const prompt = getPromptLabel(input);
		this._pendingPrompt = prompt;
		this._lastResponseModelId = undefined;
		this._chatQuotaService.resetTurnCredits(request.id);
		this.logService.info(`[CopilotCLISession] Invoking session ${this.sessionId}`);
		const disposables = new DisposableStore();
		const logStartTime = Date.now();
		const requestStream = this._stream;
		let wroteResponseContent = false;
		let cancelCancellationAbort: (() => void) | undefined;
		disposables.add(token.onCancellationRequested(() => {
			const cancelAbort = () => {
				clearTimeout(abortHandle);
				if (this._cancelPendingCancellationAbort === cancelAbort) {
					this._cancelPendingCancellationAbort = undefined;
				}
			};
			const abortHandle = setTimeout(() => {
				if (this._cancelPendingCancellationAbort === cancelAbort) {
					this._cancelPendingCancellationAbort = undefined;
				}
				if (!wroteResponseContent) {
					try {
						requestStream?.markdown(l10n.t('Response was interrupted.'));
						wroteResponseContent = true;
					} catch (error) {
						this.logService.trace(`[CopilotCLISession] Unable to mark interrupted response: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				this._sdkSession.abort();
			}, 250);
			this._cancelPendingCancellationAbort?.();
			this._cancelPendingCancellationAbort = cancelAbort;
			cancelCancellationAbort = cancelAbort;
		}));
		disposables.add(toDisposable(() => this._sdkSession.abort()));

		this._status = ChatSessionStatus.InProgress;
		this._statusChange.fire(this._status);


		const pendingToolInvocations = new Map<string, [ChatToolInvocationPart | ChatResponseMarkdownPart | ChatResponseThinkingProgressPart, toolData: ToolCall, parentToolCallId: string | undefined]>();

		const editToolIds = new Set<string>();
		const toolCalls = new Map<string, ToolCall>();
		const toolStartTimes = new Map<string, number>();
		// Synthesized `execute_tool` spans for native CLI tools (those that execute inside the SDK
		// and therefore never reach the tools service). MCP/VS Code tools already emit `execute_tool`
		// spans via the tools service, so we skip those here to avoid duplicate debug-log entries.
		// Synthesizing these spans is what surfaces native tool calls (e.g. powershell, grep) in the
		// chat debug logs view for the in-process Copilot CLI experience.
		const syntheticToolSpans = new Map<string, ISpanHandle>();
		// Per-model-turn usage reported by the SDK (`assistant.usage`). Used at request completion to
		// synthesize one `chat` span per turn so the chat debug logs view shows the model turns, token
		// metrics, and the agent response for the in-process Copilot CLI experience (the SDK performs
		// the model call natively and never produces a JS span we could observe directly).
		const modelTurnUsages: IModelTurnUsage[] = [];
		const invokeAgentTraceContext = invokeAgentSpan.getSpanContext();
		const editTracker = new ExternalEditTracker();
		let sdkRequestId: string | undefined;
		let isQuotaError = false;
		const toolIdEditMap = new Map<string, Promise<string | undefined>>();
		const remoteMode = this._remoteControlRegistry.getValidatedRemoteMode(input.origin);
		const effectivePermissionLevel = remoteMode ? (remoteMode === 'autopilot' ? 'autopilot' : undefined) : this._permissionLevel;
		clearTodoList(this._toolsService, request.toolInvocationToken, token).catch(err => {
			this.logService.error(err, '[CopilotCLISession] Failed to clear todo list at start of session');
		});
		/**
		 * The sequence of events from the SDK is as follows:
		 * tool.start 			-> About to run a terminal command
		 * permission request 	-> Asks user for permission to run the command
		 * tool.complete 		-> Command has completed running, contains the output or error
		 *
		 * There's a problem with this flow, we end up displaying the UI about execution in progress, even before we asked for permissions.
		 * This looks weird because we display two UI elements in sequence, one for "Running command..." and then immediately after "Permission requested: Allow running this command?".
		 * To fix this, we delay showing the "Running command..." UI until after the permission request is resolved. If the permission request is approved, we then show the "Running command..." UI. If the permission request is denied, we show a message indicating that the command was not run due to lack of permissions.
		 * & if we don't get a permission request, but get some other event, then we show the "Running command..." UI immediately as before.
		 */
		const toolCallWaitingForPermissions: [ChatToolInvocationPart, ToolCall][] = [];
		const flushPendingInvocationMessages = () => {
			for (const [invocationMessage,] of toolCallWaitingForPermissions) {
				requestStream?.push(invocationMessage);
			}
			toolCallWaitingForPermissions.length = 0;
		};
		// Flush only the tool invocation matching the given toolCallId, leaving other
		// pending tools in the array. This prevents parallel tool calls from being
		// prematurely pushed to the stream when only one of them has been approved.
		const flushPendingInvocationMessageForToolCallId = (toolCallId: string | undefined) => {
			if (!toolCallId) {
				flushPendingInvocationMessages();
				return;
			}
			const index = toolCallWaitingForPermissions.findIndex(([, tc]) => tc.toolCallId === toolCallId);
			if (index !== -1) {
				const [[invocationMessage]] = toolCallWaitingForPermissions.splice(index, 1);
				requestStream?.push(invocationMessage);
			}
		};

		const chunkMessageIds = new Set<string>();
		const assistantMessageChunks: string[] = [];
		// Tracks the `messageId` of the last assistant text we forwarded to
		// the stream (via `assistant.message_delta` or `assistant.message`).
		// When the next text emission carries a different `messageId` — i.e.
		// the model emitted a new assistant message in the same turn (e.g.
		// after a tool call, or as a second phase) — we prepend `\n\n` so the
		// two messages don't fuse into a single run-on paragraph
		// (e.g. `"...wiring:Now add..."`). Only triggers when both sides have
		// a defined messageId, so message emissions without an id (rare /
		// legacy) keep their current behavior.
		let lastEmittedAssistantMessageId: string | undefined;
		const maybeEmitMessageSeparator = (incomingMessageId: string | undefined) => {
			if (
				incomingMessageId !== undefined &&
				lastEmittedAssistantMessageId !== undefined &&
				incomingMessageId !== lastEmittedAssistantMessageId
			) {
				requestStream?.markdown('\n\n');
			}
			if (incomingMessageId !== undefined) {
				lastEmittedAssistantMessageId = incomingMessageId;
			}
		};
		let lastUsageInfo: UsageInfoData | undefined;
		const reportUsage = (promptTokens: number, completionTokens: number) => {
			if (token.isCancellationRequested || !requestStream) {
				return;
			}
			requestStream.usage({
				promptTokens,
				completionTokens,
				promptTokenDetails: buildPromptTokenDetails(lastUsageInfo),
			});
		};
		const updateUsageInfo = (async () => {
			const metrics = await this._sdkSession.usage.getMetrics();
			const promptTokens = lastUsageInfo?.currentTokens || metrics.lastCallInputTokens;
			reportUsage(promptTokens, metrics.lastCallOutputTokens);
		})();
		try {
			const shouldHandleExitPlanModeRequests = this.configurationService.getConfig(ConfigKey.Advanced.CLIPlanExitModeEnabled);
			disposables.add(toDisposable(this._sdkSession.on('permission.requested', async (event) => {
				const permissionRequest = event.data.permissionRequest;
				const requestId = event.data.requestId;

				const isSandboxBypassShell = permissionRequest.kind === 'shell' && permissionRequest.requestSandboxBypass === true;

				// Auto-approve all requests when the permission level allows it.
				if (!isSandboxBypassShell && (effectivePermissionLevel === 'autoApprove' || effectivePermissionLevel === 'autopilot')) {
					this.logService.trace(`[CopilotCLISession] Auto Approving ${permissionRequest.kind} request (permission level: ${effectivePermissionLevel})`);
					this._sdkSession.respondToPermission(requestId, { kind: 'approve-once' });
					return;
				}

				if (!isSandboxBypassShell && permissionRequest.kind === 'shell' && this._sandboxEnabled) {
					this.logService.trace(`[CopilotCLISession] Auto Approving shell request (sandbox is enabled)`);
					this._sdkSession.respondToPermission(requestId, { kind: 'approve-once' });
					return;
				}

				// Resolve tool call data for the permission request.
				const toolData = permissionRequest.toolCallId ? toolCalls.get(permissionRequest.toolCallId) : undefined;
				const pendingData = permissionRequest.toolCallId ? pendingToolInvocations.get(permissionRequest.toolCallId) : undefined;
				const toolParentCallId = pendingData ? pendingData[2] : undefined;
				const toolInvocationToken = this._toolInvocationToken as unknown as never;
				const resolveLocalPermissionResponse = (permissionToken: CancellationToken): Promise<PermissionRequestResult> => {
					switch (permissionRequest.kind) {
						case 'read':
							return handleReadPermission(
								this.sessionId, permissionRequest, toolParentCallId,
								this.attachments, this._imageSupport, this.workspace, this.workspaceService,
								this._toolsService, toolInvocationToken, this.logService, permissionToken,
							);
						case 'write':
							return handleWritePermission(
								this.sessionId, permissionRequest, toolData, toolParentCallId,
								requestStream, editTracker, this.workspace, this.workspaceService,
								this.instantiationService, this._toolsService, toolInvocationToken, this.logService, permissionToken,
							);
						case 'shell':
							return handleShellPermission(
								permissionRequest, toolParentCallId,
								this.workspace, this._toolsService, toolInvocationToken, this.logService, permissionToken,
							);
						case 'mcp':
							return handleMcpPermission(
								permissionRequest, toolParentCallId,
								this._toolsService, toolInvocationToken, this.logService, permissionToken,
							);
						default:
							return showInteractivePermissionPrompt(
								permissionRequest, toolParentCallId,
								this._toolsService, toolInvocationToken, this.logService, permissionToken,
							);
					}
				};

				try {
					let response: PermissionRequestResult;
					if (!isSandboxBypassShell && (effectivePermissionLevel === 'autoApprove' || effectivePermissionLevel === 'autopilot')) {
						this.logService.trace(`[CopilotCLISession] Auto Approving ${permissionRequest.kind} request (permission level: ${effectivePermissionLevel})`);
						response = { kind: 'approve-once' };
					} else if (this._remoteControlRegistry.isTransportAttached(this.sessionId)) {
						const permissionResolutionTokenSource = new CancellationTokenSource(token);
						try {
							response = (await Promise.race([
								resolveLocalPermissionResponse(permissionResolutionTokenSource.token),
								this._remoteControlRegistry.requestPermission(this.sessionId, { permissionRequest, requestId }, permissionResolutionTokenSource.token),
							])) ?? { kind: 'denied-interactively-by-user' };
						} finally {
							permissionResolutionTokenSource.dispose(true);
						}
					} else {
						response = await resolveLocalPermissionResponse(token);
					}

					flushPendingInvocationMessageForToolCallId(permissionRequest.toolCallId);

					this._requestLogger.addEntry({
						type: LoggedRequestKind.MarkdownContentRequest,
						debugName: `Permission Request`,
						startTimeMs: Date.now(),
						icon: Codicon.question,
						markdownContent: this._renderPermissionToMarkdown(permissionRequest, response.kind),
						isConversationRequest: true
					});

					this._sdkSession.respondToPermission(requestId, response);
				}
				catch (error) {
					this.logService.error(error, `[CopilotCLISession] Error handling permission request of kind ${permissionRequest.kind}`);
					flushPendingInvocationMessageForToolCallId(permissionRequest.toolCallId);
					this._sdkSession.respondToPermission(requestId, { kind: 'denied-interactively-by-user' });
				}
			})));
			if (shouldHandleExitPlanModeRequests) {
				disposables.add(toDisposable(this._sdkSession.on('exit_plan_mode.requested', async (event) => {
					let response: ExitPlanModeResponse = { approved: false };
					try {
						this.updateArtifacts();
						const resolveLocalPlanResponse = (resolutionToken: CancellationToken) => handleExitPlanMode(
							event.data,
							this._sdkSession,
							effectivePermissionLevel,
							this._toolInvocationToken,
							this.workspaceService,
							this.logService,
							this._toolsService,
							resolutionToken,
						);
						if (effectivePermissionLevel !== 'autopilot' && this._remoteControlRegistry.isTransportAttached(this.sessionId)) {
							const planResolutionTokenSource = new CancellationTokenSource(token);
							const eventData = event.data as typeof event.data & { readonly toolCallId?: string };
							const actions = eventData.actions.filter((action): action is RemoteExitPlanModeAction => action === 'interactive' || action === 'exit_only');
							try {
								response = (await Promise.race([
									resolveLocalPlanResponse(planResolutionTokenSource.token),
									this._remoteControlRegistry.requestExitPlanMode(this.sessionId, {
										requestId: eventData.requestId,
										toolCallId: eventData.toolCallId,
										summary: eventData.summary,
										planContent: eventData.planContent,
										actions,
										recommendedAction: actions.includes(eventData.recommendedAction as RemoteExitPlanModeAction) ? eventData.recommendedAction as RemoteExitPlanModeAction : undefined,
									}, planResolutionTokenSource.token),
								])) ?? { approved: false };
							} finally {
								planResolutionTokenSource.dispose(true);
							}
						} else {
							response = await resolveLocalPlanResponse(token);
						}
						flushPendingInvocationMessages();
					} catch (error) {
						this.logService.error(error, '[CopilotCLISession] Error handling exit plan mode');
					}
					try {
						this._sdkSession.respondToExitPlanMode(event.data.requestId, response);
					} catch (error) {
						this.logService.error(error, '[CopilotCLISession] Failed to send exit plan mode response');
					}
				})));
			}
			disposables.add(toDisposable(this._sdkSession.on('user_input.requested', async (event) => {
				if (!(this._toolInvocationToken as unknown)) {
					this.logService.warn('[AskQuestionsTool] No tool invocation token available, cannot show question carousel');
					this._sdkSession.respondToUserInput(event.data.requestId, { answer: '', wasFreeform: false });
					return;
				}
				const userInputRequest: IQuestion = {
					question: event.data.question,
					options: (event.data.choices ?? []).map(c => ({ label: c })),
					allowFreeformInput: event.data.allowFreeform,
					header: event.data.question,
				};
				let response: IRemoteUserInputResponse;
				if (this._remoteControlRegistry.isTransportAttached(this.sessionId)) {
					const userInputResolutionTokenSource = new CancellationTokenSource(token);
					const localQuestionPromise = this._userQuestionHandler.askUserQuestion(userInputRequest, this._toolInvocationToken as unknown as never, userInputResolutionTokenSource.token, event.data.toolCallId);
					const remoteQuestionPromise = this._remoteControlRegistry.requestUserInput(this.sessionId, {
						requestId: event.data.requestId,
						toolCallId: event.data.toolCallId,
						question: event.data.question,
						choices: event.data.choices ?? [],
						allowFreeform: event.data.allowFreeform ?? false,
					}, userInputResolutionTokenSource.token);
					try {
						const result = await Promise.race([
							localQuestionPromise.then(answer => ({ source: 'local' as const, response: toSdkUserInputResponse(answer) })),
							remoteQuestionPromise.then(result => ({ source: 'remote' as const, response: result })),
						]);
						if (result.source === 'remote' && result.response && event.data.toolCallId) {
							await this._userQuestionHandler.notifyQuestionCarouselAnswer?.(event.data.toolCallId, userInputRequest, result.response);
						}
						response = result.response ?? { answer: '', wasFreeform: false };
					} finally {
						userInputResolutionTokenSource.dispose(true);
					}
				} else {
					response = toSdkUserInputResponse(await this._userQuestionHandler.askUserQuestion(userInputRequest, this._toolInvocationToken as unknown as never, token, event.data.toolCallId));
				}
				flushPendingInvocationMessages();
				this._sdkSession.respondToUserInput(event.data.requestId, response);
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.title_changed', (event) => {
				this._title = event.data.title;
				this._onDidChangeTitle.fire(event.data.title);
			})));
			disposables.add(toDisposable(this._sdkSession.on('user.message', (event) => {
				sdkRequestId = sdkRequestId ?? event.id;
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.usage', (event) => {
				this._lastResponseModelId = event.data.model;
				if (requestStream && typeof event.data.outputTokens === 'number' && typeof event.data.inputTokens === 'number') {
					reportUsage(event.data.inputTokens, event.data.outputTokens);
				}
				// Accumulate per-turn credits from SDK copilotUsage data
				const copilotUsage = (event.data as unknown as Record<string, unknown>).copilotUsage;
				let copilotUsageNanoAiu: number | undefined;
				if (copilotUsage && typeof copilotUsage === 'object') {
					const { totalNanoAiu } = copilotUsage as { totalNanoAiu?: number };
					if (typeof totalNanoAiu === 'number') {
						copilotUsageNanoAiu = totalNanoAiu;
						this._chatQuotaService.setLastCopilotUsage(totalNanoAiu, request.id);
					}
				}
				// Sync the live per-category quota state the SDK reports (internal-only field) so the
				// quota UI stays current without a separate `copilot_internal/user` fetch. This mirrors
				// the extension-host chat path, which processes `copilot_quota_snapshots` from CAPI.
				if (event.data.quotaSnapshots) {
					this._chatQuotaService.processQuotaSnapshots(toChatQuotaSnapshots(event.data.quotaSnapshots));
				}
				// Record this model turn so we can synthesize a `chat` span for it at request completion.
				modelTurnUsages.push({
					model: event.data.model,
					inputTokens: event.data.inputTokens,
					outputTokens: event.data.outputTokens,
					cacheReadTokens: event.data.cacheReadTokens,
					copilotUsageNanoAiu,
					parentToolCallId: event.data.parentToolCallId,
				});
			})));
			disposables.add(toDisposable(this._sdkSession.on('session.usage_info', (event) => {
				lastUsageInfo = {
					currentTokens: event.data.currentTokens,
					systemTokens: event.data.systemTokens,
					conversationTokens: event.data.conversationTokens,
					toolDefinitionsTokens: event.data.toolDefinitionsTokens,
					tokenLimit: event.data.tokenLimit,
				};
				reportUsage(lastUsageInfo.currentTokens, 0);
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message_delta', (event) => {
				// Support for streaming delta messages.
				if (typeof event.data.deltaContent === 'string' && event.data.deltaContent.length) {
					// Ensure pending invocation messages are flushed even if we skip sub-agent markdown
					flushPendingInvocationMessages();
					// Skip sub-agent markdown — it will be captured in the subagent tool's result
					if (event.data.parentToolCallId) {
						return;
					}
					maybeEmitMessageSeparator(event.data.messageId);
					chunkMessageIds.add(event.data.messageId);
					assistantMessageChunks.push(event.data.deltaContent);
					wroteResponseContent = true;
					requestStream?.markdown(event.data.deltaContent);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('assistant.message', (event) => {
				if (typeof event.data.content === 'string' && event.data.content.length && !chunkMessageIds.has(event.data.messageId)) {
					// Skip sub-agent markdown — it will be captured in the subagent tool's result
					if (event.data.parentToolCallId) {
						return;
					}
					assistantMessageChunks.push(event.data.content);
					flushPendingInvocationMessages();
					maybeEmitMessageSeparator(event.data.messageId);
					wroteResponseContent = true;
					requestStream?.markdown(event.data.content);
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_start', (event) => {
				toolCalls.set(event.data.toolCallId, event.data as unknown as ToolCall);
				toolStartTimes.set(event.data.toolCallId, Date.now());

				// Only synthesize tool spans when the bridge is absent. If a future SDK registers its own
				// JS OTel provider the bridge forwards native tool spans, and synthesizing would duplicate them.
				if (!this._bridgeProcessor) {
					this._startSyntheticToolSpan(event, syntheticToolSpans, invokeAgentTraceContext);
				}

				if (isCopilotCliEditToolCall(event.data)) {
					flushPendingInvocationMessages();
					editToolIds.add(event.data.toolCallId);
				} else {
					const responsePart = processToolExecutionStart(event, pendingToolInvocations, getWorkingDirectory(this.workspace));
					if (responsePart instanceof ChatResponseThinkingProgressPart) {
						flushPendingInvocationMessages();
						wroteResponseContent = true;
						requestStream?.push(responsePart);
						requestStream?.push(new ChatResponseThinkingProgressPart('', '', { vscodeReasoningDone: true }));
					} else if (responsePart instanceof ChatResponseMarkdownPart) {
						// Wait for completion to push into stream.
					} else if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;

						if (isCopilotCLIToolThatCouldRequirePermissions(event)) {
							toolCallWaitingForPermissions.push([responsePart, event.data as ToolCall]);
						} else {
							flushPendingInvocationMessages();
							wroteResponseContent = true;
							requestStream?.push(responsePart);
						}
					}
				}
			})));
			disposables.add(toDisposable(this._sdkSession.on('tool.execution_complete', (event) => {
				const toolCall = toolCalls.get(event.data.toolCallId);
				const toolName = toolCall?.toolName || '<unknown>';
				if (toolName.endsWith('create_pull_request') && event.data.success) {
					const pullRequestUrl = extractPullRequestUrlFromToolResult(event.data.result);
					if (pullRequestUrl) {
						this._createdPullRequestUrl = pullRequestUrl;
						GenAiMetrics.incrementPullRequestCount(this._otelService);
					}
				}
				// Emit `languageModelToolInvoked` to mirror the workbench LanguageModelToolsService event
				// for the Copilot CLI agent. CLI tools execute inside the SDK and never reach
				// LanguageModelToolsService, so the workbench-side emission does not fire for them.
				this._sendToolInvokedTelemetry(event, toolCall, toolStartTimes, request.sessionResource);

				// Log tool call to request logger
				const eventError = event.data.error ? { ...event.data.error, code: event.data.error.code || '' } : undefined;
				const eventData = { ...event.data, error: eventError };
				this._logToolCall(event.data.toolCallId, toolName, toolCall?.arguments, eventData);

				// Complete the synthesized `execute_tool` span (native CLI tools only).
				this._endSyntheticToolSpan(event, syntheticToolSpans);

				// Mark the end of the edit if this was an edit tool.
				toolIdEditMap.set(event.data.toolCallId, editTracker.completeEdit(event.data.toolCallId));
				if (editToolIds.has(event.data.toolCallId)) {
					return;
				}

				// Just complete the tool invocation - the part was already pushed with partial updates enabled
				const [responsePart,] = processToolExecutionComplete(event, pendingToolInvocations, this.logService, getWorkingDirectory(this.workspace)) ?? [];
				if (responsePart) {
					flushPendingInvocationMessageForToolCallId(event.data.toolCallId);
					if (responsePart instanceof ChatToolInvocationPart) {
						responsePart.enablePartialUpdate = true;
					}
					wroteResponseContent = true;
					requestStream?.push(responsePart);
				}

				// When a sql tool execution completes that modifies the todos table,
				// query the session database and update the todo list widget.
				if (toolName === 'sql' && event.data.success) {
					try {
						const query = (toolCall?.arguments as { query?: string } | undefined)?.query ?? '';
						if (isTodoRelatedSqlQuery(query)) {
							const sessionDir = getCopilotCLISessionDir(this.sessionId);
							this._todoSqlQuery.queryTodos(sessionDir).then(items => {
								if (token.isCancellationRequested) {
									return;
								}
								return updateTodoListFromSqlItems(items, this._toolsService, request.toolInvocationToken, token);
							}).catch(err => {
								this.logService.error(err, '[CopilotCLISession] Failed to query todos from session database');
							});
						}
					} catch (ex) {
						this.logService.error(ex, `[CopilotCLISession] Failed to process completed sql tool call for todos`);
					}
				}

			})));
			disposables.add(toDisposable(this._sdkSession.on('session.error', (event) => {
				flushPendingInvocationMessages();
				this.logService.error(`[CopilotCLISession]CopilotCLI error: (${event.data.errorType}), ${event.data.message}`);

				if (event.data.errorType === 'quota' || event.data.statusCode === 402) {
					isQuotaError = true;
				} else {
					requestStream?.markdown(l10n.t('\n\nError: ({0}) {1}', event.data.errorType, event.data.message));
				}

				const errorMarkdown = [`# Error Details`, `Type: ${event.data.errorType}`, `Message: ${event.data.message}`, `## Stack`, event.data.stack || ''].join('\n');
				this._requestLogger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: `Session Error`,
					startTimeMs: Date.now(),
					icon: Codicon.error,
					markdownContent: errorMarkdown,
					isConversationRequest: true
				});
			})));
			disposables.add(toDisposable(this._sdkSession.on('subagent.started', (event) => {
				enrichToolInvocationWithSubagentMetadata(
					event.data.toolCallId,
					event.data.agentDisplayName,
					event.data.agentDescription,
					pendingToolInvocations
				);
			})));
			disposables.add(toDisposable(this._sdkSession.on('subagent.failed', (event) => {
				this.logService.trace(`[CopilotCLISession] Subagent failed: ${event.data.agentDisplayName} (toolCallId: ${event.data.toolCallId})`);
			})));
			// Stash hook event data on the bridge processor so SDK hook spans
			// are enriched with input/output details for the debug panel.
			disposables.add(toDisposable(this._sdkSession.on('hook.start', (event) => {
				this.logService.trace(`[CopilotCLISession] Hook ${event.data.hookType} started (${event.data.hookInvocationId})`);
				let input: string | undefined;
				try {
					input = truncateForOTel(JSON.stringify(event.data.input), this._otelService.config.maxAttributeSizeChars);
				} catch { /* swallow serialization errors */ }
				this._bridgeProcessor?.stashHookInput(event.data.hookInvocationId, event.data.hookType, input);
			})));
			disposables.add(toDisposable(this._sdkSession.on('hook.end', (event) => {
				this.logService.trace(`[CopilotCLISession] Hook ${event.data.hookType} ended (${event.data.hookInvocationId}), success=${event.data.success}`);
				const resultKind = event.data.success ? 'success' as const : 'error' as const;
				let output: string | undefined;
				if (event.data.success) {
					try {
						output = truncateForOTel(JSON.stringify(event.data.output), this._otelService.config.maxAttributeSizeChars);
					} catch { /* swallow serialization errors */ }
				}
				this._bridgeProcessor?.stashHookEnd(
					event.data.hookInvocationId,
					event.data.hookType,
					output,
					resultKind,
					event.data.error?.message,
				);
			})));

			if (!token.isCancellationRequested) {
				await this.sendRequestInternal(input, attachments, false, logStartTime);
			}
			if (isQuotaError) {
				this._chatQuotaService.clearQuota();
				let plan: string | undefined;
				let isUsageBasedBilling: boolean | undefined;
				let quotaResetDate: string | undefined;
				try {
					const copilotToken = await this._authenticationService.getCopilotToken();
					plan = copilotToken.copilotPlan;
					isUsageBasedBilling = copilotToken.tokenBasedBilling;
					quotaResetDate = copilotToken.quotaInfo.quota_reset_date;
				} catch { /* token unavailable */ }
				throw new CopilotCLIQuotaExceededError(getQuotaMessageForPlan(plan, isUsageBasedBilling, quotaResetDate));
			}
			this.logService.trace(`[CopilotCLISession] Invoking session (completed) ${this.sessionId}`);
			const resolvedToolIdEditMap: Record<string, string> = {};
			await Promise.all(Array.from(toolIdEditMap.entries()).map(async ([toolId, editFilePromise]) => {
				const editId = await editFilePromise.catch(() => undefined);
				if (editId) {
					resolvedToolIdEditMap[toolId] = editId;
				}
			}));
			if (sdkRequestId) {
				await this._chatSessionMetadataStore.updateRequestDetails(this.sessionId, [{
					vscodeRequestId: request.id,
					copilotRequestId: sdkRequestId,
					toolIdEditMap: resolvedToolIdEditMap,
					agentId: this._agentName,
				}]).catch(error => {
					this.logService.error(`[CopilotCLISession] Failed to update chat session metadata store for request ${request.id}`, error);
				});
			}
			await updateUsageInfo.catch(error => {
				this.logService.error(`[CopilotCLISession] Failed to update usage info after request ${request.id}`, error);
			});
			this._status = ChatSessionStatus.Completed;
			this._statusChange.fire(this._status);

			// Log the completed conversation
			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Completed');
		} catch (error) {
			if (error instanceof CopilotCLIQuotaExceededError) {
				throw error;
			}
			if (isQuotaError) {
				this._chatQuotaService.clearQuota();
				let plan: string | undefined;
				let isUsageBasedBilling: boolean | undefined;
				let quotaResetDate: string | undefined;
				try {
					const copilotToken = await this._authenticationService.getCopilotToken();
					plan = copilotToken.copilotPlan;
					isUsageBasedBilling = copilotToken.tokenBasedBilling;
					quotaResetDate = copilotToken.quotaInfo.quota_reset_date;
				} catch { /* token unavailable */ }
				throw new CopilotCLIQuotaExceededError(getQuotaMessageForPlan(plan, isUsageBasedBilling, quotaResetDate));
			}
			this._status = ChatSessionStatus.Failed;
			this._statusChange.fire(this._status);
			this.logService.error(`[CopilotCLISession] Invoking session (error) ${this.sessionId}`, error);

			const errorMessage = error instanceof Error ? error.message : String(error);
			requestStream?.markdown(l10n.t('\n\nError: {0}', errorMessage));

			invokeAgentSpan.setStatus(SpanStatusCode.ERROR, errorMessage);
			if (error instanceof Error) {
				invokeAgentSpan.recordException(error);
			}

			// Log the failed conversation
			this._logConversation(prompt, assistantMessageChunks.join(''), modelId || '', attachments, logStartTime, 'Failed', errorMessage);
		} finally {
			cancelCancellationAbort?.();

			// Synthesize a `chat` span per model turn so the chat debug logs view shows the model
			// turns, token metrics, and the agent response for the in-process Copilot CLI experience,
			// where the model calls happen inside the SDK and never produce JS spans. Skip when the bridge
			// is installed (a future SDK with its own JS provider), since it forwards the native chat spans.
			if (!this._bridgeProcessor) {
				this._injectModelTurnSpans(modelTurnUsages, assistantMessageChunks.join(''), this._lastResponseModelId ?? modelId, invokeAgentTraceContext);
			}

			// End any synthesized tool spans that never received a completion event (e.g. on abort)
			// so they don't leak.
			for (const toolSpan of syntheticToolSpans.values()) {
				toolSpan.setStatus(SpanStatusCode.ERROR, 'incomplete');
				toolSpan.end();
			}
			syntheticToolSpans.clear();

			// End the invoke_agent wrapper span
			const durationSec = (Date.now() - logStartTime) / 1000;
			invokeAgentSpan.setAttribute('copilot_chat.duration_sec', durationSec);
			invokeAgentSpan.end();

			this._pendingPrompt = undefined;
			disposables.dispose();

			this.updateArtifacts();
		}
	}

	private async updateModel(modelId: string | undefined, reasoningEffort: string | undefined, contextTier: 'default' | 'long_context' | undefined, authInfo: NonNullable<SessionOptions['authInfo']>, token: CancellationToken): Promise<void> {
		// Where possible try to avoid an extra call to getSelectedModel by using cached value.
		let currentModel: string | undefined = undefined;
		if (modelId) {
			if (this._lastUsedModel) {
				currentModel = this._lastUsedModel;
			} else {
				currentModel = await raceCancellation(this._sdkSession.getSelectedModel(), token);
			}
		}
		if (token.isCancellationRequested) {
			return;
		}
		const optionsUpdate: Record<string, unknown> = {};
		if (authInfo) {
			optionsUpdate.authInfo = authInfo;
		}
		if (contextTier) {
			optionsUpdate.contextTier = contextTier;
		}
		if (Object.keys(optionsUpdate).length > 0) {
			this._sdkSession.updateOptions(optionsUpdate);
		}
		if (modelId) {
			if (modelId !== currentModel) {
				this._lastUsedModel = modelId;
				if (this.configurationService.getConfig(ConfigKey.Advanced.CLIThinkingEffortEnabled)) {
					await raceCancellation(this._sdkSession.setSelectedModel(modelId, reasoningEffort), token);
				} else {
					await raceCancellation(this._sdkSession.setSelectedModel(modelId), token);
				}
			} else if (reasoningEffort && this._sdkSession.getReasoningEffort() !== reasoningEffort && this.configurationService.getConfig(ConfigKey.Advanced.CLIThinkingEffortEnabled)) {
				await raceCancellation(this._sdkSession.setSelectedModel(modelId, reasoningEffort), token);
			}
		}
	}

	private updateArtifacts() {
		const shouldHandleExitPlanModeRequests = this.configurationService.getConfig(ConfigKey.Advanced.CLIPlanExitModeEnabled);

		if (!shouldHandleExitPlanModeRequests || !this._toolsService.getTool('setArtifacts') || !this._toolInvocationToken) {
			return;
		}

		const artifacts: { label: string; uri: string; type: 'devServer' | 'screenshot' | 'plan' }[] = [];
		const planPath = this._sdkSession.getPlanPath();
		if (planPath) {
			artifacts.push({ label: l10n.t('Plan'), uri: Uri.file(planPath).toString(), type: 'plan' });
		}
		Promise.resolve(this._toolsService
			.invokeTool('setArtifacts', { input: { artifacts }, toolInvocationToken: this._toolInvocationToken }, CancellationToken.None))
			.catch(error => {
				this.logService.error(error, '[CopilotCLISession] Failed to update artifacts');
			});
	}
	/**
	 * Sends a request to the underlying SDK session.
	 *
	 * @param steering When `true`, the SDK send uses `mode: 'immediate'` so the
	 *   prompt is injected into the already-running conversation rather than
	 *   starting a new turn. This is the mechanism behind session steering.
	 */
	private async sendRequestInternal(input: CopilotCLISessionInput, attachments: Attachment[], steering = false, logStartTime: number): Promise<void> {
		const prompt = getPromptLabel(input);
		this._logRequest(prompt, this._lastUsedModel || '', attachments, logStartTime);

		if ('command' in input && input.command !== 'plan') {
			switch (input.command) {
				case 'compact': {
					this._stream?.progress(l10n.t('Compacting conversation...'));
					await this._sdkSession.initializeAndValidateTools();
					this._sdkSession.currentMode = 'interactive';
					const result = await this._sdkSession.compactHistory();
					if (result.success) {
						this._stream?.markdown(l10n.t('Compacted conversation.'));
					} else {
						this._stream?.markdown(l10n.t('Unable to compact conversation.'));
					}
					break;
				}
				case 'fleet': {
					await this._startFleetAndWaitForIdle(input);
					break;
				}
				case 'remote': {
					const handled = await this._remoteControlRegistry.handleCommand('remote', {
						sessionId: this.sessionId,
						args: input.prompt ?? '',
						workspace: this.workspace,
						output: {
							progress: message => this._stream.progress(message),
							markdown: message => this._stream.markdown(message),
							warning: message => this._stream.warning(message),
							button: (title, url) => this._stream.button({ command: 'vscode.open', arguments: [Uri.parse(url)], title }),
						},
					});
					if (!handled) {
						this._stream.warning(l10n.t('No remote-control transport is available.'));
					}
					break;
				}
			}
		} else {
			const remoteMode = this._remoteControlRegistry.getValidatedRemoteMode(input.origin);
			if (remoteMode) {
				this._sdkSession.currentMode = remoteMode;
			} else if ('command' in input && input.command === 'plan') {
				this._sdkSession.currentMode = 'plan';
			} else if (this._permissionLevel === 'autopilot') {
				this._sdkSession.currentMode = 'autopilot';
			} else {
				this._sdkSession.currentMode = 'interactive';
			}
			this._applyEffectiveSandboxConfig();
			const sendOptions: SendOptions = { prompt: input.prompt ?? '', attachments, agentMode: this._sdkSession.currentMode };
			if (steering) {
				sendOptions.mode = 'immediate';
			}
			if (input.source) {
				sendOptions.source = input.source;
			}
			await this._sdkSession.send(sendOptions);

			try {
				const localSession = this._sdkSession as LocalSession;
				if (localSession.waitForPendingBackgroundTasks) {
					await localSession.waitForPendingBackgroundTasks();
				}
			}
			catch (error) {
				this.logService.error(error, '[CopilotCLISession] Error while waiting for pending background tasks');
				// Don't fail the whole request if waiting for background tasks fails, as it's not critical to the main flow.
				// Just log the error and continue.
			}
		}
	}

	private async _startFleetAndWaitForIdle(input: CopilotCLISessionInput): Promise<void> {
		const prompt = 'prompt' in input ? input.prompt : undefined;
		try {
			const promise = new Promise<void>((resolve) => {
				const off = this._sdkSession.on('session.idle', () => {
					resolve();
					off();
				});
			});
			if (this._permissionLevel === 'autopilot') {
				this._sdkSession.currentMode = 'autopilot';
			} else {
				this._sdkSession.currentMode = 'interactive';
			}
			this._applyEffectiveSandboxConfig();
			const result = await this._sdkSession.fleet.start({ prompt });
			if (!result.started) {
				this.logService.info('[CopilotCLISession] Fleet mode not started');
				return;
			}
			await promise;
		} catch (error) {
			this.logService.error(`[CopilotCLISession] Fleet error: ${error}`);
		}
	}


	private _logSessionEvent(event: { type?: string; data?: unknown }): void {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLISessionEventLoggingEnabled)) {
			return;
		}
		const type = event.type;
		if (!type) {
			return;
		}
		// Tool/permission/assistant event payloads are heterogeneous unions in the
		// SDK; access fields through a loose record cast so this helper can be
		// shape-agnostic.
		const data = (event.data ?? {}) as Record<string, unknown>;
		const get = (...keys: string[]): unknown => {
			for (const key of keys) {
				const value = data[key];
				if (value !== undefined) {
					return value;
				}
			}
			return undefined;
		};
		const getNested = (key: string, sub: string): unknown => {
			const value = data[key];
			return value && typeof value === 'object' ? (value as Record<string, unknown>)[sub] : undefined;
		};
		try {
			switch (type) {
				case 'tool.execution_started': {
					const name = getNested('toolDescription', 'name') ?? get('toolName') ?? 'unknown';
					const input = truncateForLog(JSON.stringify(get('input', 'arguments') ?? {}));
					this.logService.info(`[CopilotCLISession] tool.execution_started ${name} input=${input}`);
					break;
				}
				case 'tool.execution_complete': {
					const name = getNested('toolDescription', 'name') ?? get('toolName', 'toolCallId') ?? 'unknown';
					const success = get('success');
					const sandboxed = get('sandboxed');
					const result = data.result as Record<string, unknown> | undefined;
					const content = truncateForLog(typeof result?.content === 'string' ? result.content : '');
					const rawError = data.error;
					const errorMessage = typeof rawError === 'string'
						? rawError
						: rawError && typeof rawError === 'object' && typeof (rawError as Record<string, unknown>).message === 'string'
							? (rawError as { message: string }).message
							: undefined;
					if (errorMessage) {
						this.logService.warn(`[CopilotCLISession] tool.execution_complete ${name} success=${success} sandboxed=${sandboxed} error=${errorMessage} content=${content}`);
					} else {
						this.logService.info(`[CopilotCLISession] tool.execution_complete ${name} success=${success} sandboxed=${sandboxed} content=${content}`);
					}
					break;
				}
				case 'permission.requested': {
					const kind = getNested('permissionRequest', 'kind');
					this.logService.info(`[CopilotCLISession] permission.requested kind=${kind}`);
					break;
				}
				case 'assistant.message': {
					const text = truncateForLog(typeof get('content', 'text') === 'string' ? get('content', 'text') as string : '');
					this.logService.debug(`[CopilotCLISession] assistant.message ${text}`);
					break;
				}
				case 'session.error':
				case 'turn.error': {
					this.logService.error(`[CopilotCLISession] ${type}: ${truncateForLog(JSON.stringify(data))}`);
					break;
				}
				default:
					this.logService.trace(`[CopilotCLISession] event ${type}`);
			}
		} catch (e) {
			this.logService.warn(`[CopilotCLISession] _logSessionEvent failed for ${type}: ${e}`);
		}
	}


	addUserMessage(content: string) {
		this._sdkSession.emit('user.message', { content });
	}

	addUserAssistantMessage(content: string) {
		this._sdkSession.emit('assistant.message', {
			messageId: `msg_${Date.now()}`,
			content
		});
	}

	public getSelectedModelId() {
		return this._sdkSession.getSelectedModel();
	}

	public getLastResponseModelId(): string | undefined {
		return this._lastResponseModelId;
	}

	private _logRequest(userPrompt: string, modelId: string, attachments: Attachment[], startTimeMs: number): void {
		const markdownContent = this._renderRequestToMarkdown(userPrompt, modelId, attachments, startTimeMs);
		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Copilot CLI | ${truncate(userPrompt, 30)}`,
			startTimeMs,
			icon: ThemeIcon.fromId('worktree'),
			markdownContent,
			isConversationRequest: true
		});
	}

	private _logConversation(userPrompt: string, assistantResponse: string, modelId: string, attachments: Attachment[], startTimeMs: number, status: 'Completed' | 'Failed', errorMessage?: string): void {
		const markdownContent = this._renderConversationToMarkdown(userPrompt, assistantResponse, modelId, attachments, startTimeMs, status, errorMessage);
		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Copilot CLI | ${truncate(userPrompt, 30)}`,
			startTimeMs,
			icon: ThemeIcon.fromId('worktree'),
			markdownContent,
			isConversationRequest: true
		});
	}

	private _renderAttachments(attachments: Attachment[]): string[] {
		const lines: string[] = [];
		for (const attachment of attachments) {
			switch (attachment.type) {
				case 'github_reference': {
					lines.push(`- ${attachment.title}: (${attachment.number}, ${attachment.type}, ${attachment.referenceType})`);
					break;
				}
				case 'github_actions_job': {
					lines.push(`- ${attachment.jobName}: (${attachment.jobId}, ${attachment.type})`);
					break;
				}
				case 'github_commit': {
					lines.push(`- ${attachment.message}: (${attachment.oid}, ${attachment.type})`);
					break;
				}
				case 'github_file': {
					lines.push(`- ${attachment.path}: (${attachment.ref}, ${attachment.type})`);
					break;
				}
				case 'github_file_diff': {
					lines.push(`- ${attachment.url}: (${attachment.type})`);
					break;
				}
				case 'github_release': {
					lines.push(`- ${attachment.name}: (${attachment.tagName}, ${attachment.type})`);
					break;
				}
				case 'github_repository': {
					lines.push(`- ${attachment.repo.name}: (${attachment.url}, ${attachment.type})`);
					break;
				}
				case 'github_tree_comparison': {
					lines.push(`- ${attachment.head}: (${attachment.base}, ${attachment.type})`);
					break;
				}
				case 'github_url': {
					lines.push(`- ${attachment.url}: (${attachment.type})`);
					break;
				}
				case 'github_snippet': {
					lines.push(`- ${attachment.path}: (${attachment.type})`);
					break;
				}
				case 'blob': {
					lines.push(`- ${attachment.displayName ?? 'blob'} (${attachment.type}, ${attachment.mimeType})`);
					break;
				}
				case 'extension_context': {
					lines.push(`- ${attachment.title ?? 'extension_context'} (${attachment.type}, ${attachment.extensionId})`);
					break;
				}
				default: {
					lines.push(`- ${attachment.displayName} (${attachment.type}, ${attachment.type === 'selection' ? attachment.filePath : attachment.path})`);
				}
			}
		}
		return lines;
	}

	private _renderRequestToMarkdown(userPrompt: string, modelId: string, attachments: Attachment[], startTimeMs: number): string {
		const result: string[] = [];
		result.push(`# Copilot CLI Session`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`modelId      : ${modelId}`);
		result.push(`isolation    : ${isIsolationEnabled(this.workspace) ? 'enabled' : 'disabled'}`);
		result.push(`working dir  : ${getWorkingDirectory(this.workspace)?.fsPath || '<not set>'}`);
		result.push(`startTime    : ${new Date(startTimeMs).toISOString()}`);
		result.push(`~~~`);
		result.push(``);
		result.push(`## User Prompt`);
		result.push(`~~~`);
		result.push(userPrompt);
		result.push(`~~~`);
		result.push(``);
		result.push(`## Attachments`);
		result.push(`~~~`);
		result.push(...this._renderAttachments(attachments));
		result.push(`~~~`);
		result.push(``);
		return result.join('\n');
	}

	private _renderPermissionToMarkdown(permissionRequest: PermissionRequest, response: string): string {
		const result: string[] = [];
		result.push(`# Permission Request`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`kind         : ${permissionRequest.kind}`);
		result.push(`toolCallId   : ${permissionRequest.toolCallId || ''}`);
		result.push(`~~~`);
		result.push(``);
		switch (permissionRequest.kind) {
			case 'read':
				result.push(`## Read Permission Details`);
				result.push(`~~~`);
				result.push(`path         : ${permissionRequest.path}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`~~~`);
				break;
			case 'write':
				result.push(`## Write Permission Details`);
				result.push(`~~~`);
				result.push(`path         : ${permissionRequest.fileName}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`diff         : ${permissionRequest.diff}`);
				result.push(`~~~`);
				break;
			case 'mcp':
				result.push(`## MCP Permission Details`);
				result.push(`~~~`);
				result.push(`server       : ${permissionRequest.serverName}`);
				result.push(`tool         : ${permissionRequest.toolName} (${permissionRequest.toolTitle})`);
				result.push(`readOnly     : ${permissionRequest.readOnly}`);
				result.push(`args         : ${permissionRequest.args !== undefined ? (typeof permissionRequest.args === 'string' ? permissionRequest.args : JSON.stringify(permissionRequest.args, undefined, 2)) : ''}`);
				result.push(`~~~`);
				break;
			case 'shell':
				result.push(`## Shell Permission Details`);
				result.push(`~~~`);
				result.push(`command : ${permissionRequest.fullCommandText}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`paths        : ${permissionRequest.possiblePaths}`);
				result.push(`urls         : ${permissionRequest.possibleUrls}`);
				result.push(`~~~`);
				break;
			case 'url':
				result.push(`## URL Permission Details`);
				result.push(`~~~`);
				result.push(`url      : ${permissionRequest.url}`);
				result.push(`intention    : ${permissionRequest.intention}`);
				result.push(`~~~`);
				break;
		}
		result.push(``);
		result.push(`## Response`);
		result.push(`~~~`);
		result.push(response);
		result.push(``);
		return result.join('\n');
	}

	private _renderConversationToMarkdown(userPrompt: string, assistantResponse: string, modelId: string, attachments: Attachment[], startTimeMs: number, status: 'Completed' | 'Failed', errorMessage?: string): string {
		const result: string[] = [];
		result.push(`# Copilot CLI Session`);
		result.push(``);
		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`sessionId    : ${this.sessionId}`);
		result.push(`status       : ${status}`);
		result.push(`modelId      : ${modelId}`);
		result.push(`isolation    : ${isIsolationEnabled(this.workspace) ? 'enabled' : 'disabled'}`);
		result.push(`working dir  : ${getWorkingDirectory(this.workspace)?.fsPath || '<not set>'}`);
		result.push(`startTime    : ${new Date(startTimeMs).toISOString()}`);
		result.push(`endTime      : ${new Date().toISOString()}`);
		result.push(`duration     : ${Date.now() - startTimeMs}ms`);
		if (errorMessage) {
			result.push(`error        : ${errorMessage}`);
		}
		result.push(`~~~`);
		result.push(``);
		result.push(`## User Prompt`);
		result.push(`~~~`);
		result.push(userPrompt);
		result.push(`~~~`);
		result.push(``);
		result.push(`## Attachments`);
		result.push(`~~~`);
		result.push(...this._renderAttachments(attachments));
		result.push(`~~~`);
		result.push(``);
		result.push(`## Assistant Response`);
		result.push(`~~~`);
		result.push(assistantResponse || '(no response)');
		result.push(`~~~`);
		return result.join('\n');
	}

	/**
	 * Starts a synthesized `execute_tool` OTel span for a native CLI tool call.
	 *
	 * Native CLI tools (e.g. `powershell`, `bash`, `grep`, `task`) execute inside the SDK and never
	 * reach the workbench tools service, so they don't otherwise produce `execute_tool` spans for the
	 * chat debug logs view. MCP/VS Code tools (those carrying an `mcpServerName`) already emit spans
	 * via the tools service and are skipped here to avoid duplicate entries.
	 */
	private _startSyntheticToolSpan(
		event: ToolExecutionStartEvent,
		syntheticToolSpans: Map<string, ISpanHandle>,
		rootTraceContext: TraceContext | undefined,
	): void {
		const toolCall = event.data as unknown as ToolCall;
		if (toolCall.mcpServerName) {
			return;
		}
		// Nest tool calls made by a subagent under that subagent's tool span when we have it.
		const parentToolCallId = event.data.parentToolCallId;
		const parentContext = (parentToolCallId ? syntheticToolSpans.get(parentToolCallId)?.getSpanContext() : undefined) ?? rootTraceContext;
		const toolSpan = this._otelService.startSpan(`execute_tool ${toolCall.toolName}`, {
			kind: SpanKind.INTERNAL,
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
				[GenAiAttr.CONVERSATION_ID]: this.sessionId,
				[GenAiAttr.TOOL_NAME]: toolCall.toolName,
				[GenAiAttr.TOOL_CALL_ID]: toolCall.toolCallId,
				[CopilotChatAttr.SESSION_ID]: this.sessionId,
				[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
			},
			parentTraceContext: parentContext,
		});
		if (toolCall.arguments !== undefined) {
			try {
				toolSpan.setAttribute(GenAiAttr.TOOL_CALL_ARGUMENTS, truncateForOTel(
					typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments),
					this._otelService.config.maxAttributeSizeChars,
				));
			} catch (err) {
				this.logService.trace(`[CopilotCLISession] Failed to serialize tool arguments for ${toolCall.toolName}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		syntheticToolSpans.set(toolCall.toolCallId, toolSpan);
	}

	/**
	 * Completes the synthesized `execute_tool` span for a native CLI tool, recording the result and
	 * status. No-op for tools that were not synthesized (e.g. MCP/VS Code tools).
	 */
	private _endSyntheticToolSpan(
		event: ToolExecutionCompleteEvent,
		syntheticToolSpans: Map<string, ISpanHandle>,
	): void {
		const toolSpan = syntheticToolSpans.get(event.data.toolCallId);
		if (!toolSpan) {
			return;
		}
		syntheticToolSpans.delete(event.data.toolCallId);
		if (event.data.success) {
			const content = event.data.result?.content;
			if (content !== undefined) {
				try {
					toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(
						typeof content === 'string' ? content : JSON.stringify(content),
						this._otelService.config.maxAttributeSizeChars,
					));
				} catch (err) {
					this.logService.trace(`[CopilotCLISession] Failed to serialize tool result for ${event.data.toolCallId}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			toolSpan.setStatus(SpanStatusCode.OK);
		} else {
			const errorMessage = event.data.error
				? `${event.data.error.code ?? ''} ${event.data.error.message ?? ''}`.trim() || 'tool error'
				: 'tool error';
			toolSpan.setAttribute(GenAiAttr.TOOL_CALL_RESULT, truncateForOTel(`ERROR: ${errorMessage}`, this._otelService.config.maxAttributeSizeChars));
			toolSpan.setStatus(SpanStatusCode.ERROR, errorMessage);
		}
		toolSpan.end();
	}

	/**
	 * Synthesizes one `chat` OTel span per model turn reported by the SDK (`assistant.usage`), carrying
	 * that turn's token usage and resolved model. The chat debug logs view derives an `llm_request`
	 * (model turn) entry from each span and the `agent_response` from the final main-agent turn's output
	 * messages. For the in-process Copilot CLI experience the model calls happen inside the SDK and never
	 * produce JS spans, so without this the model turns, token metrics, and agent response would all be
	 * missing from the debug logs.
	 */
	private _injectModelTurnSpans(turns: readonly IModelTurnUsage[], responseText: string, fallbackModelId: string | undefined, rootTraceContext: TraceContext | undefined): void {
		if (turns.length === 0) {
			// No usage events were reported — still surface the response if we have one.
			if (responseText) {
				this._emitChatSpan({}, responseText, fallbackModelId, rootTraceContext);
			}
			return;
		}
		// The assistant response belongs to the final main-agent turn (one without a parent tool call;
		// turns with a parent tool call originate from subagents).
		let responseTurnIndex = -1;
		for (let i = turns.length - 1; i >= 0; i--) {
			if (!turns[i].parentToolCallId) {
				responseTurnIndex = i;
				break;
			}
		}
		for (let i = 0; i < turns.length; i++) {
			this._emitChatSpan(turns[i], i === responseTurnIndex ? responseText : '', fallbackModelId, rootTraceContext);
		}
	}

	/**
	 * Emits a single synthesized `chat` span for one model turn. Token usage attributes are set only when
	 * present, and the assistant response (`OUTPUT_MESSAGES`) is attached only to the turn that produced it.
	 */
	private _emitChatSpan(turn: IModelTurnUsage, responseText: string, fallbackModelId: string | undefined, rootTraceContext: TraceContext | undefined): void {
		const model = turn.model ?? fallbackModelId;
		const chatSpan = this._otelService.startSpan(model ? `chat ${model}` : 'chat', {
			kind: SpanKind.CLIENT,
			attributes: {
				[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
				[GenAiAttr.PROVIDER_NAME]: GenAiProviderName.GITHUB,
				[GenAiAttr.CONVERSATION_ID]: this.sessionId,
				[CopilotChatAttr.SESSION_ID]: this.sessionId,
				[CopilotChatAttr.CHAT_SESSION_ID]: this.sessionId,
				...(model ? { [GenAiAttr.REQUEST_MODEL]: model } : {}),
				...(typeof turn.inputTokens === 'number' ? { [GenAiAttr.USAGE_INPUT_TOKENS]: turn.inputTokens } : {}),
				...(typeof turn.outputTokens === 'number' ? { [GenAiAttr.USAGE_OUTPUT_TOKENS]: turn.outputTokens } : {}),
				...(typeof turn.cacheReadTokens === 'number' ? { [GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS]: turn.cacheReadTokens } : {}),
				...(typeof turn.copilotUsageNanoAiu === 'number' ? { [CopilotChatAttr.COPILOT_USAGE_NANO_AIU]: turn.copilotUsageNanoAiu } : {}),
				...(responseText ? { [GenAiAttr.OUTPUT_MESSAGES]: truncateForOTel(JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: responseText }] }]), this._otelService.config.maxAttributeSizeChars) } : {}),
			},
			parentTraceContext: rootTraceContext,
		});
		chatSpan.end();
	}

	private _logToolCall(toolCallId: string, toolName: string, args: unknown, eventData: { success: boolean; error?: { code: string; message: string }; result?: { content: string } }): void {
		const argsStr = args !== undefined ? (typeof args === 'string' ? args : JSON.stringify(args, undefined, 2)) : '';
		const resultStr = eventData.result?.content ?? '';
		const errorStr = eventData.error ? `Error: ${eventData.error.code} - ${eventData.error.message}` : '';

		const markdownContent = [
			`# Tool Call: ${toolName}`,
			``,
			`## Metadata`,
			`~~~`,
			`toolCallId   : ${toolCallId}`,
			`toolName     : ${toolName}`,
			`success      : ${eventData.success}`,
			`~~~`,
			``,
			`## Arguments`,
			`~~~`,
			argsStr,
			`~~~`,
			``,
			`## Result`,
			`~~~`,
			eventData.success ? resultStr : errorStr,
			`~~~`,
		].join('\n');

		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Tool: ${toolName}`,
			startTimeMs: Date.now(),
			icon: Codicon.tools,
			markdownContent,
			isConversationRequest: true
		});
	}

	private _sendToolInvokedTelemetry(
		event: ToolExecutionCompleteEvent,
		toolCall: ToolCall | undefined,
		toolStartTimes: Map<string, number>,
		sessionResource: vscode.Uri | undefined,
	): void {
		const { toolCallId, success, error } = event.data;
		const eventToolName = 'toolName' in event.data && typeof event.data.toolName === 'string' ? event.data.toolName : undefined;
		const toolName = toolCall?.toolName ?? eventToolName ?? '<unknown>';
		const startTime = toolStartTimes.get(toolCallId);
		toolStartTimes.delete(toolCallId);
		const invocationTimeMs = startTime !== undefined ? Date.now() - startTime : undefined;

		let result: 'success' | 'error' | 'userCancelled';
		if (success) {
			result = 'success';
		} else if (error?.code === 'rejected' || error?.code === 'denied' || error?.code === 'cancelled') {
			// `rejected`/`denied` come from the user denying a permission prompt; `cancelled` comes
			// from request cancellation.
			result = 'userCancelled';
		} else {
			result = 'error';
		}

		const toolSourceKind = toolCall?.mcpServerName ? 'mcp' : 'copilotCli';

		/* __GDPR__
			"languageModelToolInvoked" : {
				"owner": "roblourens",
				"comment": "Provides insight into the usage of language model tools invoked by agent SDKs.",
				"result": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "success | error | userCancelled" },
				"chatSessionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The chat session resource id." },
				"toolId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The tool name reported by the agent SDK." },
				"toolExtensionId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Always undefined for agent SDK tools." },
				"toolSourceKind": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The source of the tool invocation." },
				"invocationTimeMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The duration of the tool invocation in milliseconds." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('languageModelToolInvoked', {
			result,
			chatSessionId: sessionResource?.toString(),
			toolId: toolName,
			toolExtensionId: undefined,
			toolSourceKind,
		}, invocationTimeMs !== undefined ? { invocationTimeMs } : undefined);
	}
}

function extractPullRequestUrlFromToolResult(result: unknown): string | undefined {
	if (!result || typeof result !== 'object') {
		return undefined;
	}

	const { content } = result as { content?: unknown };
	const text = typeof content === 'string' ? content : JSON.stringify(content);

	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && 'url' in parsed) {
			const url = (parsed as { url: unknown }).url;
			if (typeof url === 'string' && isHttpUrl(url)) {
				return url;
			}
		}
	} catch {
		// not JSON
	}

	const urlMatch = text.match(/https?:\/\/[^\s"'`,;)\]}>]+/);
	if (urlMatch) {
		const cleaned = urlMatch[0].replace(/[.)\]}>]+$/, '');
		if (isHttpUrl(cleaned)) {
			return cleaned;
		}
	}

	return undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:';
	} catch {
		return false;
	}
}

interface UsageInfoData {
	readonly currentTokens: number;
	readonly systemTokens?: number;
	readonly conversationTokens?: number;
	readonly toolDefinitionsTokens?: number;
	readonly tokenLimit?: number;
}

/**
 * Token usage for a single model turn, captured from the SDK `assistant.usage` event. Used to
 * synthesize per-turn `chat` spans for the in-process Copilot CLI chat debug logs view.
 */
interface IModelTurnUsage {
	readonly model?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly copilotUsageNanoAiu?: number;
	/** Set when the turn originates from a subagent (nested under a parent tool call). */
	readonly parentToolCallId?: string;
}

/**
 * Shape of a single quota snapshot on the SDK's `assistant.usage` event (`quotaSnapshots`). The
 * field is marked internal-only by the SDK, so although the published types say `entitlementRequests`
 * is a number and `resetDate` is a `Date`, the runtime shape can drift (e.g. a sibling SDK delivers
 * `resetDate` as an ISO string). Mark the fields optional and validate at runtime below.
 */
interface ISdkQuotaSnapshot {
	readonly isUnlimitedEntitlement?: boolean;
	readonly entitlementRequests?: number;
	readonly overage?: number;
	readonly overageAllowedWithExhaustedQuota?: boolean;
	readonly remainingPercentage?: number;
	readonly resetDate?: Date | string;
}

/** Maps the SDK `assistant.usage` quota snapshots to the shared {@link QuotaSnapshots} shape. */
function toChatQuotaSnapshots(snapshots: Record<string, ISdkQuotaSnapshot>): QuotaSnapshots {
	const result: Record<string, QuotaSnapshot> = {};
	for (const [key, snapshot] of Object.entries(snapshots)) {
		if (!snapshot || typeof snapshot !== 'object') {
			continue;
		}
		const unlimited = snapshot.isUnlimitedEntitlement === true;
		const entitlement = unlimited
			? '-1'
			: typeof snapshot.entitlementRequests === 'number' ? String(snapshot.entitlementRequests) : undefined;
		if (entitlement === undefined || typeof snapshot.remainingPercentage !== 'number') {
			continue;
		}
		result[key] = {
			entitlement,
			percent_remaining: snapshot.remainingPercentage,
			overage_permitted: snapshot.overageAllowedWithExhaustedQuota ?? false,
			overage_count: typeof snapshot.overage === 'number' ? snapshot.overage : 0,
			reset_date: toResetDateIsoString(snapshot.resetDate),
		};
	}
	return result;
}

/** Coerces an SDK `resetDate` (a `Date` per the published type, but possibly an ISO string at runtime) to an ISO string. */
function toResetDateIsoString(resetDate: Date | string | undefined): string | undefined {
	if (resetDate instanceof Date) {
		return resetDate.toISOString();
	}
	return typeof resetDate === 'string' ? resetDate : undefined;
}

function buildPromptTokenDetails(usageInfo: UsageInfoData | undefined): { category: string; label: string; percentageOfPrompt: number }[] | undefined {
	if (!usageInfo || usageInfo.currentTokens <= 0) {
		return undefined;
	}
	const details: { category: string; label: string; percentageOfPrompt: number }[] = [];
	const total = usageInfo.currentTokens;
	if (usageInfo.systemTokens && usageInfo.systemTokens > 0) {
		details.push({
			category: PromptTokenCategory.System,
			label: PromptTokenLabel.SystemInstructions,
			percentageOfPrompt: Math.round((usageInfo.systemTokens / total) * 100),
		});
	}
	if (usageInfo.toolDefinitionsTokens && usageInfo.toolDefinitionsTokens > 0) {
		details.push({
			category: PromptTokenCategory.System,
			label: PromptTokenLabel.Tools,
			percentageOfPrompt: Math.round((usageInfo.toolDefinitionsTokens / total) * 100),
		});
	}
	if (usageInfo.conversationTokens && usageInfo.conversationTokens > 0) {
		details.push({
			category: PromptTokenCategory.UserContext,
			label: PromptTokenLabel.Messages,
			percentageOfPrompt: Math.round((usageInfo.conversationTokens / total) * 100),
		});
	}
	return details.length > 0 ? details : undefined;
}

function truncateForLog(value: unknown, maxLen = 2000): string {
	const text = typeof value === 'string' ? value : String(value);
	if (text.length <= maxLen) {
		return text;
	}
	return text.slice(0, maxLen) + `… [truncated, ${text.length - maxLen} more chars]`;
}
