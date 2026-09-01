# API and Compatibility Matrix

> **Status:** Current compatibility reference
> **Scope:** `copilot-telegram` downstream branch
> **Last reviewed:** 2026-09-01
>
> This document identifies which behavior depends on public APIs, upstream Copilot internals, proposed VS Code APIs, internal workbench seams, Telegram APIs, or downstream code. It is primarily an upgrade-risk map.

## 1. Dependency classes

| Class | Meaning | Upgrade risk |
| --- | --- | --- |
| Copilot SDK public API | Documented `@github/copilot-sdk` surface used by upstream/current integration | Low–medium |
| Upstream Copilot internal service | Source-level code under `extensions/copilot` | Medium |
| Stable VS Code API | Public `vscode.*` API | Low |
| Proposed VS Code API | Proposal-gated VS Code API | High |
| Internal workbench seam | Command/service not intended as a third-party extension contract | High |
| Telegram Bot API | Public Telegram HTTPS API | Low–medium |
| Downstream framework | `remoteControl/**` and `telegramRemote/**` | Controlled here |

## 2. Core session/control mapping

| Capability | Current implementation | Dependency class | Notes |
| --- | --- | --- | --- |
| Extension-host session list | `ICopilotCLISessionService.getAllSessions()` | Upstream internal | Used for the normal Copilot CLI provider domain. |
| Remote-control session list | `getRemoteControlSessions()` | Downstream extension of upstream service | Combines extension-host and Agent Host-owned metadata. |
| Identify session ownership | `ICopilotCLIRemoteSessionItem.source` | Downstream seam | `extensionHost` or `agentHost`. |
| Agent Host ownership detection | SDK session metadata + Agent Host session-data directory | Upstream/internal filesystem knowledge | Compatibility-sensitive; covered by focused tests. |
| Agent Host handover | `forkAgentHostSession()` | Downstream extension + upstream fork support | Forks an idle Agent Host-owned session into a new extension-host session. Not direct AHP control. |
| Get extension-host session wrapper | `getSession()` | Upstream internal | Returns `IReference<ICopilotCLISession>`; caller must dispose. Telegram UI paths avoid retaining it. |
| Create controller session | normal controller/session path + first native request | Upstream + Glue | Telegram does not own a parallel session object. |
| Session history/replay | upstream history + session bridge replay | Upstream + Copilot SDK | Replay seeds state; it is not emitted as new activity. |
| Prompt dispatch | `RemotePromptDispatcher` + native Copilot workbench command | Downstream + internal workbench | Required by current fork to obtain a real VS Code request/tool token. |
| Mid-turn steering | same native path, then upstream busy-session behavior | Upstream + SDK | Busy turns use immediate steering. |
| Abort | registry -> bound session `abort()` -> SDK | Downstream + SDK | Requires active registered capability/attachment. |

## 3. Remote-control framework mapping

| Capability | API/service | Status |
| --- | --- | --- |
| Transport registration | `IRemoteControlRegistry.registerTransport()` | Implemented |
| Session binding | `bindSession()` | Implemented |
| Attachment metadata | `getAttachments()` / attachment events | Implemented |
| Trusted request origin | `createRequestOrigin()` | Implemented |
| Mode validation | `getValidatedRemoteMode()` | Implemented |
| Permission fan-in | `requestPermission()` | Implemented |
| User-question fan-in | `requestUserInput()` | Implemented |
| Plan-exit fan-in | `requestExitPlanMode()` | Implemented |
| Abort | `abort(sessionId, transportId)` | Implemented |

`IRemoteControlRegistry` is an internal bundled-fork contract, not a public VS Code extension point.

## 4. Prompt lifecycle

Remote prompts use:

```text
setPendingCopilotCLIRequestContext(...)
    +
workbench.action.chat.openSessionWithPrompt.copilotcli
```

Dependency class: **internal workbench seam**.

The route is intentionally retained because it:

- creates a real `ChatRequest`,
- supplies the tool invocation token,
- carries selected-model configuration,
- keeps native chat rendering/lifecycle intact,
- reuses upstream steering behavior.

The returned command promise may represent the full turn. Remote dispatch is therefore fire-and-observe rather than synchronous request/response.

Direct SDK `send()` is not the current fallback because it would change the integration semantics.

See [ADR-0002](./adr/0002-use-native-vscode-request-lifecycle.md).

## 5. SDK event/interaction mapping

| Feature | SDK/upstream signal | Notes |
| --- | --- | --- |
| Assistant output | assistant message/delta events | Render only SDK-visible content. |
| Intent/reasoning summary | exposed assistant intent/reasoning events | Conditional on model/runtime; no hidden CoT claim. |
| Tool activity | tool execution start/progress/result/complete events | Correlated by tool-call identity and semantically aggregated. |
| Permission request | SDK permission request path | Telegram returns approve-once/deny only. |
| User question | SDK user-input request path | Choice and bounded freeform response. |
| Plan exit/approval | SDK exit-plan request path | Remote response type permits only non-elevating actions. |
| Subagent activity | SDK subagent events | Summarized rather than mixed into root assistant output. |
| Usage/context | SDK usage events where exposed | Bounded display only. |

SDK response methods remain owned by `CopilotCLISession`. Transports return correlated values through the registry; they do not receive the raw SDK session.

## 6. Model API mapping

| Capability | Current source | Dependency class | Notes |
| --- | --- | --- | --- |
| Native model catalogue | `ICopilotCLIModels` | Upstream internal/SDK | Reuse upstream model metadata. |
| VS Code LM catalogue | `vscode.lm.selectChatModels()` | Stable VS Code API | Merged into Telegram picker. |
| Native model selection | native selected model config | Upstream/internal workbench | Preserves Copilot path. |
| Configured VS Code LM execution | downstream authenticated loopback Responses bridge | Stable VS Code LM + downstream + SDK | Provider credentials remain in VS Code/provider implementation. |
| Reasoning effort | selected-model configuration + SDK model update | Upstream/internal + SDK | Offered only when catalogue metadata says supported. |

Model visibility is not a backend compatibility guarantee. vLLM, Ollama or another OpenAI-compatible backend should only be documented as compatible after the full agent/tool/permission/steering/abort matrix passes.

## 7. Stable VS Code APIs used by Telegram

Examples include:

- commands and activation,
- `SecretStorage`,
- `globalState`,
- workspace/resource APIs,
- QuickPick/InputBox/notifications,
- status bar,
- filesystem access used by the read-only workspace browser,
- `vscode.lm.selectChatModels()`,
- stable built-in commands where appropriate.

These capabilities do not depend on impersonating the official Copilot extension ID.

## 8. Proposed APIs and extension identity

The bundled Copilot implementation already uses proposed APIs. Proposal authorization is extension-ID/product sensitive.

Current consequences:

### Bundled downstream fork — current architecture

The modified Copilot code runs in the expected built-in/product context. Validate proposal availability in the built artifact. Do not require normal users of that build to edit `argv.json` for the bundled code.

### Own-ID fork-bundled companion — research architecture

An own-ID companion would need exact build-time proposal registration in product configuration. Proposal registration alone does **not** expose Copilot's internal session service or make the companion the native session provider.

### Own-ID standalone/private VSIX — research architecture

Runtime proposal enablement can make proposed VS Code APIs available for development/private experiments, but still does not provide a public equivalent of the internal Copilot session-control seam.

Therefore the custom-ID problem is not merely “enable the same proposals”. Session/provider ownership and internal Copilot service access remain separate constraints.

See [ADR-0004](./adr/0004-bundled-fork-before-standalone-extension.md).

## 9. Agent Host compatibility boundary

The current branch has limited Agent Host interoperability:

| Capability | Status |
| --- | --- |
| Discover Agent Host-owned local session metadata | **Implemented** |
| Show Agent Host sessions in Telegram `/sessions` | **Implemented** |
| Authorize them against current workspace scope | **Implemented** |
| Fork an idle Agent Host session for Remote Pilot | **Implemented** |
| Control the original live Agent Host session in-place | **Not implemented** |
| Connect Telegram directly as an AHP client | **Not implemented** |
| Control a source session still in use by VS Code | **Rejected** |

This distinction must remain explicit in docs and release notes.

See [ADR-0003](./adr/0003-agent-host-session-handover.md).

## 10. Telegram API contract

The current Telegram adapter covers the Bot API features required by the branch, including:

- `getMe`,
- `getUpdates`,
- `setMyCommands`,
- global chat-menu configuration,
- normal/rich message sending,
- live draft activity used by the current UI,
- message/reply-markup edits,
- callback queries,
- inline keyboards,
- optional persistent reply keyboard and explicit removal,
- native stop/update handling used by the current live-draft path,
- file APIs only where implemented/needed.

All Bot API envelopes and method-specific results should be validated before crossing into control logic.

Long polling is the default deployment model. Webhook hosting is not required.

## 11. High-risk dependencies

The following require focused compatibility tests on upstream sync:

- `workbench.action.chat.openSessionWithPrompt.copilotcli`,
- pending Copilot CLI request context shape/consumption,
- `ICopilotCLISessionService` internal interfaces,
- `CopilotCLISession` event/interaction behavior,
- Agent Host session ownership metadata/disk layout used for discovery,
- proposed chat-session APIs used by upstream,
- Copilot SDK event names/types used by the projector,
- model-selection configuration plumbing.

Never replace a broken high-risk seam with UI scraping or concrete SDK-session leakage merely to keep a build compiling.

## 12. Compatibility metadata

Every distributable development/release artifact should record at least:

```text
VS Code upstream/base commit
Copilot extension version
Copilot SDK/runtime version resolved by upstream
Telegram remote patch/revision
required proposed API set
matching VS Code build/version
artifact checksum
```

Compilation is necessary but not sufficient. Runtime acceptance is defined by [TEST_STRATEGY.md](./TEST_STRATEGY.md) and [PHASE8_ACCEPTANCE.md](./PHASE8_ACCEPTANCE.md).

## 13. External references

- Copilot SDK features: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features
- Copilot SDK streaming events: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events
- Copilot SDK steering/queueing: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing
- Copilot SDK session persistence: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence
- VS Code proposed APIs: https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- VS Code Extension API: https://code.visualstudio.com/api/references/vscode-api
- Telegram Bot API: https://core.telegram.org/bots/api