/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ILogService } from '../../../../platform/log/common/logService';
import { mock } from '../../../../util/common/test/simpleMock';
import type { CopilotCLIModelInfo, ICopilotCLIModels } from '../../../chatSessions/copilotcli/node/copilotCli';
import { TelegramLanguageModelBridge } from '../telegramLanguageModelBridge';

const nativeCatalog: CopilotCLIModelInfo[] = [{ id: 'native-model', name: 'Native Model', maxContextWindowTokens: 128_000 }];

class TestCopilotCLIModels extends mock<ICopilotCLIModels>() {
	declare readonly _serviceBrand: undefined;
	override getModels = vi.fn(async () => nativeCatalog);
	override resolveModel = vi.fn(async (value: string) => nativeCatalog.find(model => model.id === value || model.name === value)?.id);
}

class TestLogService extends mock<ILogService>() {
	override info = vi.fn();
	override warn = vi.fn();
}

function languageModel(overrides: Partial<vscode.LanguageModelChat> & Pick<vscode.LanguageModelChat, 'id' | 'name' | 'vendor'>): vscode.LanguageModelChat {
	return {
		family: overrides.id,
		version: '1',
		maxInputTokens: 64_000,
		capabilities: { supportsImageToText: false, supportsToolCalling: true },
		countTokens: vi.fn(async () => 1),
		sendRequest: vi.fn(),
		...overrides,
	};
}

describe('TelegramLanguageModelBridge', () => {
	const bridges: TelegramLanguageModelBridge[] = [];

	afterEach(() => {
		for (const bridge of bridges.splice(0)) {
			bridge.dispose();
		}
		vi.restoreAllMocks();
	});

	it('merges every visible VS Code model with the native CLI catalog and removes recursive/native duplicates', async () => {
		const models = [
			languageModel({ id: 'custom-model', name: 'Configured Model', vendor: 'openai' }),
			languageModel({ id: 'custom-model', name: 'Configured Model 2', vendor: 'openai', version: '2' }),
			languageModel({ id: 'chat-only', name: 'Chat Only', vendor: 'copilot' }),
			languageModel({ id: 'native-model', name: 'Native Duplicate', vendor: 'copilot' }),
			languageModel({ id: 'recursive', name: 'Recursive', vendor: 'copilotcli' }),
			languageModel({ id: 'copy', name: 'Agent Host Copy', vendor: 'agent-host-openai' }),
		];
		const bridge = new TelegramLanguageModelBridge({ selectChatModels: vi.fn(async () => models) } as unknown as typeof vscode.lm, new TestCopilotCLIModels(), new TestLogService());
		bridges.push(bridge);

		const catalog = await bridge.getModels();

		expect(catalog.map(model => [model.id, model.source])).toEqual([
			['native-model', 'copilotcli'],
			['copilot/chat-only', 'vscode-lm'],
			['openai/custom-model@1-1', 'vscode-lm'],
			['openai/custom-model@2-2', 'vscode-lm'],
		]);
	});

	it('executes a configured model through the authenticated Responses proxy without exposing provider credentials', async () => {
		let capturedMessages: readonly (vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2)[] | undefined;
		let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
		const sendRequest = vi.fn(async (messages: Array<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>, options?: vscode.LanguageModelChatRequestOptions) => {
			capturedMessages = messages;
			capturedOptions = options;
			return {
				stream: (async function* () { yield new vscode.LanguageModelTextPart('Configured response'); })(),
				text: (async function* () { yield 'Configured response'; })(),
			};
		});
		const custom = languageModel({ id: 'custom-model', name: 'Configured Model', vendor: 'openai', sendRequest });
		const bridge = new TelegramLanguageModelBridge({ selectChatModels: vi.fn(async () => [custom]) } as unknown as typeof vscode.lm, new TestCopilotCLIModels(), new TestLogService());
		bridges.push(bridge);
		const selection = await bridge.resolveSelection('openai/custom-model');
		expect(selection).toBeDefined();
		const provider = selection!.registry.providers[0];
		const model = selection!.registry.models[0];
		const requestBody = {
			model: model.wireModel,
			instructions: 'Be concise.',
			input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
		};

		const unauthorizedResponse = await fetch(`${provider.baseUrl}/responses`, {
			method: 'POST',
			headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
			body: JSON.stringify(requestBody),
		});
		expect(unauthorizedResponse.status).toBe(401);
		expect(sendRequest).not.toHaveBeenCalled();

		const response = await fetch(`${provider.baseUrl}/responses`, {
			method: 'POST',
			headers: { authorization: `Bearer ${provider.bearerToken}`, 'content-type': 'application/json' },
			body: JSON.stringify(requestBody),
		});

		const responseBody = await response.text();
		expect(response.status, responseBody).toBe(200);
		expect(JSON.parse(responseBody)).toEqual(expect.objectContaining({ output_text: 'Configured response' }));
		expect(sendRequest).toHaveBeenCalledOnce();
		expect(capturedMessages?.map(message => message.role)).toEqual([vscode.LanguageModelChatMessageRole.System, vscode.LanguageModelChatMessageRole.User]);
		expect(capturedOptions?.justification).toContain('Telegram Remote');
		expect(JSON.stringify(selection!.registry)).not.toContain('apiKey');

		const streamingResponse = await fetch(`${provider.baseUrl}/responses`, {
			method: 'POST',
			headers: { authorization: `Bearer ${provider.bearerToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ ...requestBody, stream: true }),
		});
		const streamingBody = await streamingResponse.text();
		expect(streamingResponse.status, streamingBody).toBe(200);
		expect(streamingResponse.headers.get('content-type')).toContain('text/event-stream');
		expect(streamingBody).toContain('event: response.output_text.delta');
		expect(streamingBody).toContain('event: response.completed');
		expect(sendRequest).toHaveBeenCalledTimes(2);
	});
});
