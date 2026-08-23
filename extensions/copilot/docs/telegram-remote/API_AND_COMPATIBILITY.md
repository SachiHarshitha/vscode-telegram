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
| Internal workbench command/service | Not a supported external extension contract | High; allowed only where the current source fork already requires and tests it |
| Telegram Bot API | Public HTTPS API | Low/medium |
| Downstream glue | This project | Controlled by us |

## 2. Feature mapping

| Feature | Primary API/service | Dependency class | Feasibility | Notes |
| --- | --- | --- | --- | --- |
| List Copilot CLI sessions | `ICopilotCLISessionService.getAllSessions()` | Upstream internal | Yes | Preferred because Telegram targets the same VS Code sessions |
| Get session | `ICopilotCLISessionService.getSession()` | Upstream internal | Yes | Returns `IReference<ICopilotCLISession>`; caller must dispose it |
| Create session | `ICopilotCLISessionService.createSession()` | Upstream internal | Yes | Reuse workspace/MCP/worktree setup and dispose returned reference |
| Session history/replay | `getChatHistory()` + session-bridge access to `sdkSession.getEvents()` | Upstream + SDK | Yes | Filter persisted replay types; buffer/deduplicate live overlap |
| Normal prompt | pending request context + `workbench.action.chat.openSessionWithPrompt.copilotcli` | Upstream internal command | Yes in current fork | Dispatch without awaiting the full turn; required for real `ChatRequest`/token; no direct SDK send |
| Mid-turn steering | same native request path, then upstream SDK `send(... mode: 'immediate')` | Upstream internal + SDK | Yes | Busy-session detection remains inside `CopilotCLISession` |
| Remote origin attribution | registry-created discriminated origin | Downstream seam | Required | Never infer permission/mode from `SendOptions.source` string prefixes |
| Queueing | SDK enqueue/default send behavior | Copilot SDK | Yes | P1 |
| Abort | registry session binding -> wrapped SDK `abort()` | Downstream seam + SDK | Yes | Not present on `ICopilotCLISession` today |
| Assistant streaming | `assistant.message_delta`, `assistant.message` | Copilot SDK | Yes | Telegram renderer coalesces deltas |
| Intent/status | `assistant.intent` and session state events | Copilot SDK | Yes where exposed | Do not synthesize hidden reasoning |
| Reasoning stream | `assistant.reasoning[_delta]` | Copilot SDK | Conditional | Model/provider may expose readable, opaque or no reasoning |
| Tool activity | `tool.execution_*` | Copilot SDK | Yes | P0 |
| Permission prompt | `permission.requested` | Copilot SDK/upstream | Yes | Remote callback must correlate request ID |
| Permission response | registry result consumed by `CopilotCLISession`, then SDK `respondToPermission()` | Downstream seam + SDK | Yes | Do not expose raw SDK session to Telegram |
| Agent question | `user_input.requested` | Copilot SDK | Yes | Choice/freeform input |
| User-input response | registry result consumed by `CopilotCLISession`, then SDK `respondToUserInput()` | Downstream seam + SDK | Yes | P0 |
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
| Native remote prompt rendered in same chat | pending request context + upstream internal workbench command | Internal | Required in current fork | Both controller implementations use this route; guard with compatibility tests |
| Telegram long polling | `getUpdates` | Telegram Bot API | Yes | Default transport |
| Telegram buttons | `InlineKeyboardMarkup` / callback queries | Telegram Bot API | Yes | Permissions, models, sessions |
| Live status edit | `editMessageText` / reply markup edit | Telegram Bot API | Yes | Needed to avoid chat flooding |
| Telegram file download | `getFile` / file endpoint | Telegram Bot API | Yes | P1 |
| Bundled fork proposal access | VS Code product configuration + bundled Copilot identity | Fork/product configuration | Yes in current development architecture | Validate in the built fork; no `argv.json` mutation by default |
| Independent-extension proposal access | `argv.json` `enable-proposed-api` / development flag | VS Code runtime configuration | Development/private only | Applies to future own-ID extension path; user consent + full restart |
| Marketplace publication with proposals | Marketplace policy | VS Code policy | No for independent current-API design | Requires stable APIs or an upstream-supported extension point |

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

`getSession()` and `createSession()` return `IReference<ICopilotCLISession>`, not a bare session. Code must retain the reference only while the remote binding or operation needs it and dispose it deterministically. Treat reference acquire/release as part of the API contract and test it.

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

However, `ICopilotCLISession` itself exposes none of the following:

- persistent SDK event subscription,
- abort,
- `respondToPermission()`,
- `respondToUserInput()`,
- selected-model mutation.

Those capabilities are on the concrete wrapper/its `sdkSession` or inside request-local code. Most SDK listeners used for native rendering are registered inside `_handleRequestImplInner` and disposed with that request. Mission Control adds its own persistent wildcard listener only while remote control is active. The implementation therefore requires a small transport-neutral seam in `CopilotCLISession`; a Telegram-side cast to the concrete class is not the supported design.

Current Mission Control detection uses `source.startsWith('command-')` and then consults shared `_mcState.mcMode`. The registry refactor must replace this as a permission/mode discriminator with a typed origin carried separately from the SDK source string. It must also consolidate overlapping request/persistent Mission Control forwarding so each SDK event ID is exported once.

### Controller path

`ChatSessionsContrib` currently selects between `registerCopilotCLIServices()` (session-controller path) and `registerCopilotCLIServicesV1()` (older non-controller path). Initial implementation and tests target the controller path. The V1 path is a separate compatibility milestone, not an implicit requirement for the first spike.

### `ICopilotCLIModels` / `CopilotCLISDK`

Source: [`../../src/extension/chatSessions/copilotcli/node/copilotCli.ts`](../../src/extension/chatSessions/copilotcli/node/copilotCli.ts)

Use these rather than hard-coding model names or independently loading the SDK unless upstream architecture requires otherwise.

### `CopilotCLIMCPHandler`

Source: [`../../src/extension/chatSessions/copilotcli/node/mcpHandler.ts`](../../src/extension/chatSessions/copilotcli/node/mcpHandler.ts)

Telegram must not create a parallel IDE tool bridge. The same Copilot session should continue using upstream MCP/VS Code integration.

## 4. Proposed VS Code APIs and packaging modes

The upstream Copilot manifest declares many proposed APIs. A downstream extension with a different extension ID is not automatically granted the same product-level allowlist.

VS Code source behavior:

- product-configured extension IDs can receive an explicit proposal allowlist,
- extension development can receive proposal access depending on build mode,
- `--enable-proposed-api=<extension-id>` adds an extension ID to the runtime-enabled set,
- otherwise a non-builtin extension requesting proposals has those proposal declarations removed and logs an error.

Project consequences differ by packaging mode:

- **Current fork:** the modified Copilot extension is bundled with the VS Code fork and receives proposal access through the fork's product configuration. Verify this in the built product; do not modify `argv.json` as a normal setup step.
- **Future independent extension/own-ID VSIX:** proposal access must be explicitly enabled for development/private use, commonly through the runtime flag or `argv.json`, followed by a full restart. This is not a normal Marketplace contract.

Whether a self-built VS Code/Copilot fork can reuse every hosted GitHub Copilot authentication path is a separate source/runtime validation item. Do not infer a definitive signing restriction without that investigation.

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

## 6. High-risk and forbidden dependencies

### Internal workbench commands

Upstream Mission Control routes remote prompts through `workbench.action.chat.openSessionWithPrompt.copilotcli` after staging data with `setPendingCopilotCLIRequestContext(...)`. Both current controller implementations also use the command when opening a Copilot CLI session.

For a third-party companion extension this would be an unsuitable core dependency. Inside this source fork it is the required current path: it creates a real `ChatRequest`, supplies the `ChatParticipantToolToken`, preserves the native request lifecycle and makes the message visible in chat. Feature-detect it, keep its arguments centralized and fail visibly when compatibility tests detect an upstream change. Direct SDK `send()` is not a V1 fallback.

The command action awaits `responseCompletePromise`. Remote transports therefore dispatch it fire-and-forget, immediately acknowledge accepted input, observe the returned promise for errors and perform correlation-safe pending-context cleanup on rejection.

### Raw concrete session / SDK access

Telegram code must not cast `ICopilotCLISession` to `CopilotCLISession` or retain its `sdkSession`. Extend the transport-neutral registry/session seam instead.

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
