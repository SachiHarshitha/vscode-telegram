# Implementation Plan

## 1. Revalidated baseline

This plan was revalidated against the repository at:

| Item | Value |
| --- | --- |
| VS Code commit | `78d59cf49e13b49682661716ed5d8adece8f6348` |
| Copilot extension | `GitHub.copilot-chat` `0.63.0` |
| Copilot runtime package | `@github/copilot` `^1.0.73` |
| VS Code engine | `^1.135.0` |
| Node engine | `>=22.14.0` |
| Implementation status | Phases 0 through 5 implemented and validated; consent-gated setup, native visibility, session routing and bounded Telegram activity projection are active; interactive permission/question workflows remain deferred to Phase 6 |

The product release called “V1” in these documents is not the deprecated non-controller Copilot implementation. Product V1 targets the controller-based session API implemented by `CopilotCLIChatSessionContentProvider` in `copilotCLIChatSessions.ts`.

### Code findings that change the previous plan

| Finding in the current source | Planning consequence |
| --- | --- |
| `ChatSessionsContrib` selects the controller path only when `chat.cli.sessionController.enabled` is true; the upstream baseline default was false and Phase 0 changed the downstream default to true. The repository-local `AGENTS.md` says new work must use the controller path and that `registerCopilotCLIServicesV1` is deprecated. | The fork build must keep the controller path enabled. Telegram code will not be added to `copilotCLIChatSessionsContribution.ts`. |
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
  -> pairing + authorization + secret state
  -> consent/native visibility/local kill switch
  -> select/prompt/steer/abort end to end
  -> event projection
  -> permissions/questions/plan approval
  -> models/modes
  -> release hardening
```

Telegram-specific work does not begin until the native dispatcher and the transport-neutral registry have tests. A phase is not complete merely because it compiles; its exit tests are part of the phase.

## 3. Phase 0 — baseline, controller path and guardrails

**Status:** Implemented on the revalidated baseline. Post-change validation is recorded in `compatibility.json`.

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
extensions/copilot/src/extension/telegramRemote/common/telegramRemoteCompatibility.ts (new)
extensions/copilot/src/extension/telegramRemote/common/test/telegramRemoteCompatibility.spec.ts (new)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts
```

### Exit criteria

- The controller implementation is active in a normal downstream window.
- The extension has no Telegram network activity and no Telegram UI yet.
- Baseline build/test results and exact versions are recorded.

## 4. Phase 1 — native control seam and Mission Control generalization

**Status:** Implemented and validated on 2026-08-23. The controller host now composes the transport-neutral registry, native prompt dispatcher, and extracted Mission Control adapter. Telegram networking and UI remain intentionally absent until Phase 2.

### Implementation record

- Phase 1a uses random, bounded, expiring correlation entries and a non-model attached-context marker. Marker stripping happens at the controller participant boundary, while exact session/correlation matching controls access to the staged typed origin.
- The internal workbench command accepts explicit queued/steering intent, waits for the actual sent turn to complete, and throws both immediate and deferred rejections. `RemotePromptDispatcher` acknowledges acceptance immediately and observes the completion promise without a direct SDK fallback.
- Phase 1b exposes only the documented wrapper-lifetime bridge plus narrow existing session-service operations; the raw SDK session is private. Initializer-time attachment warnings cover transports attached before a response stream exists.
- Phase 1c registers arbitrary transports and logical per-session attachments, filters supported persisted replay events, buffers the live/replay overlap, preserves ordered fan-out, deduplicates IDs, repairs self-parent links, races responders with loser cancellation, and retains logical attachment across wrapper churn.
- Mission Control state, event export, polling, prompt dispatch, mode handling, permission/question correlation, QR/status UI, and teardown now live in `missionControlTransport.ts`/`missionControlQr.ts`. `copilotcliSession.ts` contains no Mission Control API client or poller.

### Validation record

| Check | Result |
| --- | --- |
| Extension typecheck | Passed: `npm run typecheck` (extension, simulation workbench, worker, and completions panel projects) |
| Phase 1 extension contracts | Passed: 9 files, 186 tests, 1 skipped; covers correlation, controller marker stripping, registry replay/order/dedup/fan-out, dispatcher failure cleanup, Mission Control prompt/mode/abort/permission/question/ack/retry/teardown, wrapper bridge, session service, API client, and initializer behavior |
| VS Code core typecheck | Passed: `npm run typecheck-client` |
| Full source build | Passed with zero errors: root `npm run compile`; the final Copilot bundle was rebuilt with `npm run compile` in `extensions/copilot` |
| Native command Electron suite | Passed: 30 tests; 13 unrelated pre-existing tests remain skipped |
| Runtime smoke | Passed in an isolated Code OSS profile with `--disable-workspace-trust --log=trace --log=GitHub.copilot-chat:trace`; `untrusted:false` and `remote-control-registry=ready` were observed |

The broad legacy participant suite's assertions pass, but its process currently exits nonzero because `test/simulation/cache/base.sqlite` is an unhydrated Git LFS pointer and Git LFS is not installed on this machine. Controller-path and Phase 1 contract suites do not depend on that fixture.

### Phase 1a — correlated native prompt dispatcher

Create a single transport-neutral dispatcher used by Mission Control and Telegram.

#### Files

```text
extensions/copilot/src/extension/telegramRemote/common/remoteControlTypes.ts                   (new)
extensions/copilot/src/extension/chatSessions/copilotcli/common/pendingRequestContext.ts       (modify)
extensions/copilot/src/extension/telegramRemote/vscode-node/remotePromptDispatcher.ts           (new)
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
extensions/copilot/src/extension/telegramRemote/common/remoteControlTypes.ts
extensions/copilot/src/extension/telegramRemote/node/remoteControlRegistry.ts                       (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/missionControlTransport.ts               (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/missionControlQr.ts                      (new)
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

**Status:** Implemented and validated on 2026-08-23. The controller host registers a dormant Telegram transport. It performs no production network activity until the Phase 3b consent/setup flow explicitly invokes the Phase 3 lifecycle entry points.

### Implementation record

- `TelegramBotClient` uses `IFetcherService`, JSON POST requests and the fetcher's abort signal. It validates every envelope and method result before returning typed users, updates or messages.
- The supported API subset is `getMe`, `getUpdates`, `sendMessage`, `editMessageText`, `editMessageReplyMarkup` and `answerCallbackQuery`; no Bot framework dependency was added.
- `TelegramService` owns one abortable long poll, ordered update handling, in-process deduplication, durable per-token offsets, `retry_after` handling and bounded exponential backoff.
- `telegramPollerLease.ts` uses an atomic `wx` lease file keyed by a truncated SHA-256 token fingerprint. The file contains only the fingerprint, PID, random nonce and timestamps; stale recovery requires both expiry and a dead owner process.
- Offset advancement occurs only after the update handler succeeds and the new offset has been persisted. A failed handler is retried without confirming the update.
- `TelegramRemoteContribution` registers the transport only in the supported controller host. Registration remains network-dormant; Phase 3 added explicit lifecycle entry points, and Phase 3b will be their first production caller after consent.
- All new Telegram TypeScript files live under `src/extension/telegramRemote` with downstream copyright ownership.

### Validation record

| Check | Result |
| --- | --- |
| Phase 2 PowerShell runner | Passed: 4 files, 18 tests via `script/telegram-remote/test-phase2.ps1` |
| HTTP mock-server contracts | Passed: authentication, success, empty poll, long-poll timeout response, abort, 401, 429/`retry_after`, 5xx and malformed JSON/update shapes |
| Polling lifecycle | Passed: deduplication, handler retry, durable offset, restart recovery, bounded backoff, disposal abort and lease release |
| Singleton lease | Passed: exclusive acquisition, ownership-safe release, live-owner refusal and conservative dead-owner recovery |
| Telegram Remote aggregate | Passed: 9 files and 42 tests; the one opt-in real-bot file/test was skipped |
| TypeScript / lint / extension bundle | Passed: `npm run typecheck`, targeted ESLint with zero warnings, and `npm run compile` |
| Source-workbench smoke | Passed: patch 3/controller/transport-ready marker observed with `--disable-workspace-trust`; no Telegram API traffic occurred |
| Real-bot harness | Added and skipped by default; opt in with a local `.env` and `test-phase2.ps1 -RealBot` |

### Files

```text
extensions/copilot/src/extension/telegramRemote/common/telegramTypes.ts             (new)
extensions/copilot/src/extension/telegramRemote/node/telegramBotClient.ts           (new)
extensions/copilot/src/extension/telegramRemote/node/telegramPollerLease.ts          (new)
extensions/copilot/src/extension/telegramRemote/node/telegramService.ts              (new)
extensions/copilot/src/extension/telegramRemote/node/telegramTransport.ts            (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteContribution.ts (new)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts            (composition)
extensions/copilot/src/extension/telegramRemote/node/test/telegramBotClient.spec.ts  (new)
extensions/copilot/src/extension/telegramRemote/node/test/telegramPollerLease.spec.ts (new)
extensions/copilot/src/extension/telegramRemote/node/test/telegramService.spec.ts    (new)
extensions/copilot/src/extension/telegramRemote/node/test/telegramBotClient.real.spec.ts (new, opt-in)
extensions/copilot/.env.sample                                                       (new)
extensions/copilot/script/telegram-remote/test-phase2.ps1                            (new)
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

### Real-bot smoke test

From `extensions/copilot`:

```powershell
Copy-Item .env.sample .env
# Fill TELEGRAM_BOT_TOKEN in .env. Optionally set TELEGRAM_TEST_CHAT_ID and
# TELEGRAM_REAL_TEST_SEND_MESSAGE=true to test sendMessage.
.\script\telegram-remote\test-phase2.ps1 -RealBot
```

The `.env` file is ignored by Git. The script accepts only the three variables in `.env.sample`, imports them only into its process, hides their values from output and runs the same production Bot API client used by the extension. Stop any other `getUpdates` poller for the same bot before the smoke test to avoid competing consumers.

## 6. Phase 3 — pairing, authorization and secret state

**Status:** Implemented and validated on 2026-08-23. The controller contribution now owns secure bot-token state, private-chat pairing, numeric identity authorization and opaque callback correlation. It still cannot auto-start: Phase 3b must collect the versioned consent and explicitly call the lifecycle entry points.

### Implementation record

- `TelegramAuthorization` stores the validated bot token only in VS Code `SecretStorage`. Device-local `globalState` contains only a versioned token fingerprint, random pairing ID, numeric user/chat IDs, bounded display metadata and the pairing timestamp.
- Pairing uses a 128-bit cryptographically random base64url challenge. It is token-bound, single-use, expires after five minutes by default and rate-limits failed attempts per numeric user/chat identity in a bounded window.
- The pre-authorization router recognizes only `/pair` messages. Eligibility requires a non-bot sender and a positive numeric user ID in a private chat with a positive numeric chat ID; groups, channels, bots and incomplete updates fail closed.
- Every non-pairing update passes through token-fingerprint and numeric user/chat authorization before the contribution can call an authorized-update handler. Session discovery is not reachable from this phase and will be added behind that handler in Phase 4.
- `TelegramCallbackRegistry` emits only a short opaque random nonce in `callback_data`. Server-side state binds pairing ID, user ID, chat ID, session ID, request ID, optional tool-call ID, typed action and expiry. Consumption is one-shot; mismatch does not consume the legitimate callback.
- Disable blocks incoming dispatch synchronously before aborting the poll. Disable, revoke, token rotation, failed/restarted connection and disposal invalidate pairing challenges and pending callbacks; revoke additionally removes the paired identity, while forget removes both pairing and secret token.
- Bot API response descriptions are not propagated into local errors, preventing remote response text from echoing credentials into logs. Token-bearing storage failures are converted to generic security-state errors.
- Production activation remains intentionally absent from Phase 3. The public `startPairing()` and `resumeStoredConnection()` methods are explicit integration points for the consent-gated Phase 3b setup contribution.

### Validation record

| Check | Result |
| --- | --- |
| Phase 3 PowerShell runner | Passed: 8 files, 44 tests via `script/telegram-remote/test-phase3.ps1`; includes Phase 2 transport regressions and the compatibility marker |
| Telegram Remote aggregate | Passed: 13 files and 64 tests |
| Pairing and authorization | Passed: valid, expired, replayed, token-mismatched, throttled, wrong-user, wrong-chat, group, bot, missing-identity, username-change, token-rotation, revoke and malformed-persistence cases |
| Callback security | Passed: opaque Bot API-sized data, expiry, replay, unknown nonce, identity/session/request/tool/action binding, request/session/global invalidation and bounded eviction |
| Secret/redaction boundary | Passed: SecretStorage-only raw token, no raw token in global-state serialization or local errors, generic logs, token-fingerprinted lease/state filenames |
| Contribution lifecycle | Passed: dormant registration, validate-before-store/start, authorization-before-dispatch, persistence failure, synchronous disable, revoke and callback invalidation |
| TypeScript / lint / extension bundle | Passed: extension typecheck, targeted ESLint with zero warnings and extension compile |
| Source-workbench smoke | Passed: patch 4 / Phase 3 security-ready marker observed with trust disabled and trace logging; Telegram networking remained inactive pending Phase 3b consent |

### Files

```text
extensions/copilot/src/extension/telegramRemote/node/telegramPairingService.ts  (new)
extensions/copilot/src/extension/telegramRemote/node/telegramAuthorization.ts   (new)
extensions/copilot/src/extension/telegramRemote/node/telegramCallbackRegistry.ts (new)
extensions/copilot/src/extension/telegramRemote/common/telegramTypes.ts          (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramBotClient.ts        (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramService.ts          (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramTransport.ts        (modify)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteContribution.ts (modify)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts        (diagnostic marker)
extensions/copilot/src/extension/telegramRemote/node/test/telegramAuthorization.spec.ts (new)
extensions/copilot/src/extension/telegramRemote/node/test/telegramPairingService.spec.ts (new)
extensions/copilot/src/extension/telegramRemote/node/test/telegramCallbackRegistry.spec.ts (new)
extensions/copilot/src/extension/telegramRemote/node/test/testTelegramSecurityState.ts (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/test/telegramRemoteContribution.spec.ts (modify)
extensions/copilot/script/telegram-remote/test-phase3.ps1                         (new)
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

- Only the paired private chat can reach the authorized-update/callback boundary; Phase 4 metadata and actions must be routed exclusively behind it.
- Expired/reused/wrong-user/wrong-chat challenges and callbacks fail closed.
- Token redaction tests cover errors, logs, persisted-state serialization and lease files. Phase 3b must add the equivalent assertion for its new status/setup UI.

## 7. Phase 3b — consent, native visibility and kill switch

**Status:** Implemented and validated on 2026-08-23. This phase remains the mandatory gate for every Telegram network start, attachment and prompt dispatch.

### Implementation record

- Five fail-closed user settings and localized commands cover enablement, activity detail, polling timeout, notifications and status-bar visibility. A true setting alone never starts networking.
- `TelegramConsent` persists a versioned token-and-machine/workspace-scope fingerprint. Setup writes pending consent before validation and commits it only after private-chat pairing is durable; restart restore requires the exact current token and scope.
- The native setup wizard presents the full modal risk disclosure with cancel as the default, accepts the bot token only in a password-masked input, validates it with `getMe`, and completes a single-use private-chat pairing challenge before enabling the setting.
- A stable status item exposes status, log, unpair and local Disable controls. Attached sessions override the optional status-bar visibility setting so remote control can never become locally invisible.
- Controller session-list entries render transport-neutral attachment icons/labels, and a live chat stream receives one warning that permission prompts may be answered remotely.
- Disable synchronously blocks dispatch, invalidates callbacks, detaches every Telegram session and cancels setup before waiting for poll/lease cleanup. The local block remains effective when cleanup fails offline.
- Telegram Bot API polling timeout is bounded to 1–50 seconds and defaults to 25 seconds.

### Validation record

| Check | Result |
| --- | --- |
| Phase 3b PowerShell runner | Passed: 14 files, 176 tests via `script/telegram-remote/test-phase3b.ps1` |
| Consent and setup security | Passed: direct-setting consent gate, exact-scope restart, cancel/decline rollback, password input, risk disclosure parity and token redaction |
| Visibility and kill switch | Passed: session-list/status-bar attachment state, in-chat warning, synchronous offline disable and no-hidden-indicator invariant |
| TypeScript / lint / extension bundle | Passed: extension typecheck, targeted ESLint with zero warnings and extension compile |
| Source-workbench smoke | Passed: patch 5 / Phase 3b marker and commands observed with workspace trust disabled; disabled status and masked setup input worked, with no Telegram network activity before consent |

### Files

```text
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramSetupWizard.ts (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramStatusBar.ts    (new)
extensions/copilot/src/extension/telegramRemote/node/telegramConsent.ts             (new)
extensions/copilot/src/extension/telegramRemote/common/remoteControlTypes.ts        (modify)
extensions/copilot/src/extension/telegramRemote/node/remoteControlRegistry.ts       (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramService.ts             (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramTransport.ts           (modify)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteContribution.ts (modify)
extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts (modify)
extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts   (modify)
extensions/copilot/src/platform/configuration/common/configurationService.ts        (modify)
extensions/copilot/package.json                                                      (modify)
extensions/copilot/package.nls.json                                                  (modify)
extensions/copilot/script/telegram-remote/test-phase3b.ps1                           (new)
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

**Status:** Implemented and validated on 2026-08-23. Authorized Telegram updates can now select an existing controller session and drive its native request path; activity/event projection remains intentionally deferred to Phase 5.

### Implementation record

- `TelegramCommandRouter` is registered only behind `TelegramRemoteContribution`'s numeric private-chat authorization boundary. It supports `/start`, `/status`, `/sessions`, `/deselect`, `/stop`, ordinary text and opaque inline callbacks.
- Session listing uses only `getAllSessions()` and selection/prompt validation uses only `getSessionItem()`. Telegram code never calls `getSession()`, creates a wrapper, casts to `CopilotCLISession` or accesses the SDK session.
- `TelegramSessionState` persists a bounded, versioned selection containing only numeric IDs, pairing ID, session ID, timestamp and the current consent-scope fingerprint. A selection from another workspace scope fails closed.
- Selecting a session creates the Telegram registry attachment; deselect, pairing revoke, disable and upstream deletion detach it. Restart restoration first revalidates metadata.
- Ordinary text creates a registry-trusted Telegram origin and dispatches through `RemotePromptDispatcher`. The native command always receives `queue: 'steering'`; the workbench and `CopilotCLISession` retain idle/busy and SDK `mode: 'immediate'` decisions.
- Accepted input receives an immediate plain-text acknowledgement with an opaque, request-bound Stop button. A failed acknowledgement is contained after dispatch so the Bot API update is not retried into a duplicate native prompt.
- Stop requires the current pairing, selected session and active dispatch correlation, consumes once and calls `IRemoteControlRegistry.abort()`. The registry reports false when no live wrapper is already bound, so Telegram never opens or mutates a session merely to abort it.
- Session picker generations, selection revisions and dispatch correlations reject stale callbacks. Session deletion invalidates callbacks, clears durable selection, detaches the indicator and sends an explicit authorized-chat notice.

### Validation record

| Check | Result |
| --- | --- |
| Phase 4 PowerShell runner | Passed: 19 files, 204 tests via `script/telegram-remote/test-phase4.ps1` |
| Selection isolation | Passed: metadata-only list/validation, opaque picker callbacks, workspace-scope binding, restart restore, deselect, revoke/disable suspension and deletion cleanup |
| Prompt and steering path | Passed: registry-created Telegram provenance, correlation marker, native command, forced steering queue, synchronous/deferred cleanup and no direct SDK fallback |
| Stop and idempotency | Passed: request/session/identity binding, one-shot/stale Stop rejection, no-live-wrapper result and accepted-prompt containment when acknowledgement fails |
| TypeScript / lint / extension bundle | Passed: extension typecheck, targeted ESLint with zero warnings and extension compile |
| Source-workbench smoke | Passed: patch 6 / Phase 4 routing-ready marker observed with workspace trust disabled; commands loaded while networking remained consent-gated |

### Files

```text
extensions/copilot/src/extension/telegramRemote/node/telegramCommandRouter.ts (new)
extensions/copilot/src/extension/telegramRemote/node/telegramSessionState.ts  (new)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteEnvironment.ts (new)
extensions/copilot/src/extension/telegramRemote/common/remoteControlTypes.ts   (modify)
extensions/copilot/src/extension/telegramRemote/node/remoteControlRegistry.ts  (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramService.ts        (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramTransport.ts      (modify)
extensions/copilot/src/extension/telegramRemote/vscode-node/remotePromptDispatcher.ts (modify)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteContribution.ts (modify)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts       (modify)
extensions/copilot/script/telegram-remote/test-phase4.ps1                       (new)
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

**Status:** Implemented and validated on 2026-08-23. The selected authorized chat now receives a bounded, editable activity card projected from the existing wrapper-lifetime registry feed; permission and question events remain registry workflows for Phase 6.

### Implementation record

- `remoteAgentEvent.ts` is the single typed projection boundary. It validates and bounds the exact `@github/copilot` 1.0.73 shapes used here, preserves event ID/timestamp/parent/agent metadata, distinguishes replay delivery from live delivery, and drops malformed, unknown and interactive request events.
- Revalidation corrected two stale planning assumptions: the pinned SDK exposes real `tool.execution_progress` and `tool.execution_partial_result` events, and its terminal turn event is `assistant.turn_end`, not `assistant.turn_complete`. The replay allowlist now uses those verified names through the shared projector contract.
- The registry marks persisted replay delivery explicitly, buffers/deduplicates replay/live overlap, keeps its attachment seen-ID and normalization windows bounded at 10,000 IDs, and uses wrapper-unique synthetic ID prefixes. Logical attachment state continues across wrapper recreation.
- `TelegramEventRenderer` covers assistant intent/text/exposed readable reasoning, tool start/progress/partial/complete, subagent lifecycle, session lifecycle/errors/usage and abort. Agent-scoped assistant streams are not mixed into the root response, and permission/user-input events are not rendered as generic cards.
- Activity output uses MarkdownV2 with complete dynamic-text escaping, conservative credential redaction, a maximum of eight recent actions, 12,000 response characters, 2,000 reasoning characters and four Bot API messages of at most 4,096 characters each.
- `TelegramActivityCoalescer` validates the current paired identity and selected session again at publish and flush time, compacts replay without per-event sends, caps edits to one flush per second, flushes final live output at the earliest permitted time, and cancels pending output on session switch, deselection, disable, revoke or identity change.
- `TelegramService`, `TelegramTransport` and `TelegramRemoteContribution` now expose the already-implemented Bot API edit primitive through narrow typed methods. The transport delegates registry publication only to the composition-owned coalescer.

### Validation record

| Check | Result |
| --- | --- |
| Phase 5 PowerShell runner | Passed: 22 files, 211 tests via `script/telegram-remote/test-phase5.ps1` |
| Projection contract | Passed: exact persisted/live variants, replay metadata, malformed/missing field rejection, interactive-event exclusion and pinned progress/turn names |
| Renderer snapshots | Passed: all supported variants, missing optionals, MarkdownV2 escaping, credential redaction, truncation and four-chunk Bot API bounds |
| Coalescer behavior | Passed: high-frequency delta collapse, one-second edit cap, bounded action/output memory, final flush, session switch cleanup, local block cancellation and sanitized API failures |
| Regression coverage | Passed: all Phase 4 routing, security, consent, transport, native dispatcher, Mission Control, wrapper bridge and controller-session tests |
| TypeScript / lint / extension bundle | Passed: extension typecheck, targeted ESLint with zero warnings and extension compile |
| Source-workbench smoke | Passed: patch 7 / Phase 5 activity-ready marker observed with workspace trust disabled; networking remained consent-gated and no Telegram API request was emitted |

### Files

```text
extensions/copilot/src/extension/telegramRemote/common/remoteAgentEvent.ts                (new)
extensions/copilot/src/extension/telegramRemote/node/telegramEventRenderer.ts             (new)
extensions/copilot/src/extension/telegramRemote/node/telegramActivityCoalescer.ts          (new)
extensions/copilot/src/extension/telegramRemote/common/remoteControlTypes.ts               (modify)
extensions/copilot/src/extension/telegramRemote/common/telegramTypes.ts                     (modify)
extensions/copilot/src/extension/telegramRemote/node/remoteControlRegistry.ts               (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramBotClient.ts                    (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramService.ts                      (modify)
extensions/copilot/src/extension/telegramRemote/node/telegramTransport.ts                    (modify)
extensions/copilot/src/extension/telegramRemote/vscode-node/telegramRemoteContribution.ts   (modify)
extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts                    (modify)
extensions/copilot/script/telegram-remote/test-phase5.ps1                                    (new)
```

### Implement

- Normalize only SDK event names/types verified in the pinned runtime. The pinned 1.0.73 schema exposes `assistant.message_delta`, `assistant.message`, `tool.execution_start`, `tool.execution_progress`, `tool.execution_partial_result`, `tool.execution_complete`, session lifecycle/usage, and subagent events.
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
extensions/copilot/src/extension/telegramRemote/**
```

The root `eslint.config.js` contains the path-scoped header rule for this downstream-owned directory. Existing upstream files retain the Microsoft header.

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
