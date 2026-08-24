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
| Create session from Telegram | `CopilotCLIChatSessionContentProvider.createTelegramSession()` then native first prompt | Upstream controller + narrow glue | Implemented | Creates provisional controller metadata only; native request materializes the normal wrapper/workspace/MCP path, so Telegram owns no session reference |
| Session history/replay | `getChatHistory()` + `ICopilotCLISession.getReplayEvents()` | Upstream + SDK | Yes | Phase 1 filters persisted replay types and buffers/deduplicates live overlap without exposing the SDK session |
| Normal prompt | pending request context + `workbench.action.chat.openSessionWithPrompt.copilotcli` | Upstream internal command | Yes in current fork | Dispatch without awaiting the full turn; required for real `ChatRequest`/token; no direct SDK send |
| Mid-turn steering | same native request path, then upstream SDK `send(... mode: 'immediate')` | Upstream internal + SDK | Yes | Busy-session detection remains inside `CopilotCLISession` |
| Remote origin attribution | registry-created discriminated origin | Downstream seam | Required | Never infer permission/mode from `SendOptions.source` string prefixes |
| Queueing | SDK enqueue/default send behavior | Copilot SDK | Yes | P1 |
| Abort | registry session binding -> `ICopilotCLISession.abort()` -> wrapped SDK `abort()` | Downstream seam + SDK | Yes | Implemented in Phase 1; logical attachment remains when no live wrapper is bound |
| Assistant streaming | `assistant.message_delta`, `assistant.message` | Copilot SDK | Yes | Deltas update their semantic progress round; full messages finalize it |
| Intent/status | `assistant.intent` and session state events | Copilot SDK | Yes where exposed | Do not synthesize hidden reasoning |
| Reasoning stream | `assistant.reasoning[_delta]` | Copilot SDK | Conditional | Model/provider may expose readable, opaque or no reasoning |
| Tool activity | `tool.execution_start`, `tool.execution_progress`, `tool.execution_partial_result`, `tool.execution_complete` | Copilot SDK 1.0.73 | Yes | `toolCallId` owns one ActivityRound/message lifecycle; reads/searches aggregate semantically |
| Permission prompt | `permission.requested` | Copilot SDK/upstream | Yes | Individual waiting Rich Message with one-shot controls |
| Permission response | registry result consumed by `CopilotCLISession`, then SDK `respondToPermission()` | Downstream seam + SDK | Yes | Telegram returns approve-once/deny only; no raw SDK session exposure or policy mutation |
| Agent question | `user_input.requested` | Copilot SDK | Yes | Choice/freeform input |
| User-input response | registry result consumed by `CopilotCLISession`, then SDK `respondToUserInput()` | Downstream seam + SDK | Yes | P0 |
| Plan approval/exit | `exit_plan_mode.requested` + registry race + SDK `respondToExitPlanMode()` | Downstream seam + Copilot SDK 1.0.73 | Yes | Implemented in Phase 6; remote responses allow only `interactive`, `exit_only`, denial or feedback |
| Subagent status | `subagent.*` events | Copilot SDK | Yes | P1 |
| Usage/context | `assistant.usage`, `session.usage_info` | Copilot SDK | Yes | Some aggregate metrics may evolve |
| List Agent Chat models | `ICopilotCLIModels.getModels()` + `vscode.lm.selectChatModels()` | Upstream + stable VS Code API | Implemented | Provider-qualified merged catalogue; opaque callbacks and complete pagination |
| Read selected model | `ICopilotCLISession.getSelectedModelId()` or `ICopilotCLISessionService.getSelectedModelId()` | Upstream + SDK | Implemented | Inactive reads reuse the transient SDK session open/read/close pattern and never expose the SDK object |
| Model switch | native `userSelectedModelId`, or private VS Code-LM selection configuration -> initializer -> additive SDK registry -> session `updateModel()` | Internal workbench + upstream + SDK | Implemented | Telegram preference is consumed once; stale custom selection never falls back to another model |
| Reasoning effort | workbench `userSelectedModelConfiguration` -> native `ChatRequest.modelConfiguration` -> SDK `setSelectedModel()` | Internal workbench + upstream + SDK | Implemented where supported | Feature flag and exact catalogue effort list are validated before dispatch; stale choices fail visibly |
| Safe request mode | registry-created Telegram origin -> `CopilotCLISession` `agentMode` | Downstream seam + SDK | Implemented | Telegram origins default to `interactive` and may select `plan`; runtime and type guards reject elevating modes |
| BYOK/configured models | VS Code LM object -> authenticated `127.0.0.1` Responses adapter -> additive Copilot SDK provider registry | VS Code LM API + Copilot SDK | Integration implemented; backend compatibility unclaimed | Raw provider credentials remain in the VS Code provider; the SDK receives only the loopback nonce |
| vLLM/Ollama | supported compatible provider path | Copilot SDK/CLI | Unclaimed pending full matrix | Catalogue visibility alone is not an agent compatibility result |
| VS Code LM enumeration | `vscode.lm.selectChatModels()` | Stable VS Code API | Implemented | Merged into Telegram model selection; recursive agent-host and native duplicates are excluded |
| Workspace folders | `vscode.workspace` + upstream workspace services | Stable/upstream | Yes | P0/P1 |
| Diagnostics | `vscode.languages.getDiagnostics()` | Stable VS Code API | Yes | Existing Copilot MCP tooling already uses it |
| Native diff | `vscode.diff` command | Stable VS Code command | Yes | Existing upstream behavior |
| Native chat session UI | `vscode.chat.*` session-provider/controller APIs | Proposed VS Code API | Yes only when proposed API enabled | Inherited from upstream fork |
| Native advanced model provider integration | richer LM/chat provider proposals | Proposed VS Code API | Yes only when enabled | Inherited from upstream fork |
| Native remote prompt rendered in same chat | pending request context + upstream internal workbench command | Internal | Required in current fork | Both controller implementations use this route; guard with compatibility tests |
| Telegram long polling | `getUpdates` | Telegram Bot API | Yes | Default transport |
| Telegram buttons | `InlineKeyboardMarkup` / `CallbackQuery` | Telegram Bot API | Yes | Sessions, Stop, permissions, questions and plan review use opaque one-shot callback data |
| Rich activity send | `sendRichMessage` + `InputRichMessage` | Telegram Bot API 10.1/10.2 | Yes | One persistent message per semantic ActivityRound |
| Expandable activity | `InputRichBlockDetails` with paragraph/pre/list blocks | Telegram Bot API 10.2 | Yes | Collapsed summary plus details belonging only to that round |
| Live status edit | `editMessageText` with `rich_message` / reply markup edit | Telegram Bot API | Yes | Updates the original running-round message; replacement fallback on edit failure |
| Reply correlation | incoming `Message.reply_to_message` + `ReplyParameters` | Telegram Bot API | Yes | Reply-to-bubble steering and edit-failure replacement linkage |
| Rich draft streaming | `sendRichMessageDraft` + `InputRichBlockThinking` | Telegram Bot API 10.1/10.2 | Typed adapter only | Not used by V1 timeline: drafts are ephemeral 30-second previews and provide no persistent reply target |
| Activity sanitization | bounded event projection + `redactTelegramSecrets()` | Downstream seam | Yes | Presentation receives sanitized, bounded round details; no hidden chain-of-thought extraction |
| Telegram file download | `getFile` / file endpoint | Telegram Bot API | Yes | P1 |
| Session-list remote indicator | `ChatSessionItem.description` / `tooltip` | Proposed VS Code API | Yes | `badge`, `status` and `metadata` are already consumed upstream; these two are free |
| Live indicator refresh | existing `refreshSession({reason:'update'})` on the content provider | Upstream internal | Yes | No new provider or API proposal needed |
| Status bar indicator + kill switch | `vscode.window.createStatusBarItem` | Stable VS Code API | Yes | Precedent: `copilot.networkStatus` in `extension/log/vscode-node/loggingActions.ts` |
| Enable/reconnect lifecycle | VS Code commands + SecretStorage/globalState + generation-bound contribution startup | Stable VS Code + downstream seam | Yes | Four-way readiness, separate runtime admission, workspace-only re-consent, recovery preservation, one poller |
| Modal consent gate | `vscode.window.showWarningMessage(..., { modal: true })` | Stable VS Code API | Yes | Cancel is the default action |
| Setup wizard | `window.showInputBox({ password: true })` / `showQuickPick` | Stable VS Code API | Yes | No webview in V1 |
| Bot token storage | `IVSCodeExtensionContext.secrets` | Stable VS Code API | Yes | Pattern: `byok/vscode-node/byokStorageService.ts` |
| In-chat attach notice | `stream.warning()` on the routed response stream | Proposed VS Code API | Yes | Already implemented on `CopilotCLIResponseStreamRouter`; no-ops without a UI stream |
| Settings registration | `defineSetting()` + `contributes.configuration` | Upstream internal + manifest | Yes | Token must never be a setting |
| V1 bundled-Copilot proposal access | Built-in extension + `package.json#enabledApiProposals` | Bundled extension manifest | Yes in current development architecture | Validate in the built fork; no separate Telegram extension ID and no `argv.json` mutation |
| V2 fork-bundled own-ID companion | `product.json#extensionEnabledApiProposals` + matching manifest declaration | Fork build configuration | Development/private fork only | Build-time registration; activation can verify but cannot self-authorize |
| V2 standalone own-ID experiment | `argv.json` `enable-proposed-api` / development flag | VS Code runtime configuration | Development/private only | Explicit consent + full restart; does not create a Copilot session-control API |
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

`getSession()` and `createSession()` return `IReference<ICopilotCLISession>`, not a bare session. The current Telegram selection, timeline and `/new` paths avoid these calls; tests assert that activity tracking does not acquire a wrapper. Any later caller must retain the reference only for its explicit operation and dispose it deterministically.

### `CopilotCLISession`

Source: [`../../src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`](../../src/extension/chatSessions/copilotcli/node/copilotcliSession.ts)

Current source now provides:

- detecting a busy session,
- treating a new message as steering,
- SDK `mode: 'immediate'`,
- abort behavior,
- event subscriptions,
- permission response paths,
- user-input response paths,
- model updates,
- a wrapper-lifetime transport-neutral event/replay/control bridge,
- registry-coordinated permission and user-input response races,
- registry-coordinated plan-exit response races with a non-elevating remote action type,
- Mission Control forwarding and command processing in `missionControlTransport.ts`.

This is the most important reference implementation for Telegram remote semantics.

Phase 1 adds these narrow transport-neutral members to `ICopilotCLISession`:

- `onDidReceiveSessionEvent`,
- `getReplayEvents()`,
- awaited `abort()`,
- `notifyRemoteAttachment()`,
- `getCurrentMode()`.

SDK response calls remain owned by `CopilotCLISession`; transports return correlated values through the registry and never receive `respondToPermission()`, `respondToUserInput()`, `respondToExitPlanMode()`, selected-model mutation, or raw SDK access. Native rendering listeners remain request-scoped, while one constructor-owned wildcard listener feeds the registry bridge for wrapper lifetime.

Mission Control mode attribution now uses only a registry-created, runtime-validated typed origin carried separately from the SDK source string. `SendOptions.source` is telemetry/correlation data only. Registry deduplication and a single wrapper-lifetime publication point ensure each SDK event ID is exported once per attached transport.

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

- product-configured extension IDs can receive an explicit proposal allowlist through `product.json#extensionEnabledApiProposals`; when present, that product list overrides the extension manifest list,
- extension development can receive proposal access depending on build mode,
- `--enable-proposed-api=<extension-id>` adds an extension ID to the runtime-enabled set,
- otherwise a non-builtin extension requesting proposals has those proposal declarations removed and logs an error; a built-in extension is not stripped by that final restriction.

Project consequences differ by packaging mode:

- **V1 current fork:** the modified Copilot extension is built in and declares its proposals in its manifest. Verify access in the built product; do not create a separate Telegram extension ID or modify `argv.json` as a normal setup step.
- **V2 fork-bundled own-ID companion:** register the exact extension ID and proposal list in `product.json#extensionEnabledApiProposals` during the product build and verify the product/manifest lists remain synchronized. Runtime activation only performs a fail-closed preflight.
- **V2 private standalone own-ID VSIX:** explicitly enable proposal access through the runtime flag or `argv.json`, followed by a full restart. This is not a normal Marketplace contract.

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

The command action accepts `queue: 'queued' | 'steering'`, forwards the queue kind, awaits the eventual sent turn's `responseCompletePromise`, and throws immediate or deferred rejections. Remote transports dispatch it fire-and-forget with `queue: 'steering'`, immediately acknowledge accepted input, observe the returned promise for errors, and perform correlation-safe pending-context cleanup on rejection.

### Raw concrete session / SDK access

Telegram code must not cast `ICopilotCLISession` to `CopilotCLISession` or retain its `sdkSession`. Extend the transport-neutral registry/session seam instead.

`/new` deliberately does not call `ICopilotCLISessionService.createSession()`. The controller provider creates a provisional session in a currently authorized open workspace, and its first prompt travels through the native chat command. This avoids constructing incomplete wrapper options and leaves materialization/reference ownership with the normal controller path.

### Public `GitHub.copilot-chat` extension export

The installed Copilot extension's small public export does not currently provide the comprehensive session-control surface required by this project. A separate companion extension cannot rely on it for the full feature set.

### UI scraping

Never use DOM/screen/chat text scraping as an API.

## 7. Telegram API contract

The Phase 5.3 contract was checked against the official Telegram Bot API 10.2 documentation on 2026-08-24. The narrow dependency-free HTTP adapter now supports:

- `getUpdates` long polling,
- `sendMessage`,
- `sendRichMessage`,
- `sendRichMessageDraft`,
- `editMessageText`,
- `editMessageReplyMarkup`,
- callback queries,
- inline keyboards,
- bot identity validation (`getMe`),
- optional file APIs later.

`InputRichMessage` uses exactly one of `html`, `markdown` or `blocks`. This implementation uses `blocks` for semantic activity and interaction rounds, and sanitized `html` for final assistant answers. Rounds with useful drill-down content use `InputRichBlockDetails` with a `RichText` summary and nested paragraph/preformatted/list blocks; compact lifecycle updates use a paragraph block. `InputRichBlockThinking` is accepted only by the draft method. `editMessageText` sends `rich_message` instead of `text`. `sendRichMessageDraft` is private-chat-only, requires a non-zero `draft_id`, returns `True`, and creates a 30-second ephemeral preview that must later be persisted with `sendRichMessage`; therefore the activity timeline uses persistent send/edit instead.

Requests use the extension's `IFetcherService`; response envelopes and method-specific results are validated before they cross into control code. `getUpdates` remains owned by `TelegramService`, which persists the next accepted offset and holds a token-fingerprinted singleton lease. Networking remains disabled by default and generation-bound Enable/Reconnect cannot create a second poller.

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
