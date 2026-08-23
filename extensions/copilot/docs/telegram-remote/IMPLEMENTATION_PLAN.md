# Implementation Plan

## 1. Revalidated baseline

This plan was revalidated against the repository at:

| Item | Value |
| --- | --- |
| VS Code commit | `2b514caa28dd1a2d41a4494a618b1188e03355ef` |
| Copilot extension | `GitHub.copilot-chat` `0.63.0` |
| Copilot runtime package | `@github/copilot` `^1.0.73` |
| VS Code engine | `^1.135.0` |
| Node engine | `>=22.14.0` |
| Implementation status | Design/docs only; no Telegram source exists yet |

The product release called “V1” in these documents is not the deprecated non-controller Copilot implementation. Product V1 targets the controller-based session API implemented by `CopilotCLIChatSessionContentProvider` in `copilotCLIChatSessions.ts`.

### Code findings that change the previous plan

| Finding in the current source | Planning consequence |
| --- | --- |
| `ChatSessionsContrib` selects the controller path only when `chat.cli.sessionController.enabled` is true; its current default is false. The repository-local `AGENTS.md` says new work must use the controller path and that `registerCopilotCLIServicesV1` is deprecated. | The fork build must explicitly enable the controller path. Telegram code will not be added to `copilotCLIChatSessionsContribution.ts`. |
| `pendingRequestContext.ts` stores one value per session and `clearPendingCopilotCLIRequestContext()` clears it without correlation. | Replace the session-only slot with correlation-ID entries. A local request or an older failed dispatch must not consume/clear a newer remote request. |
| `workbench.action.chat.openSessionWithPrompt.copilotcli` calls `chatService.sendRequest()` without a queue mode. While a request is active, `sendRequest()` can return `rejected` before `CopilotCLISession` gets a chance to use SDK `mode: 'immediate'`. The action also ignores rejected results. | Extend the internal action with an explicit `queue: 'steering'` option and throw on rejected dispatch. Remote prompting cannot be considered proven until this path is tested. |
| The internal command already accepts `attachedContext`, and `ChatRequest.references` preserves each reference ID. | Carry an opaque correlation marker through `attachedContext`; the Copilot participant consumes it before prompt resolution. This gives exact request-to-context matching without putting a nonce in model-visible prompt text. |
| `ICopilotCLISession` does not expose SDK events, abort, replay, mode, or model mutation. | Add a small transport-neutral session bridge. Telegram never casts to `CopilotCLISession` or retains `sdkSession`. |
| `CopilotCLISession` currently has a request-scoped wildcard listener and a second persistent Mission Control wildcard listener. | Publish through one wrapper-lifetime wildcard listener and deduplicate by SDK event ID in the registry. Remove both Mission Control publication paths during migration. |
| `ICopilotCLISessionService.getSession()` requires full workspace/model/agent options; on a cached wrapper it selects or clears the custom agent. | Session selection must not call `getSession()` with guessed/incomplete options. Registry attachment is logical state; live safe controls register only for the lifetime of a wrapper created by the native request path. |
| The controller provider creates session-list items in `copilotCLIChatSessions.ts`; `description` and `tooltip` are currently unused there. | The native attachment indicator belongs in this file, not the deprecated `copilotCLIChatSessionsContribution.ts`. |
| Model catalog/read APIs exist, but selected-model mutation is private to `CopilotCLISession.updateModel()` and the SDK session. | Ship model visibility first. Remote selection must be carried as a validated per-request model option through the native workbench command; do not add a raw SDK setter as a shortcut. |
| Settings in this subsystem use the `github.copilot.chat.cli.*` namespace. | Use `github.copilot.chat.cli.telegram.*`, not `github.copilot.telegram.*`. |
| The modified Copilot extension is built in and already declares `chatSessionsProvider` and the other required proposals. | Product V1 needs no new extension ID and no `argv.json` mutation. Own-ID proposal work remains optional V2 research. |

## 2. Delivery and dependency order

Build the smallest secure path in this order:

```text
baseline/controller lock
  -> correlated native prompt dispatcher
  -> session bridge + remote-control registry
  -> Mission Control migration
  -> Telegram polling
  -> pairing + consent/local kill switch
  -> select/prompt/steer/abort end to end
  -> event projection
  -> permissions/questions/plan approval
  -> models/modes
  -> release hardening
```

Telegram-specific work does not begin until the native dispatcher and the transport-neutral registry have tests. A phase is not complete merely because it compiles; its exit tests are part of the phase.

## 3. Phase 0 — baseline, controller path and guardrails

### Code and metadata changes

- Add machine-readable compatibility metadata containing the baseline values above, the enabled API proposal list, and a Telegram patch revision.
- Add a downstream build marker used only in diagnostics/logs.
- Enable `ConfigKey.Advanced.CLISessionController` in the downstream fork and mirror the default in `package.json`. Keep the deprecated implementation available only as an upstream fallback, not as a Telegram target.
- Do not start Telegram in an Agent Sessions workspace for product V1. Multi-extension-host ownership is deferred; the poller lease in Phase 2 still protects multiple ordinary windows.
- Add a compatibility assertion that Telegram contribution registration occurs only in `registerCopilotCLIServices()`.
- Record a clean baseline typecheck and the existing Copilot CLI unit-test result before behavioral edits.

### Files

```text
extensions/copilot/src/platform/configuration/common/configurationService.ts
extensions/copilot/package.json
extensions/copilot/docs/telegram-remote/compatibility.json       (new)
```

### Exit criteria

- The controller implementation is active in a normal downstream window.
- The extension has no Telegram network activity and no Telegram UI yet.
- Baseline build/test results and exact versions are recorded.

## 4. Phase 1 — native control seam and Mission Control generalization

### Phase 1a — correlated native prompt dispatcher

Create a single transport-neutral dispatcher used by Mission Control and Telegram.

#### Files

```text
extensions/copilot/src/extension/chatSessions/copilotcli/common/remoteControlTypes.ts          (new)
extensions/copilot/src/extension/chatSessions/copilotcli/common/pendingRequestContext.ts       (modify)
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/remotePromptDispatcher.ts  (new)
extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts              (modify)
src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts                   (narrow modify)
```

#### Required behavior

- Define a registry-created discriminated `RemoteRequestOrigin`; transport input cannot provide or overwrite it.
- Store pending contexts by a random correlation ID and validate both correlation ID and session ID when taking one.
- Put a non-model correlation marker in the command's `attachedContext`. `resolveInput()` finds the marker in `ChatRequest.references`, consumes exactly that context, and does not forward the marker to the prompt resolver or SDK.
- Make set/take/clear operations idempotent and correlation-specific. Expire abandoned contexts and bound the store.
- Extend `workbench.action.chat.openSessionWithPrompt.<type>` options with `queue?: 'queued' | 'steering'`, forward it to `chatService.sendRequest()`, and surface `rejected` results as command failures.
- The remote dispatcher uses `queue: 'steering'`. Core sends immediately when idle and requests the active handler to yield when busy; the next real `ChatRequest` then reaches the existing `CopilotCLISession` steering branch and SDK `mode: 'immediate'`.
- Dispatch without awaiting the full turn, acknowledge the transport immediately, observe rejection, and clear/report only the matching correlation ID.
- Keep SDK `SendOptions.source` as telemetry/correlation data only. Permission and mode decisions use typed origin.
- Do not implement direct SDK `send()` fallback.

#### Exit criteria

- Two rapid remote requests to one session consume their own contexts in order without overwrite.
- A local request interleaved with a remote request cannot consume the remote origin.
- An active native turn yields, receives a second real `ChatRequest`, and reaches `send({ mode: 'immediate' })` on the same session.
- A rejected/unknown/read-only session dispatch produces an observable error rather than a false success.

### Phase 1b — wrapper-lifetime session bridge

Add only transport-neutral members to `ICopilotCLISession`:

```ts
readonly onDidReceiveSessionEvent: Event<SessionEvent>;
getReplayEvents(): readonly SessionEvent[];
abort(): Promise<void>;
notifyRemoteAttachment(label: string): void;
getCurrentMode(): string | undefined;
```

`getSelectedModelId()` already exists and remains the model read seam.

#### Required behavior

- Install one wildcard SDK listener in the `CopilotCLISession` constructor, register its disposer immediately, log the event once, and fire `onDidReceiveSessionEvent`.
- `getReplayEvents()` returns a read-only snapshot from `sdkSession.getEvents()`; the raw SDK session remains private.
- `abort()` delegates to and awaits the SDK abort operation.
- `notifyRemoteAttachment()` writes a localized warning through the existing stream router and safely no-ops when no stream is attached.
- Remove Mission Control publication from the request-scoped wildcard listener after its adapter subscribes to the bridge.
- Register live safe controls with the registry for wrapper lifetime. Logical transport attachment persists separately by session ID, so Telegram does not retain a guessed `IReference<ICopilotCLISession>` between turns.
- After `CopilotCLIChatSessionInitializer` attaches the response stream, query the registry and call `notifyRemoteAttachment()` once when the session has a logical remote attachment. Registration can happen before a stream exists, so the registry-binding path must not be the only notification trigger.

#### Files

```text
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts   (only for registry binding/read helpers)
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/copilotCLIChatSessionInitializer.ts
extensions/copilot/src/extension/chatSessions/copilotcli/node/test/copilotcliSession.spec.ts
```

#### Exit criteria

- A fake transport observes session events outside the request-scoped renderer, reads replay through the bridge, and aborts exactly once.
- Wrapper disposal unregisters controls/listeners; selecting an idle session does not create or mutate a session wrapper.
- No new public access to `sdkSession` is added.

### Phase 1c — remote-control registry and Mission Control migration

#### Files

```text
extensions/copilot/src/extension/chatSessions/copilotcli/common/remoteControlTypes.ts
extensions/copilot/src/extension/chatSessions/copilotcli/node/remoteControlRegistry.ts             (new)
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/missionControlTransport.ts     (new)
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts                   (modify)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts                             (composition)
```

The Mission Control adapter is in `vscode-node`, not `node`, because it invokes the native VS Code command path and owns `/remote` UI. Its API client remains in `node/missionControlApiClient.ts`.

#### Required behavior

- Register any number of transports and logical per-session attachments.
- Keep live session controls separate from logical attachments; loss of a wrapper makes abort unavailable but does not silently deselect the Telegram session.
- Fan out normalized events in order. Deduplicate upstream event IDs and reject/repair `parentId === id` before transport delivery.
- Replay by installing the live listener first, buffering, reading `getReplayEvents()`, filtering supported persisted event types, publishing unseen events, then flushing unseen buffered events.
- Coordinate permission, user-input, and later plan-response races with first-valid-response-wins and cancellation of losing responders.
- Move Mission Control state, buffering, export, polling, command parsing, prompt dispatch, permission/question waiters, QR/status UI, and teardown out of `CopilotCLISession`.
- Preserve `/remote` through a generic remote-command handler registration rather than a Telegram or Mission Control branch in agent execution logic.
- Only a registry-created `missionControl` origin may apply Mission Control mode. A Telegram origin remains non-elevated regardless of its payload or `source` string.
- Keep the Mission Control adapter alive independently of wrapper churn and route its prompt commands through `RemotePromptDispatcher`.

#### Exit criteria

- Mission Control prompt, steering, abort, permission, question, replay, completion acknowledgement, and teardown tests pass.
- Each SDK event is exported once, including while a native request is active.
- An in-memory second transport can attach concurrently without changing Mission Control semantics.
- `copilotcliSession.ts` contains no transport API client, poller, or transport-specific permission branch.

## 5. Phase 2 — Telegram Bot API transport

### Files

```text
extensions/copilot/src/extension/telegramRemote/common/telegramTypes.ts             (new)
extensions/copilot/src/extension/telegramRemote/node/telegramBotClient.ts           (new)
extensions/copilot/src/extension/telegramRemote/node/telegramPollerLease.ts          (new)
extensions/copilot/src/extension/telegramRemote/node/telegramService.ts              (new)
extensions/copilot/src/extension/telegramRemote/node/telegramTransport.ts            (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteContribution.ts (new)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts            (composition)
```

### Implement

- Use the existing `IFetcherService` and its abort controller so proxy/certificate/network behavior matches the extension.
- Implement the small Bot API subset: `getMe`, `getUpdates`, `sendMessage`, `editMessageText`, `editMessageReplyMarkup`, and `answerCallbackQuery`.
- Validate Telegram envelopes and `ok/result` shapes at the boundary; never let unvalidated JSON become control commands.
- Advance the update offset only after an update has been accepted for bounded processing; deduplicate update IDs.
- Abort the in-flight long poll on disable/disposal and use bounded exponential backoff with Telegram `retry_after` handling.
- Implement a cross-process, token-fingerprint lease using an atomic create operation, owner PID/nonce, heartbeat, and conservative stale recovery. Never put the bot token or full request URL in logs.
- Keep dependencies at zero unless a documented comparison shows a framework reduces lifecycle/security risk enough to justify its bundle and transitive dependencies.

### Exit criteria

- Mock-server tests cover success, empty poll, timeout, abort, 401, 429, 5xx, malformed JSON, restart, and offset recovery.
- A second host fails visibly before calling `getUpdates` for the same token.
- Disabling or disposing the contribution aborts polling and releases the verified lease.

## 6. Phase 3 — pairing, authorization and secret state

### Files

```text
extensions/copilot/src/extension/telegramRemote/node/telegramPairingService.ts  (new)
extensions/copilot/src/extension/telegramRemote/node/telegramAuthorization.ts   (new)
extensions/copilot/src/extension/telegramRemote/node/telegramCallbackRegistry.ts (new)
```

### Implement

- Store the bot token in `IVSCodeExtensionContext.secrets`, following the BYOK storage pattern. Do not store it in configuration, global state, telemetry, or logs.
- Generate a cryptographically random, single-use, expiring pairing challenge with attempt throttling.
- Accept `/pair` before authorization only in a Telegram private chat.
- Bind authorization to both numeric `from.id` and the private `chat.id`; reject channels, anonymous senders, bots, groups, and missing identity fields in product V1.
- Store only non-secret paired identity metadata in extension global state.
- Authorize before session lookup so an unauthorized sender cannot learn whether a session exists.
- Correlate callbacks by paired identity, session ID, request ID, action, random nonce, and expiry; make callbacks one-shot.
- Add local revoke and disable operations that invalidate pending callbacks immediately.

### Exit criteria

- Only the paired private chat can list metadata or issue actions.
- Expired/reused/wrong-user/wrong-chat challenges and callbacks fail closed.
- Token redaction tests cover errors, logs, snapshots, status UI, and lease files.

## 7. Phase 3b — consent, native visibility and kill switch

This phase blocks remote attachment and prompt dispatch.

### Files

```text
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramSetupWizard.ts (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramStatusBar.ts    (new)
extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts (modify)
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/copilotCLIChatSessionInitializer.ts (modify)
extensions/copilot/src/platform/configuration/common/configurationService.ts        (modify)
extensions/copilot/package.json                                                      (modify)
extensions/copilot/package.nls.json                                                  (modify)
```

### Implement

- Register settings under `github.copilot.chat.cli.telegram.*` with matching `defineSetting()` entries and localized manifest descriptions.
- Use a versioned global consent record. A true setting alone never starts networking; the poller starts only after consent exists and token validation succeeds.
- If the setting is toggled directly, show the modal before starting. Decline/cancel restores disabled state and persists neither consent nor token.
- Setup flow: disclosure/consent -> masked token -> `getMe` -> pairing challenge -> confirmation.
- Render session attachment state in controller-based `CopilotCLIChatSessionContentProvider.toChatSessionItem()` using `description` and `tooltip`, and refresh it through `refreshSession({ reason: 'update', sessionId })` on attachment changes.
- Render a stable status bar item for connecting/connected/attached/error. Its command opens a QuickPick with Disable Remote Access directly available.
- Local disable first blocks new dispatch, invalidates callbacks, detaches sessions, aborts the poll, then releases the lease and clears indicators.
- Immediately after the native initializer attaches a live response stream, emit one localized in-chat warning through `notifyRemoteAttachment()` when the registry reports a logical attachment. Never call `addUserAssistantMessage()` for UI notices.
- Keep `copilotCLIChatSessions.ts` transport-neutral: it renders attachment labels/icons supplied by the registry and contains no Telegram-specific string or identity.

### Exit criteria

- No command, configuration change, restart, or error-recovery path starts Telegram without the current consent version.
- Attached state appears in the session list and status bar within one registry refresh.
- The local kill switch works while the network is unavailable and leaves no active dispatcher, callback, poll, lease, or indicator.

## 8. Phase 4 — session selection, prompt, steering and abort

### Files

```text
extensions/copilot/src/extension/telegramRemote/node/telegramCommandRouter.ts (new)
extensions/copilot/src/extension/telegramRemote/node/telegramSessionState.ts  (new)
```

### Implement

- `/start`, status, session list, inline selection, deselection, and explicit errors for deleted/closed sessions.
- List with `getAllSessions()` and validate selection with `getSessionItem()`; neither operation acquires a live wrapper.
- Store logical selected-session state per paired chat in Telegram-owned state and reflect it as a registry attachment.
- Route normal text through `RemotePromptDispatcher` with a registry-created Telegram origin and immediate acknowledgement.
- Always request the native steering queue; the workbench decides idle versus busy, and `CopilotCLISession` remains the only code that chooses SDK `mode: 'immediate'`.
- Add Stop callback protection and call the registry's currently registered live control. If there is no live abortable wrapper, return “no active task” rather than acquiring/mutating a session.
- Detach selection on upstream session deletion and reject stale session buttons.

### Exit criteria

- A Telegram prompt appears as a real native VS Code chat request with a real tool token.
- Text during a long-running turn steers that same wrapper and is not rejected by the workbench queue.
- Stop aborts once; stale Stop cannot target a later/different session.
- There is no direct SDK send, concrete-session cast, or remote `getSession()` call.

## 9. Phase 5 — event projection and Telegram activity UI

### Files

```text
extensions/copilot/src/extension/chatSessions/copilotcli/common/remoteAgentEvent.ts       (new)
extensions/copilot/src/extension/telegramRemote/node/telegramEventRenderer.ts             (new)
extensions/copilot/src/extension/telegramRemote/node/telegramActivityCoalescer.ts          (new)
```

### Implement

- Normalize only SDK event names/types verified in the pinned runtime. The current source uses `assistant.message_delta`, `assistant.message`, `tool.execution_start`, `tool.execution_complete`, session lifecycle/usage, and subagent events; do not invent a tool-progress event when the SDK does not expose one.
- Separate persisted replay types from ephemeral live types.
- Preserve upstream event ID/timestamp when present and maintain a bounded per-binding seen-ID window across wrapper recreation.
- Coalesce deltas, cap Telegram edit frequency, cap recent actions/history, split output within Bot API limits, and escape Telegram formatting.
- Render useful observable output only; never claim hidden chain-of-thought.
- Treat interactive request events as registry workflows, not duplicate generic activity cards.

### Exit criteria

- Replay/live overlap and wrapper recreation publish each supported event once.
- High-frequency output produces bounded memory and bounded Bot API edits.
- Renderer snapshot tests cover Markdown escaping, truncation, missing fields, and all supported event variants.

## 10. Phase 6 — permissions, questions and plan-exit responses

### Files

```text
extensions/copilot/src/extension/telegramRemote/node/telegramPermissionBridge.ts (new)
extensions/copilot/src/extension/telegramRemote/node/telegramUserInputBridge.ts  (new)
extensions/copilot/src/extension/telegramRemote/node/telegramPlanBridge.ts       (new)
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts (response-race modify)
```

### Implement

- Race the existing local permission UI with all attached remote responders; exactly one valid response reaches `respondToPermission()`.
- Telegram exposes only `approve-once` and `denied-interactively-by-user`. It cannot call `setPermissionLevel()`.
- Race local and remote `user_input.requested` responses, supporting validated choices and a state-bound freeform next reply.
- Invalidate Telegram buttons/reply state when any responder wins or the request/token is cancelled.
- Add the same registry race to `exit_plan_mode.requested`. Telegram may select only SDK actions that do not elevate permission (`interactive` or `exit_only`) or deny/provide feedback; never expose `autopilot` or `autopilot_fleet`.
- Support concurrent requests by session ID + SDK request ID + tool-call ID where present; never use display text as correlation.

### Exit criteria

- Local, Mission Control, and Telegram race tests prove one SDK response per request.
- Wrong-session/user/nonce/expired callbacks cannot resolve a request.
- A Telegram-origin prompt remains interactive even while Mission Control is in autopilot.

## 11. Phase 7 — models, reasoning effort and safe modes

### Stage A — read-only visibility

- Enumerate models through `ICopilotCLIModels.getModels()` and read the active wrapper with `getSelectedModelId()`.
- Add a read-only session-service helper for an inactive session's selected model if needed; reuse the transient `getEvents()/getSelectedModel()/closeSession()` pattern in `getChatHistoryImpl()` rather than exposing the SDK session.
- Display current mode from the session bridge only when known.

### Stage B — validated per-request selection

- Extend the internal workbench command options with `userSelectedModelId` and `userSelectedModelConfiguration`, forwarding them to `chatService.sendRequest()`.
- Validate model ID and reasoning effort against `ICopilotCLIModels` before storing a Telegram-side preference.
- Apply the preference to the next Telegram prompt through the real `ChatRequest`; `CopilotCLIChatSessionInitializer.resolveModel()` and `CopilotCLISession.updateModel()` remain authoritative.
- Reflect the actual selected model after dispatch. A native user change may supersede Telegram state and must be shown rather than silently overwritten.
- Expose only non-elevating mode operations. Product V1 may enter plan/interactive through supported request semantics; it must not offer remote `autoApprove`, `autopilot`, or `autopilot_fleet`.
- Validate GitHub-hosted and configured BYOK/local providers through the same upstream catalog/runtime. Add no Telegram-specific provider stack.

### Exit criteria

- Unsupported/stale model and reasoning choices fail visibly before dispatch.
- A remote model preference arrives on the native `ChatRequest` and the SDK-selected model matches afterward.
- Local/BYOK compatibility is reported only for backends that pass the full prompt/tool/permission/steering/abort matrix.

## 12. Phase 8 — release hardening

### Implement

- Redacted output channel and diagnostics commands.
- Rate limits and bounded queues for messages, callbacks, pairing, and Bot API retries.
- Compatibility report with commit, extension/runtime versions, proposal list, test results, OS, and patch revision.
- Dependency/license inventory, notices, artifact checksums, bundled-fork packaging, and clean-profile setup docs.
- Rebase CI that runs targeted Copilot CLI tests, Telegram tests, controller/native-dispatch integration, Mission Control regression, typecheck, and packaging smoke tests.
- Manual acceptance covering consent, pairing, prompt, steering, permission, question, plan exit, abort, Mission Control coexistence, disable, reload, and competing host.

### Exit criteria

- Every P0 requirement and security acceptance test passes on a clean bundled build.
- Telegram disabled produces no Telegram network request, listener, or status item.
- The release contains exact compatibility metadata and no secret test data.

## 13. Optional Phase 9 — own-ID companion research

This is not on the product V1 critical path. Do not create a companion until an upstream-supported Copilot session-control boundary exists across extension IDs.

If pursued:

- Fork-bundled companion: declare proposals in its manifest and add the exact owned extension ID with a matching list to `product.json#extensionEnabledApiProposals` at build time.
- Private standalone experiment: use explicit consent, JSONC-preserving `argv.json` update, backup/rollback, full restart, and fail-closed preflight.
- Proposal authorization alone does not expose `ICopilotCLISessionService`, the registry, or the native prompt dispatcher.
- Do not claim hosted Copilot entitlement behavior without a separate runtime/authentication investigation.

## 14. Authoritative source touch list

### Required upstream edits

```text
src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts
extensions/copilot/src/extension/chatSessions/copilotcli/common/pendingRequestContext.ts
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/copilotCLIChatSessionInitializer.ts
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts
extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts
extensions/copilot/src/platform/configuration/common/configurationService.ts
extensions/copilot/package.json
extensions/copilot/package.nls.json
```

`copilotCLIChatSessionsContribution.ts` is explicitly out of scope because it is the deprecated non-controller implementation.

### Downstream-owned directories

```text
extensions/copilot/src/extension/chatSessions/copilotcli/common/remoteControlTypes.ts
extensions/copilot/src/extension/chatSessions/copilotcli/common/remoteAgentEvent.ts
extensions/copilot/src/extension/chatSessions/copilotcli/node/remoteControlRegistry.ts
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/remotePromptDispatcher.ts
extensions/copilot/src/extension/chatSessions/copilotcli/vscode-node/missionControlTransport.ts
extensions/copilot/src/extension/telegramRemote/**
```

## 15. Configuration and commands

### Configuration

```text
github.copilot.chat.cli.telegram.enabled
github.copilot.chat.cli.telegram.activityDetail
github.copilot.chat.cli.telegram.pollTimeout
github.copilot.chat.cli.telegram.notifications.enabled
github.copilot.chat.cli.telegram.statusBar.enabled
```

The bot token is never a setting. Poll timeout and rate-limit values must have strict validators and safe bounds.

### Commands

```text
github.copilot.cli.telegram.setup
github.copilot.cli.telegram.testConnection
github.copilot.cli.telegram.startPairing
github.copilot.cli.telegram.revokePairing
github.copilot.cli.telegram.disable
github.copilot.cli.telegram.showStatus
github.copilot.cli.telegram.showLog
github.copilot.cli.telegram.statusBarMenu
```

All labels/descriptions are localized. `statusBarMenu` is not shown in the command palette. Enablement clauses improve discoverability, but handlers still enforce consent/authorization because UI enablement is not a security boundary.

## 16. Validation map

| Change | Minimum validation |
| --- | --- |
| Pending context/dispatcher | Targeted participant tests for marker correlation, cleanup, rejection, idle and steering queue |
| Workbench action queue option | Core chat-session action test proving queued/steering/rejected behavior |
| Session bridge/registry | `copilotcliSession.spec.ts` plus new registry tests for replay, dedup, disposal and response races |
| Mission Control extraction | Existing Mission Control session/API tests plus adapter regression tests with a second fake transport |
| Telegram client/poller | Mock HTTP tests with fake timers and cross-process lease tests |
| Pairing/security | Parser, authorization, callback, consent and redaction unit tests |
| Native indicators | `copilotCLIChatSessions.spec.ts` and contribution/status-bar tests |
| Full extension changes | `npm run typecheck` and the smallest matching `npm run test:unit -- <test files>` from `extensions/copilot` |
| Core VS Code change | Targeted core unit test; run broader compile/typecheck only if the targeted test exposes a dependency issue |
| Release candidate | Clean bundled launch, extension-host smoke test, manual Telegram scenario and Mission Control coexistence run |

## 17. Definition of done for every phase

A phase is complete only when:

- implementation and targeted tests pass,
- errors are visible and fail closed,
- disposables are registered at creation and lifecycle ownership is tested,
- no transport-specific type enters model/tool/worktree/session execution code,
- no raw SDK session reaches Telegram code,
- no accepted control message can be silently dropped,
- local UI and Mission Control regressions for the touched seam pass,
- the plan/API matrix is updated if the real source contract changes,
- the downstream patch remains narrow and reviewable against upstream.
