/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ICopilotCLIModels } from '../../chatSessions/copilotcli/node/copilotCli';
import {
	ITelegramLanguageModelBridge,
	type ITelegramLmChatRequest,
	type ITelegramLmChatResult,
	type ITelegramLmInputItem,
	type ITelegramLmOutputItem,
	type TelegramLanguageModelSelection,
	type TelegramSelectableModelInfo,
} from '../common/telegramLanguageModelBridgeTypes';
import {
	bridgeResultToResponsesBody,
	bridgeResultToResponsesSseFrames,
	type IResponsesRequest,
	responsesErrorBody,
	responsesRequestToBridge,
	ResponsesTranslationError,
} from './telegramLanguageModelResponses';

const providerName = 'telegram-vscode-lm';
const proxyPath = '/vscode-lm/responses';
const maximumRequestBytes = 8 * 1024 * 1024;
const statefulMarkerMimeType = 'stateful_marker';
const usageMimeType = 'usage';
const reasoningMetadataPrefix = 'vscode-reasoning-metadata:';
const reasoningSummaryDone = 'vscode_reasoning_summary_part_done';

interface BridgeCatalogEntry {
	readonly descriptor: TelegramSelectableModelInfo;
	readonly model?: vscode.LanguageModelChat;
	readonly wireModelId?: string;
}

interface ProxyRuntime {
	readonly server: Server;
	readonly baseUrl: string;
	readonly nonce: string;
}

interface ExtendedRequestOptions extends vscode.LanguageModelChatRequestOptions {
	readonly configuration?: Readonly<Record<string, unknown>>;
	readonly includeEncryptedThinking?: boolean;
}

/**
 * Projects the native Copilot CLI catalog and the VS Code LM registry into one
 * Telegram catalog. VS Code-backed models execute through an authenticated
 * loopback Responses endpoint, so provider credentials never leave VS Code.
 */
export class TelegramLanguageModelBridge extends Disposable implements ITelegramLanguageModelBridge {
	declare readonly _serviceBrand: undefined;

	private readonly modelByWireId = new Map<string, vscode.LanguageModelChat>();
	private readonly cancellationSources = new Set<vscode.CancellationTokenSource>();
	private proxy: Promise<ProxyRuntime> | undefined;
	private disposed = false;

	constructor(
		private readonly lm: typeof vscode.lm,
		@ICopilotCLIModels private readonly copilotCLIModels: ICopilotCLIModels,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const source of this.cancellationSources) {
			source.cancel();
			source.dispose();
		}
		this.cancellationSources.clear();
		const proxy = this.proxy;
		this.proxy = undefined;
		if (proxy) {
			void proxy.then(runtime => runtime.server.close(), () => undefined);
		}
		super.dispose();
	}

	async getModels(): Promise<readonly TelegramSelectableModelInfo[]> {
		return (await this.refreshCatalog()).map(entry => entry.descriptor);
	}

	async resolveModel(value: string): Promise<TelegramSelectableModelInfo | undefined> {
		const requested = value.trim().toLocaleLowerCase();
		if (!requested) {
			return undefined;
		}
		const catalog = await this.refreshCatalog();
		const exact = catalog.find(entry => entry.descriptor.id.toLocaleLowerCase() === requested);
		if (exact) {
			return exact.descriptor;
		}

		const aliases = catalog.filter(entry => {
			const model = entry.descriptor;
			return model.name.toLocaleLowerCase() === requested
				|| `${model.provider}/${model.name}`.toLocaleLowerCase() === requested;
		});
		if (aliases.length === 1) {
			return aliases[0].descriptor;
		}

		const nativeModelId = await this.copilotCLIModels.resolveModel(value);
		return nativeModelId ? catalog.find(entry => entry.descriptor.source === 'copilotcli' && entry.descriptor.id === nativeModelId)?.descriptor : undefined;
	}

	async resolveSelection(modelId: string): Promise<TelegramLanguageModelSelection | undefined> {
		const catalog = await this.refreshCatalog();
		const selected = catalog.find(entry => entry.descriptor.id === modelId && entry.model && entry.wireModelId);
		if (!selected?.wireModelId) {
			return undefined;
		}
		const runtime = await this.ensureProxy();
		const vscodeModels = catalog.filter((entry): entry is BridgeCatalogEntry & { readonly model: vscode.LanguageModelChat; readonly wireModelId: string } => !!entry.model && !!entry.wireModelId);
		return {
			model: `${providerName}/${selected.wireModelId}`,
			registry: {
				providers: [{
					name: providerName,
					type: 'openai',
					wireApi: 'responses',
					baseUrl: runtime.baseUrl,
					bearerToken: runtime.nonce,
				}],
				models: vscodeModels.map(entry => ({
					id: entry.wireModelId,
					provider: providerName,
					wireModel: entry.wireModelId,
					name: `${entry.descriptor.name} (${entry.descriptor.provider})`,
					maxContextWindowTokens: entry.descriptor.maxContextWindowTokens,
				})),
			},
		};
	}

	private async refreshCatalog(): Promise<BridgeCatalogEntry[]> {
		const [nativeResult, vscodeResult] = await Promise.allSettled([
			this.copilotCLIModels.getModels(),
			this.lm.selectChatModels(),
		]);
		const nativeModels = nativeResult.status === 'fulfilled' ? nativeResult.value : [];
		const vscodeModels = vscodeResult.status === 'fulfilled' ? vscodeResult.value : [];
		if (nativeResult.status === 'rejected') {
			this.logService.warn('[TelegramRemote] model-catalog=native-unavailable');
		}
		if (vscodeResult.status === 'rejected') {
			this.logService.warn('[TelegramRemote] model-catalog=vscode-lm-unavailable');
		}

		const entries: BridgeCatalogEntry[] = nativeModels.map(model => ({
			descriptor: {
				id: model.id,
				name: model.name,
				provider: 'Copilot CLI',
				source: 'copilotcli',
				maxContextWindowTokens: model.maxContextWindowTokens,
				supportsVision: model.supportsVision,
				supportsReasoningEffort: model.supportsReasoningEffort,
				defaultReasoningEffort: model.defaultReasoningEffort,
				supportedReasoningEfforts: model.supportedReasoningEfforts,
			},
		}));

		this.modelByWireId.clear();
		const visibleModels = vscodeModels.filter(model => model.vendor !== 'copilotcli' && !model.vendor.startsWith('agent-host-'));
		const baseIdCounts = new Map<string, number>();
		for (const model of visibleModels) {
			const baseId = `${model.vendor}/${model.id}`;
			baseIdCounts.set(baseId, (baseIdCounts.get(baseId) ?? 0) + 1);
		}
		const ordinals = new Map<string, number>();
		const nativeIds = new Set(nativeModels.map(model => model.id.toLocaleLowerCase()));
		for (const model of visibleModels) {
			// The native CLI version is preferred for an exact Copilot duplicate; other
			// Copilot and configured models remain visible through the VS Code bridge.
			if (model.vendor === 'copilot' && nativeIds.has(model.id.toLocaleLowerCase())) {
				continue;
			}
			const baseId = `${model.vendor}/${model.id}`;
			const ordinal = (ordinals.get(baseId) ?? 0) + 1;
			ordinals.set(baseId, ordinal);
			const fingerprint = [model.vendor, model.id, model.family, model.version, model.name, ordinal].join('\0');
			const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 20);
			const wireModelId = `m-${hash}`;
			const duplicateSuffix = (baseIdCounts.get(baseId) ?? 0) > 1 ? `@${model.version || 'variant'}-${ordinal}` : '';
			const telegramId = `${baseId}${duplicateSuffix}`;
			this.modelByWireId.set(wireModelId, model);
			entries.push({
				descriptor: {
					id: telegramId,
					runtimeModelId: `${providerName}/${wireModelId}`,
					name: model.name,
					provider: model.vendor,
					source: 'vscode-lm',
					maxContextWindowTokens: model.maxInputTokens,
					supportsVision: model.capabilities.supportsImageToText,
				},
				model,
				wireModelId,
			});
		}

		return entries.sort((a, b) => a.descriptor.source.localeCompare(b.descriptor.source) || a.descriptor.provider.localeCompare(b.descriptor.provider) || a.descriptor.name.localeCompare(b.descriptor.name));
	}

	private ensureProxy(): Promise<ProxyRuntime> {
		if (this.disposed) {
			return Promise.reject(new Error('Telegram language-model bridge is disposed.'));
		}
		if (!this.proxy) {
			this.proxy = new Promise<ProxyRuntime>((resolve, reject) => {
				const nonce = randomBytes(32).toString('hex');
				const server = createServer((request, response) => {
					void this.handleProxyRequest(request, response, nonce);
				});
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => {
					server.removeListener('error', reject);
					const address = server.address();
					if (!address || typeof address === 'string') {
						server.close();
						reject(new Error('Telegram language-model proxy did not bind a TCP port.'));
						return;
					}
					this.logService.info(`[TelegramRemote] model-proxy=started models=${this.modelByWireId.size}`);
					resolve({ server, nonce, baseUrl: `http://127.0.0.1:${address.port}/vscode-lm` });
				});
			});
			void this.proxy.catch(() => { this.proxy = undefined; });
		}
		return this.proxy;
	}

	private async handleProxyRequest(request: IncomingMessage, response: ServerResponse, nonce: string): Promise<void> {
		try {
			const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
			if (request.method !== 'POST' || pathname !== proxyPath) {
				this.writeError(response, 404, 'Route not found', 'not_found_error');
				return;
			}
			if (request.headers.authorization !== `Bearer ${nonce}`) {
				this.writeError(response, 401, 'Invalid authentication', 'authentication_error');
				return;
			}
			let body: IResponsesRequest;
			try {
				body = JSON.parse(await this.readBody(request)) as IResponsesRequest;
			} catch (error) {
				this.writeError(response, 400, `Invalid request body: ${error instanceof Error ? error.message : String(error)}`, 'invalid_request_error');
				return;
			}
			let bridgeRequest: ITelegramLmChatRequest;
			try {
				bridgeRequest = responsesRequestToBridge(body);
			} catch (error) {
				this.writeError(response, 400, error instanceof ResponsesTranslationError ? error.message : String(error), 'invalid_request_error');
				return;
			}
			const model = this.modelByWireId.get(bridgeRequest.modelId);
			if (!model) {
				this.writeError(response, 404, 'Selected VS Code language model is no longer available', 'not_found_error');
				return;
			}
			const cancellation = new vscode.CancellationTokenSource();
			this.cancellationSources.add(cancellation);
			const cancel = () => cancellation.cancel();
			request.once('aborted', cancel);
			response.once('close', cancel);
			try {
				const result = await this.chat(model, bridgeRequest, cancellation.token);
				if (cancellation.token.isCancellationRequested || response.writableEnded) {
					return;
				}
				if (result.error) {
					this.writeError(response, 502, result.error);
					return;
				}
				if (body.stream === true) {
					response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
					for (const frame of bridgeResultToResponsesSseFrames(result, bridgeRequest.modelId)) {
						response.write(frame);
					}
					response.end();
				} else {
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(bridgeResultToResponsesBody(result, bridgeRequest.modelId));
				}
			} finally {
				request.removeListener('aborted', cancel);
				response.removeListener('close', cancel);
				this.cancellationSources.delete(cancellation);
				cancellation.dispose();
			}
		} catch (error) {
			this.logService.warn(`[TelegramRemote] model-proxy=request-failed kind=${error instanceof vscode.LanguageModelError ? error.code : 'internal'}`);
			this.writeError(response, 502, error instanceof Error ? error.message : String(error));
		}
	}

	private async chat(model: vscode.LanguageModelChat, request: ITelegramLmChatRequest, token: vscode.CancellationToken): Promise<ITelegramLmChatResult> {
		const messages = this.toMessages(request);
		const tools = request.tools?.map(tool => ({
			name: tool.name,
			description: tool.description ?? '',
			inputSchema: tool.type === 'function' ? tool.parametersSchema : { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
		}));
		const options: ExtendedRequestOptions = {
			justification: l10n.t('Run the model selected by the authorized Telegram Remote user.'),
			modelOptions: request.modelOptions,
			includeEncryptedThinking: true,
			...(request.reasoningEffort ? { configuration: { reasoningEffort: request.reasoningEffort } } : {}),
			...(tools?.length ? { tools } : {}),
		};
		try {
			const response = await model.sendRequest(messages, options, token);
			const output: ITelegramLmOutputItem[] = [];
			const customToolNames = new Set(request.tools?.filter(tool => tool.type === 'custom').map(tool => tool.name));
			const completedReasoningParts = new Set<string | undefined>();
			let responseId: string | undefined;
			let usage: ITelegramLmChatResult['usage'];
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					this.appendText(output, part.value);
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					if (part.metadata?.[reasoningSummaryDone] === true) {
						completedReasoningParts.add(part.id);
					} else if (part.metadata?.vscode_reasoning_done !== true) {
						this.appendReasoning(output, part, part.value !== '' && completedReasoningParts.delete(part.id));
					}
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					if (customToolNames.has(part.name)) {
						output.push({ type: 'custom_tool_call', callId: part.callId, name: part.name, input: this.customToolInput(part.input) });
					} else {
						output.push({ type: 'function_call', callId: part.callId, name: part.name, argumentsJson: JSON.stringify(part.input ?? {}) });
					}
				} else if (part instanceof vscode.LanguageModelDataPart) {
					if (part.mimeType === statefulMarkerMimeType) {
						responseId = this.decodeStatefulMarker(part.data, request.modelId);
					} else if (part.mimeType === usageMimeType) {
						usage = this.decodeUsage(part.data);
					}
				}
			}
			return { output, responseId, usage };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[TelegramRemote] vscode-model=request-failed provider=${model.vendor} kind=${error instanceof vscode.LanguageModelError ? error.code : 'api'}`);
			return { output: [], error: message };
		}
	}

	private toMessages(request: ITelegramLmChatRequest): vscode.LanguageModelChatMessage2[] {
		const messages: vscode.LanguageModelChatMessage2[] = [];
		if (request.previousResponseId) {
			messages.push(this.message(vscode.LanguageModelChatMessageRole.Assistant, [vscode.LanguageModelDataPart.text(`${request.modelId}\\${request.previousResponseId}`, statefulMarkerMimeType)]));
		}
		if (request.instructions) {
			messages.push(this.message(vscode.LanguageModelChatMessageRole.System, [new vscode.LanguageModelTextPart(request.instructions)]));
		}
		for (const item of request.input) {
			const message = this.toMessage(item);
			const previous = messages.at(-1);
			if (message.role === vscode.LanguageModelChatMessageRole.Assistant && previous?.role === vscode.LanguageModelChatMessageRole.Assistant) {
				messages[messages.length - 1] = this.message(previous.role, [...previous.content, ...message.content]);
			} else {
				messages.push(message);
			}
		}
		return messages;
	}

	private toMessage(item: ITelegramLmInputItem): vscode.LanguageModelChatMessage2 {
		switch (item.type) {
			case 'message':
				return this.message(this.toRole(item.role), item.content.map(part => part.type === 'text' ? new vscode.LanguageModelTextPart(part.text) : vscode.LanguageModelDataPart.image(Buffer.from(part.data, 'base64'), part.mimeType)));
			case 'reasoning':
				return this.message(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelThinkingPart(item.summary, item.id, { ...item.metadata, ...(item.encryptedContent ? this.decodeReasoningMetadata(item.encryptedContent) : {}) })]);
			case 'function_call':
				return this.message(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelToolCallPart(item.callId, item.name, this.safeParseJson(item.argumentsJson))]);
			case 'custom_tool_call':
				return this.message(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelToolCallPart(item.callId, item.name, { input: item.input })]);
			case 'function_call_output':
			case 'custom_tool_call_output':
				return this.message(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart(item.callId, [new vscode.LanguageModelTextPart(item.output)])]);
		}
	}

	private message(role: vscode.LanguageModelChatMessageRole, content: vscode.LanguageModelChatMessage2['content']): vscode.LanguageModelChatMessage2 {
		return { role, content, name: undefined };
	}

	private toRole(role: Extract<ITelegramLmInputItem, { type: 'message' }>['role']): vscode.LanguageModelChatMessageRole {
		return role === 'assistant'
			? vscode.LanguageModelChatMessageRole.Assistant
			: role === 'user' ? vscode.LanguageModelChatMessageRole.User : vscode.LanguageModelChatMessageRole.System;
	}

	private appendText(output: ITelegramLmOutputItem[], value: string): void {
		const previous = output.at(-1);
		if (previous?.type === 'message') {
			output[output.length - 1] = { type: 'message', content: [{ type: 'text', text: previous.content.map(part => part.text).join('') + value }] };
		} else {
			output.push({ type: 'message', content: [{ type: 'text', text: value }] });
		}
	}

	private appendReasoning(output: ITelegramLmOutputItem[], part: vscode.LanguageModelThinkingPart, startsNewSummary: boolean): void {
		const summary = Array.isArray(part.value) ? part.value : [part.value];
		const encryptedContent = this.encodeReasoningMetadata(part.metadata);
		const previous = output.at(-1);
		if (previous?.type === 'reasoning' && previous.id === part.id) {
			output[output.length - 1] = {
				...previous,
				summary: startsNewSummary || Array.isArray(part.value) ? [...previous.summary, ...summary] : [...previous.summary.slice(0, -1), (previous.summary.at(-1) ?? '') + part.value],
				encryptedContent: encryptedContent ?? previous.encryptedContent,
				metadata: { ...previous.metadata, ...part.metadata },
			};
		} else {
			output.push({ type: 'reasoning', id: part.id, summary, encryptedContent, metadata: part.metadata });
		}
	}

	private encodeReasoningMetadata(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
		const encrypted = this.stringMetadata(metadata, 'encrypted_content') ?? this.stringMetadata(metadata, 'encrypted');
		if (encrypted) {
			return encrypted;
		}
		const continuation = ['signature', '_completeThinking', 'redactedData'].reduce<Record<string, string>>((result, key) => {
			const value = this.stringMetadata(metadata, key);
			if (value) {
				result[key] = value;
			}
			return result;
		}, {});
		return Object.keys(continuation).length ? `${reasoningMetadataPrefix}${JSON.stringify(continuation)}` : undefined;
	}

	private decodeReasoningMetadata(value: string): Record<string, unknown> {
		if (!value.startsWith(reasoningMetadataPrefix)) {
			return { encrypted_content: value };
		}
		const metadata = JSON.parse(value.slice(reasoningMetadataPrefix.length));
		if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
			throw new Error('Invalid Telegram language-model reasoning metadata.');
		}
		return metadata as Record<string, unknown>;
	}

	private customToolInput(input: unknown): string {
		if (typeof input === 'object' && input !== null) {
			const value = Object.getOwnPropertyDescriptor(input, 'input')?.value;
			if (typeof value === 'string') {
				return value;
			}
		}
		return typeof input === 'string' ? input : JSON.stringify(input ?? {});
	}

	private decodeStatefulMarker(data: Uint8Array, expectedModelId: string): string | undefined {
		const decoded = new TextDecoder().decode(data);
		const separator = decoded.indexOf('\\');
		return separator >= 0 && decoded.slice(0, separator) === expectedModelId ? decoded.slice(separator + 1) || undefined : undefined;
	}

	private decodeUsage(data: Uint8Array): ITelegramLmChatResult['usage'] {
		try {
			const value = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
			const details = typeof value.completion_tokens_details === 'object' && value.completion_tokens_details !== null ? value.completion_tokens_details as Record<string, unknown> : undefined;
			return {
				inputTokens: this.numberProperty(value, 'prompt_tokens'),
				outputTokens: this.numberProperty(value, 'completion_tokens'),
				reasoningTokens: details ? this.numberProperty(details, 'reasoning_tokens') : undefined,
			};
		} catch {
			return undefined;
		}
	}

	private readBody(request: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			request.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maximumRequestBytes) {
					reject(new Error('Request body is too large.'));
					request.destroy();
					return;
				}
				chunks.push(chunk);
			});
			request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			request.once('error', reject);
		});
	}

	private writeError(response: ServerResponse, status: number, message: string, type = 'api_error'): void {
		if (!response.headersSent && !response.writableEnded) {
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end(responsesErrorBody(message, type));
		}
	}

	private safeParseJson(value: string): object {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	private numberProperty(value: Record<string, unknown>, key: string): number | undefined {
		return typeof value[key] === 'number' ? value[key] : undefined;
	}

	private stringMetadata(metadata: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
		return typeof metadata?.[key] === 'string' ? metadata[key] : undefined;
	}
}
