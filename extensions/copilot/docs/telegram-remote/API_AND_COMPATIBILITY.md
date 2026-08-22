# API and Compatibility Matrix

This document records which project features rely on upstream Copilot internals, public Copilot SDK APIs, stable VS Code APIs, proposed VS Code APIs, Telegram APIs, or downstream code.

The goal is to make upgrade risk explicit.

## 1. Dependency classes

| Class | Meaning | Upgrade risk |
| --- | --- | --- |
| Copilot SDK public API | Documented `@github/copilot-sdk` behavior | Low/medium |
| Upstream Copilot internal service | Source-level service inside `extensions/copilot` | Medium |
| Stable VS Code API | Public `vscode.*` API | Low |
| Proposed VS Code API | `vscode.proposed.*` / gated API | High |
| Internal workbench command/service | Not a supported extension contract | High; avoid for core behavior |
| Telegram Bot API | Public HTTPS API | Low/medium |
| Downstream glue | This project | Controlled by us |

## 2. Feature mapping

| Feature | Primary API/service | Dependency class | Feasibility | Notes |
| --- | --- | --- | --- | --- |
| List Copilot CLI sessions | `ICopilotCLISessionService.getAllSessions()` | Upstream internal | Yes | Preferred because Telegram targets the same VS Code sessions |
| Get session | `ICopilotCLISessionService.getSession()` | Upstream internal | Yes | Avoid second SDK session manager |
| Create session | `ICopilotCLISessionService.createSession()` | Upstream internal | Yes | Reuse workspace/MCP/worktree setup |
| Session history | `getChatHistory()` / SDK events | Upstream + SDK | Yes | Useful for attaching Telegram to existing session |
| Normal prompt | existing `CopilotCLISession` request path / SDK `send` | Upstream + SDK | Yes | Preserve upstream request lifecycle |
| Mid-turn steering | SDK `send(... mode: 'immediate')` | Copilot SDK | Yes | Upstream Copilot already uses this pattern |
| Queueing | SDK enqueue/default send behavior | Copilot SDK | Yes | P1 |
| Abort | SDK/session `abort()` | Copilot SDK/upstream | Yes | P0 |
| Assistant streaming | `assistant.message_delta`, `assistant.message` | Copilot SDK | Yes | Telegram renderer coalesces deltas |
| Intent/status | `assistant.intent` and session state events | Copilot SDK | Yes where exposed | Do not synthesize hidden reasoning |
| Reasoning stream | `assistant.reasoning[_delta]` | Copilot SDK | Conditional | Model/provider may expose readable, opaque or no reasoning |
| Tool activity | `tool.execution_*` | Copilot SDK | Yes | P0 |
| Permission prompt | `permission.requested` | Copilot SDK/upstream | Yes | Remote callback must correlate request ID |
| Permission response | `respondToPermission()` | Copilot SDK | Yes | Same semantic used by Mission Control |
| Agent question | `user_input.requested` | Copilot SDK | Yes | Choice/freeform input |
| User-input response | `respondToUserInput()` | Copilot SDK | Yes | P0 |
| Plan approval/exit | current session/SDK plan request APIs | Upstream + SDK | Yes | P1; follow current source API names |
| Subagent status | `subagent.*` events | Copilot SDK | Yes | P1 |
| Usage/context | `assistant.usage`, `session.usage_info` | Copilot SDK | Yes | Some aggregate metrics may evolve |
| List Copilot CLI models | upstream model service / SDK model catalogue | Upstream + SDK | Yes | Authoritative for agent sessions |
| Model switch | current SDK session selected-model API | Copilot SDK/upstream | Yes | Check provider compatibility before hot switch |
| Reasoning effort | selected-model/session options | Copilot SDK/upstream | Yes where supported | Do not show unsupported choices |
| BYOK | Copilot SDK/CLI provider configuration | Copilot SDK | Yes | Provider configuration remains upstream-owned |
| vLLM/Ollama | supported compatible provider path | Copilot SDK/CLI | Yes when model supports agent requirements | Test each local model |
| VS Code LM enumeration | `vscode.lm.selectChatModels()` | Stable VS Code API | Yes | Supplementary only |
| Workspace folders | `vscode.workspace` + upstream workspace services | Stable/upstream | Yes | P0/P1 |
| Diagnostics | `vscode.languages.getDiagnostics()` | Stable VS Code API | Yes | Existing Copilot MCP tooling already uses it |
| Native diff | `vscode.diff` command | Stable VS Code command | Yes | Existing upstream behavior |
| Native chat session UI | `vscode.chat.*` session-provider/controller APIs | Proposed VS Code API | Yes only when proposed API enabled | Inherited from upstream fork |
| Native advanced model provider integration | richer LM/chat provider proposals | Proposed VS Code API | Yes only when enabled | Inherited from upstream fork |
| Native remote prompt rendered in same chat | upstream internal workbench command path | Internal | Upstream can do it | Telegram SHOULD avoid depending on this unless necessary |
| Telegram long polling | `getUpdates` | Telegram Bot API | Yes | Default transport |
| Telegram buttons | `InlineKeyboardMarkup` / callback queries | Telegram Bot API | Yes | Permissions, models, sessions |
| Live status edit | `editMessageText` / reply markup edit | Telegram Bot API | Yes | Needed to avoid chat flooding |
| Telegram file download | `getFile` / file endpoint | Telegram Bot API | Yes | P1 |
| Proposed API persistent enablement | `argv.json` `enable-proposed-api` | VS Code runtime configuration | Yes | User consent + full restart |
| Marketplace publication with proposals | Marketplace policy | VS Code policy | No for current architecture | VSIX distribution first |

## 3. Upstream Copilot services we intentionally reuse

### `ICopilotCLISessionService`

Source: [`../../src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts`](../../src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts)

Current source exposes session lifecycle and methods including:

- session change/create/delete events,
- `getSessionWorkingDirectory`,
- `getSessionItem`,
- `getSessionTitle`,
- `getAllSessions`,
- `createNewSessionId`,
- `deleteSession`,
- `renameSession`,
- `getSession`,
- `createSession`,
- `getChatHistory`,
- `forkSession`.

These are internal source interfaces, not public third-party extension APIs. Because this project is a downstream fork, using them is acceptable but creates rebase risk that must be covered by tests.

### `CopilotCLISession`

Source: [`../../src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`](../../src/extension/chatSessions/copilotcli/node/copilotcliSession.ts)

Current source already demonstrates:

- detecting a busy session,
- treating a new message as steering,
- SDK `mode: 'immediate'`,
- abort behavior,
- event subscriptions,
- permission response paths,
- user-input response paths,
- model updates,
- Mission Control remote event forwarding and command processing.

This is the most important reference implementation for Telegram remote semantics.

### `ICopilotCLIModels` / `CopilotCLISDK`

Source: [`../../src/extension/chatSessions/copilotcli/node/copilotCli.ts`](../../src/extension/chatSessions/copilotcli/node/copilotCli.ts)

Use these rather than hard-coding model names or independently loading the SDK unless upstream architecture requires otherwise.

### `CopilotCLIMCPHandler`

Source: [`../../src/extension/chatSessions/copilotcli/node/mcpHandler.ts`](../../src/extension/chatSessions/copilotcli/node/mcpHandler.ts)

Telegram must not create a parallel IDE tool bridge. The same Copilot session should continue using upstream MCP/VS Code integration.

## 4. Proposed VS Code APIs

The upstream Copilot manifest declares many proposed APIs. A downstream extension with a different extension ID is not automatically granted the same product-level allowlist.

VS Code source behavior:

- product-configured extension IDs can receive an explicit proposal allowlist,
- extension development can receive proposal access depending on build mode,
- `--enable-proposed-api=<extension-id>` adds an extension ID to the runtime-enabled set,
- otherwise a non-builtin extension requesting proposals has those proposal declarations removed and logs an error.

Project consequence:

> A renamed downstream VSIX needs a first-run setup that persistently enables its extension ID in `argv.json`, followed by a full VS Code restart.

Official guidance: https://code.visualstudio.com/api/advanced-topics/using-proposed-api

## 5. Stable VS Code APIs that remain available under our own ID

The following are not dependent on the privileged Copilot extension identity and can be used normally:

- extension activation and commands,
- workspace APIs,
- `SecretStorage`,
- notifications/input/QuickPick,
- language diagnostics,
- filesystem APIs exposed to extensions,
- `vscode.lm.selectChatModels()` where applicable,
- stable built-in commands such as `vscode.diff`,
- status bar/tree views/webviews if needed.

Therefore the extension ID issue primarily affects **proposed/native Copilot integration surfaces**, not basic Telegram connectivity or the Copilot SDK runtime itself.

## 6. APIs to avoid as core dependencies

### Internal workbench commands

Upstream Mission Control currently routes some remote prompts through an internal workbench command so the message appears correctly in the native chat UI.

This is valuable reference behavior but should not become a mandatory Telegram dependency unless there is no alternative. Internal command IDs and argument shapes may change without compatibility guarantees.

### Public `GitHub.copilot-chat` extension export

The installed Copilot extension's small public export does not currently provide the comprehensive session-control surface required by this project. A separate companion extension cannot rely on it for the full feature set.

### UI scraping

Never use DOM/screen/chat text scraping as an API.

## 7. Telegram API assumptions

V1 relies on stable Bot API primitives:

- `getUpdates` long polling,
- `sendMessage`,
- `editMessageText`,
- `editMessageReplyMarkup`,
- callback queries,
- inline keyboards,
- bot identity validation (`getMe`),
- optional file APIs later.

Reference: https://core.telegram.org/bots/api

Long polling and webhooks are mutually exclusive. V1 chooses long polling because it requires no inbound connectivity.

## 8. Compatibility policy

Every downstream release SHOULD record:

```text
VS Code upstream commit
Copilot extension version
@github/copilot dependency version
@github/copilot-sdk API/runtime version as resolved upstream
Telegram patch revision
Required proposed API list
Minimum/matching VS Code version
```

A rebase is not considered compatible merely because TypeScript compiles. Critical runtime flows in [TEST_STRATEGY.md](./TEST_STRATEGY.md) must also pass.

## 9. External references

- Copilot SDK feature index: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features
- Streaming events: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events
- Steering/queueing: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing
- Session persistence: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence
- Remote sessions: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/remote-sessions
- VS Code proposed API: https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- VS Code Extension API: https://code.visualstudio.com/api/references/vscode-api
- Telegram Bot API: https://core.telegram.org/bots/api
