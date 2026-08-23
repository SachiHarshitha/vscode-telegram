/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as l10n from '@vscode/l10n';
import type { Uri } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { PermissiveAuthRequiredError } from '../../../platform/github/common/githubService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable, IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatSessionMetadataStore } from '../../chatSessions/common/chatSessionMetadataStore';
import { getWorkingDirectory } from '../../chatSessions/common/workspaceInfo';
import { stripReminders } from '../../chatSessions/copilotcli/common/copilotCLITools';
import {
	IRemoteCommandContext,
	IRemoteControlRegistry,
	IRemoteControlSessionEvent,
	IRemoteControlTransport,
	IRemotePermissionRequest,
	IRemoteUserInputRequest,
	IRemoteUserInputResponse,
	RemoteControlMode,
	RemotePermissionResult,
} from '../common/remoteControlTypes';
import { McCommand, McEvent, MissionControlApiClient } from '../../chatSessions/copilotcli/node/missionControlApiClient';
import { renderRemoteControlQrCode } from './missionControlQr';
import { IRemotePromptDispatcher } from './remotePromptDispatcher';

const missionControlKeepAliveIntervalMs = 10_000;
const missionControlFlushIntervalMs = 500;
const missionControlPollIntervalMs = 3_000;

interface IMissionControlPendingPermission {
	readonly key: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolCallId?: string;
	resolve(result: RemotePermissionResult | undefined): void;
}

interface IMissionControlPendingUserInput {
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolCallId?: string;
	resolve(result: IRemoteUserInputResponse | undefined): void;
}

interface IMissionControlState {
	readonly sessionId: string;
	readonly mcSessionId: string;
	readonly eventBuffer: McEvent[];
	readonly completedCommandIds: string[];
	readonly processedCommandIds: Set<string>;
	readonly pendingCommandCompletionIds: Set<string>;
	readonly pendingPermissionRequests: Map<string, IMissionControlPendingPermission>;
	readonly pendingUserInputRequests: Set<IMissionControlPendingUserInput>;
	attachment: IDisposable;
	frontendUrl?: string;
	mode?: RemoteControlMode;
	lastEventId: string | null;
	lastSubmitAttemptTimeMs: number;
	flushInterval?: ReturnType<typeof setInterval>;
	pollInterval?: ReturnType<typeof setInterval>;
}

interface IMissionControlPermissionResponseData {
	readonly promptId?: string;
	readonly requestId?: string;
	readonly toolCallId?: string;
	readonly approved?: boolean;
}

interface IMissionControlUserInputResponseData {
	readonly requestId?: string;
	readonly promptId?: string;
	readonly toolCallId?: string;
	readonly answer?: string;
	readonly wasFreeform?: boolean;
	readonly freeText?: string | null;
	readonly selected?: readonly string[];
	readonly skipped?: boolean;
	readonly response?: IMissionControlUserInputResponseData;
}

const skippedEventTypes = new Set([
	'assistant.message_delta',
	'assistant.streaming_delta',
	'session.shutdown',
	'session.error',
	'session.usage_info',
	'assistant.usage',
	'pending_messages.modified',
	'session.mcp_server_status_changed',
	'session.mcp_servers_loaded',
	'session.skills_loaded',
	'session.tools_updated',
]);

export class MissionControlTransport extends Disposable implements IRemoteControlTransport {
	readonly id = 'missionControl';
	readonly label = l10n.t('GitHub Mission Control');

	private readonly states = new Map<string, IMissionControlState>();
	private readonly apiClient: MissionControlApiClient;

	constructor(
		@IRemoteControlRegistry private readonly registry: IRemoteControlRegistry,
		@IRemotePromptDispatcher private readonly promptDispatcher: IRemotePromptDispatcher,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IChatSessionMetadataStore private readonly chatSessionMetadataStore: IChatSessionMetadataStore,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.apiClient = instantiationService.createInstance(MissionControlApiClient);
		this._register(this.registry.registerTransport(this));
		this._register(this.registry.registerCommandHandler('remote', context => this.handleRemoteCommand(context)));
	}

	publish(sessionId: string, event: IRemoteControlSessionEvent): void {
		const state = this.states.get(sessionId);
		if (!state || !shouldForwardEvent(event)) {
			return;
		}

		const commandId = getCommandIdFromEvent(event);
		if (commandId && state.pendingCommandCompletionIds.delete(commandId)) {
			state.completedCommandIds.push(commandId);
		}

		state.eventBuffer.push({
			id: event.id,
			timestamp: event.timestamp,
			parentId: event.parentId,
			ephemeral: event.ephemeral,
			type: event.type,
			data: getEventData(event),
		});
		state.lastEventId = event.id;
	}

	requestPermission(sessionId: string, request: IRemotePermissionRequest, token: CancellationToken): Promise<RemotePermissionResult | undefined> {
		const state = this.states.get(sessionId);
		if (!state) {
			return Promise.resolve(undefined);
		}
		const promptId = request.permissionRequest.toolCallId ?? request.requestId;
		const key = `${request.requestId}:${promptId}`;
		return new Promise(resolve => {
			let settled = false;
			let cancellationListener: IDisposable = Disposable.None;
			const complete = (result: RemotePermissionResult | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				state.pendingPermissionRequests.delete(key);
				cancellationListener.dispose();
				resolve(result);
			};
			cancellationListener = token.onCancellationRequested(() => complete(undefined));
			if (settled) {
				cancellationListener.dispose();
				return;
			}
			if (token.isCancellationRequested) {
				complete(undefined);
				return;
			}
			state.pendingPermissionRequests.set(key, {
				key,
				sessionId,
				requestId: request.requestId,
				toolCallId: request.permissionRequest.toolCallId,
				resolve: complete,
			});
		});
	}

	requestUserInput(sessionId: string, request: IRemoteUserInputRequest, token: CancellationToken): Promise<IRemoteUserInputResponse | undefined> {
		const state = this.states.get(sessionId);
		if (!state) {
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => {
			let settled = false;
			let cancellationListener: IDisposable = Disposable.None;
			const pending: IMissionControlPendingUserInput = {
				sessionId,
				requestId: request.requestId,
				toolCallId: request.toolCallId,
				resolve: result => {
					if (settled) {
						return;
					}
					settled = true;
					state.pendingUserInputRequests.delete(pending);
					cancellationListener.dispose();
					resolve(result);
				},
			};
			cancellationListener = token.onCancellationRequested(() => pending.resolve(undefined));
			if (settled) {
				cancellationListener.dispose();
				return;
			}
			if (token.isCancellationRequested) {
				pending.resolve(undefined);
				return;
			}
			state.pendingUserInputRequests.add(pending);
		});
	}

	private async handleRemoteCommand(context: IRemoteCommandContext): Promise<void> {
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLIRemoteEnabled)) {
			context.output.markdown(l10n.t('The /remote command is not enabled. Set `github.copilot.chat.cli.remote.enabled` to `true` in settings to use it.'));
			return;
		}

		const args = normalizeRemoteArgs(context.args);
		const existing = this.states.get(context.sessionId);
		if (!args || (args === 'on' && existing) || (args === 'off' && !existing)) {
			await this.showStatus(context, existing);
			return;
		}
		if (args !== 'on' && args !== 'off') {
			context.output.markdown(l10n.t('Usage: /remote, /remote on, /remote off'));
			return;
		}

		if (args === 'off') {
			await this.teardown(context.sessionId);
			context.output.markdown(l10n.t('Remote control disabled.'));
			return;
		}

		context.output.progress(l10n.t('Enabling remote control...'));
		try {
			const githubSession = await this.authenticationService.getGitHubSession('any', { silent: true });
			if (!githubSession?.accessToken) {
				context.output.markdown(l10n.t('Unable to enable remote control: no GitHub authentication available.'));
				return;
			}

			const workingDirectory = getWorkingDirectory(context.workspace);
			if (!workingDirectory) {
				context.output.markdown(l10n.t('Unable to enable remote control: no workspace folder found.'));
				return;
			}
			const nwo = await resolveGitHubNwo(workingDirectory);
			if (!nwo) {
				context.output.markdown(l10n.t('Unable to enable remote control: this workspace is not a GitHub repository.'));
				return;
			}

			const repoResponse = await fetch(`https://api.github.com/repos/${nwo.owner}/${nwo.repo}`, {
				headers: { 'Authorization': `token ${githubSession.accessToken}`, 'Accept': 'application/json' },
			});
			if (!repoResponse.ok) {
				context.output.markdown(l10n.t('Unable to enable remote control: could not resolve repository {0}/{1}.', nwo.owner, nwo.repo));
				return;
			}
			const repoData = await repoResponse.json() as { id: number; owner: { id: number } };
			let mcData;
			try {
				mcData = await this.apiClient.createSession(repoData.owner.id, repoData.id, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, {});
			} catch (error) {
				if (error instanceof PermissiveAuthRequiredError) {
					context.output.markdown(l10n.t('Unable to enable remote control: additional GitHub permissions are required.'));
					return;
				}
				throw error;
			}

			const state: IMissionControlState = {
				sessionId: context.sessionId,
				mcSessionId: mcData.id,
				eventBuffer: [],
				completedCommandIds: [],
				processedCommandIds: new Set(),
				pendingCommandCompletionIds: new Set(),
				pendingPermissionRequests: new Map(),
				pendingUserInputRequests: new Set(),
				attachment: toDisposable(() => { }),
				lastEventId: null,
				lastSubmitAttemptTimeMs: Date.now(),
			};
			this.states.set(context.sessionId, state);
			this.bufferSyntheticEvent(state, 'session.start', {
				sessionId: state.mcSessionId,
				version: 1,
				producer: 'copilot-developer-cli',
				copilotVersion: '1.0.0',
				startTime: new Date().toISOString(),
				remoteSteerable: true,
				context: { cwd: workingDirectory, gitRoot: workingDirectory, repository: `${nwo.owner}/${nwo.repo}` },
			});
			this.bufferSyntheticEvent(state, 'session.remote_steerable_changed', { remoteSteerable: true });
			const sessionTitle = await this.getSessionTitle(context.sessionId);
			if (sessionTitle) {
				this.bufferSyntheticEvent(state, 'session.title_changed', { title: sessionTitle }, true);
			}

			state.attachment = this.registry.attachTransport(context.sessionId, this.id);
			await this.flushEvents(state);
			state.frontendUrl = `https://github.com/${nwo.owner}/${nwo.repo}/tasks/${mcData.taskId}`;
			await this.showEnabled(context, state.frontendUrl);
			this.startSchedulers(state);
		} catch (error) {
			this.logService.error(`[MissionControlTransport] Remote control error: ${error}`);
			context.output.markdown(l10n.t('Unable to enable remote control: {0}', error instanceof Error ? error.message : String(error)));
			await this.teardown(context.sessionId);
		}
	}

	private async showStatus(context: IRemoteCommandContext, state: IMissionControlState | undefined): Promise<void> {
		if (!state) {
			context.output.markdown(l10n.t('Remote control is disabled. Use /remote on to enable it.'));
		} else if (state.frontendUrl) {
			await this.showEnabled(context, state.frontendUrl);
		} else {
			context.output.markdown(l10n.t('Remote control is enabled. Use /remote off to disable it.'));
		}
	}

	private async getSessionTitle(sessionId: string): Promise<string | undefined> {
		const session = this.registry.getSession(sessionId);
		const liveTitle = session?.title?.trim();
		if (liveTitle) {
			return liveTitle;
		}

		const events = session?.getReplayEvents() ?? [];
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index];
			if (event.type === 'session.title_changed' && typeof event.data.title === 'string' && event.data.title.trim()) {
				return event.data.title;
			}
		}

		const customTitle = (await this.chatSessionMetadataStore.getCustomTitle(sessionId))?.trim();
		if (customTitle) {
			return customTitle;
		}

		for (const event of events) {
			if (event.type === 'user.message' && typeof event.data.content === 'string') {
				const content = stripReminders(event.data.content).trim();
				if (content) {
					return content;
				}
			}
		}

		return session?.pendingPrompt?.trim() || undefined;
	}

	private async showEnabled(context: IRemoteCommandContext, frontendUrl: string): Promise<void> {
		let message = `**${l10n.t('Remote control is enabled.')}**\n\n${l10n.t('Use the button below to open in your browser, or scan to steer from the GitHub mobile app.')}\n\n${l10n.t('Use /remote off to disable it.')}\n\n`;
		try {
			const qrDataUrl = await renderRemoteControlQrCode(frontendUrl);
			message += `![${l10n.t('QR code to open this remote session in GitHub mobile')}](${qrDataUrl})`;
		} catch (error) {
			this.logService.error(`[MissionControlTransport] Failed to render remote-control QR code: ${error}`);
			message += l10n.t('QR code could not be rendered. Open this session from any device: {0}', frontendUrl);
		}
		context.output.markdown(message);
		context.output.button(l10n.t('Open on GitHub'), frontendUrl);
	}

	private startSchedulers(state: IMissionControlState): void {
		state.flushInterval = setInterval(() => {
			void this.flushEvents(state).catch(error => this.logService.warn(`[MissionControlTransport] Event flush failed: ${error}`));
		}, missionControlFlushIntervalMs);
		state.pollInterval = setInterval(() => {
			void this.pollCommands(state).catch(error => this.logService.warn(`[MissionControlTransport] Command poll failed: ${error}`));
		}, missionControlPollIntervalMs);
	}

	private async teardown(sessionId: string): Promise<void> {
		const state = this.states.get(sessionId);
		if (!state) {
			return;
		}
		this.states.delete(sessionId);
		if (state.flushInterval) {
			clearInterval(state.flushInterval);
		}
		if (state.pollInterval) {
			clearInterval(state.pollInterval);
		}
		state.attachment.dispose();
		for (const pending of state.pendingPermissionRequests.values()) {
			pending.resolve(undefined);
		}
		for (const pending of state.pendingUserInputRequests) {
			pending.resolve(undefined);
		}
		this.bufferSyntheticEvent(state, 'session.remote_steerable_changed', { remoteSteerable: false });
		this.bufferSyntheticEvent(state, 'session.idle', {});
		await this.flushEvents(state);
	}

	private bufferSyntheticEvent(state: IMissionControlState, type: string, data: Record<string, unknown>, ephemeral?: boolean): void {
		const id = crypto.randomUUID();
		state.eventBuffer.push({ id, timestamp: new Date().toISOString(), parentId: state.lastEventId, ephemeral, type, data });
		state.lastEventId = id;
	}

	private async flushEvents(state: IMissionControlState): Promise<void> {
		const completedCommandIds = state.completedCommandIds.splice(0);
		const keepAlive = state.eventBuffer.length === 0 && completedCommandIds.length === 0 && Date.now() - state.lastSubmitAttemptTimeMs >= missionControlKeepAliveIntervalMs;
		if (state.eventBuffer.length === 0 && completedCommandIds.length === 0 && !keepAlive) {
			return;
		}
		state.lastSubmitAttemptTimeMs = Date.now();
		const events = state.eventBuffer.splice(0, 500);
		try {
			if (!await this.apiClient.submitEvents(state.mcSessionId, events, completedCommandIds)) {
				if (state.eventBuffer.length < 2_000) {
					state.eventBuffer.unshift(...events);
				}
				state.completedCommandIds.unshift(...completedCommandIds);
			}
		} catch (error) {
			if (state.eventBuffer.length < 2_000) {
				state.eventBuffer.unshift(...events);
			}
			state.completedCommandIds.unshift(...completedCommandIds);
			this.logService.warn(`[MissionControlTransport] Event submission failed: ${error}`);
		}
	}

	private async pollCommands(state: IMissionControlState): Promise<void> {
		const commands = await this.apiClient.getPendingCommands(state.mcSessionId);
		const pendingIds = new Set(commands.map(command => command.id));
		for (const processedId of state.processedCommandIds) {
			if (!pendingIds.has(processedId)) {
				state.processedCommandIds.delete(processedId);
			}
		}

		for (const command of commands) {
			if (command.state !== 'in_progress' || state.processedCommandIds.has(command.id)) {
				continue;
			}
			state.processedCommandIds.add(command.id);
			const mode = getModeCommand(command.content);
			if (mode) {
				state.mode = mode;
				state.completedCommandIds.push(command.id);
				continue;
			}

			switch (command.type) {
				case 'abort':
					this.cancelPendingResponses(state);
					await this.registry.abort(state.sessionId);
					state.completedCommandIds.push(command.id);
					break;
				case 'permission_response':
					this.acceptPermissionResponse(state, command);
					state.completedCommandIds.push(command.id);
					break;
				case 'ask_user_response':
					this.acceptUserInputResponse(state, command);
					state.completedCommandIds.push(command.id);
					break;
				case 'user_message':
				default: {
					state.pendingCommandCompletionIds.add(command.id);
					const origin = this.registry.createMissionControlOrigin(command.id, state.mode);
					const dispatched = this.promptDispatcher.dispatch(state.sessionId, command.content, origin);
					void dispatched.completion.catch(error => {
						state.pendingCommandCompletionIds.delete(command.id);
						state.completedCommandIds.push(command.id);
						this.logService.warn(`[MissionControlTransport] Steering command ${command.id} failed: ${error}`);
					});
					break;
				}
			}
		}
	}

	private acceptPermissionResponse(state: IMissionControlState, command: McCommand): void {
		const payload = parseJsonCommand<IMissionControlPermissionResponseData>(command, this.logService);
		const pending = [...state.pendingPermissionRequests.values()].find(candidate =>
			candidate.sessionId === state.sessionId &&
			payload?.requestId === candidate.requestId &&
			(payload.promptId === candidate.toolCallId || payload.promptId === candidate.requestId) &&
			(candidate.toolCallId === undefined || payload.toolCallId === candidate.toolCallId)
		);
		if (!pending) {
			this.logService.warn(`[MissionControlTransport] Ignoring stale permission response ${command.id}`);
			return;
		}
		pending.resolve(payload?.approved ? { kind: 'approve-once' } : { kind: 'denied-interactively-by-user' });
	}

	private acceptUserInputResponse(state: IMissionControlState, command: McCommand): void {
		const payload = parseJsonCommand<IMissionControlUserInputResponseData>(command, this.logService);
		const candidates = [...state.pendingUserInputRequests];
		const pending = candidates.find(candidate =>
			candidate.sessionId === state.sessionId &&
			(payload?.requestId ?? payload?.promptId) === candidate.requestId &&
			(candidate.toolCallId === undefined || payload?.toolCallId === candidate.toolCallId)
		);
		if (!pending) {
			this.logService.warn(`[MissionControlTransport] Ignoring stale user-input response ${command.id}`);
			return;
		}
		pending.resolve(toUserInputResponse(payload, command.content));
	}

	private cancelPendingResponses(state: IMissionControlState): void {
		for (const pending of state.pendingPermissionRequests.values()) {
			pending.resolve(undefined);
		}
		for (const pending of state.pendingUserInputRequests) {
			pending.resolve(undefined);
		}
	}

	public override dispose(): void {
		for (const sessionId of [...this.states.keys()]) {
			void this.teardown(sessionId);
		}
		super.dispose();
	}
}

function normalizeRemoteArgs(value: string): string {
	const prompt = stripReminders(value).trim().toLowerCase();
	if (prompt === '/remote' || prompt === 'remote') {
		return '';
	}
	for (const prefix of ['/remote ', 'remote ']) {
		if (prompt.startsWith(prefix)) {
			return prompt.slice(prefix.length).trim();
		}
	}
	return prompt;
}

function resolveGitHubNwo(workingDirectory: Uri): Promise<{ owner: string; repo: string } | undefined> {
	return new Promise(resolve => {
		cp.execFile('git', ['remote', 'get-url', 'origin'], { cwd: workingDirectory.fsPath, timeout: 5_000 }, (_error, stdout) => {
			const match = stdout?.trim().match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
			resolve(match?.groups ? { owner: match.groups.owner, repo: match.groups.repo } : undefined);
		});
	});
}

function shouldForwardEvent(event: IRemoteControlSessionEvent): boolean {
	if (skippedEventTypes.has(event.type)) {
		return false;
	}
	if (event.type === 'tool.execution_start' || event.type === 'tool.execution_complete') {
		const toolName = typeof event.data === 'object' && event.data !== null && 'toolName' in event.data ? event.data.toolName : undefined;
		return toolName !== 'report_intent';
	}
	return true;
}

function getEventData(event: IRemoteControlSessionEvent): Record<string, unknown> {
	if (!event.data || typeof event.data !== 'object') {
		return {};
	}
	const data = event.data as Record<string, unknown>;
	if (event.type === 'user.message' && typeof data.content === 'string') {
		return { ...data, content: stripReminders(data.content) };
	}
	if (event.type === 'tool.execution_start' && (data.toolName === 'bash' || data.toolName === 'powershell' || data.toolName === 'task')) {
		const args = data.arguments;
		if (args && typeof args === 'object' && 'description' in args) {
			const { description: _description, ...sanitizedArgs } = args as Record<string, unknown>;
			return { ...data, arguments: sanitizedArgs };
		}
	}
	return data;
}

function getCommandIdFromEvent(event: IRemoteControlSessionEvent): string | undefined {
	if (event.type !== 'user.message' || !event.data || typeof event.data !== 'object' || !('source' in event.data)) {
		return undefined;
	}
	const source = event.data.source;
	return typeof source === 'string' && source.startsWith('command-') ? source.slice('command-'.length) : undefined;
}

function getModeCommand(content: string): RemoteControlMode | undefined {
	try {
		const parsed = JSON.parse(content) as { mode?: string };
		switch (parsed.mode) {
			case 'plan':
			case 'autopilot':
			case 'interactive':
				return parsed.mode;
			case 'auto':
			case 'autoApprove':
				return 'autopilot';
		}
	} catch {
	}
	return undefined;
}

function parseJsonCommand<T extends object>(command: McCommand, logService: ILogService): T | undefined {
	try {
		const parsed = JSON.parse(command.content) as unknown;
		return parsed && typeof parsed === 'object' ? parsed as T : undefined;
	} catch (error) {
		logService.warn(`[MissionControlTransport] Failed to parse command ${command.id}: ${error}`);
		return undefined;
	}
}

function toUserInputResponse(payload: IMissionControlUserInputResponseData | undefined, rawContent: string): IRemoteUserInputResponse | undefined {
	const response = payload?.response ?? payload;
	const answer = typeof response?.answer === 'string' ? response.answer
		: typeof response?.freeText === 'string' ? response.freeText
			: Array.isArray(response?.selected) ? response.selected.filter((value): value is string => typeof value === 'string').join(', ')
				: response?.skipped ? '' : payload === undefined ? rawContent : undefined;
	return answer === undefined ? undefined : { answer, wasFreeform: response?.wasFreeform ?? typeof response?.freeText === 'string' };
}
