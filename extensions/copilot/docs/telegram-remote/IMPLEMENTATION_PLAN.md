# Implementation Plan

## 1. Delivery strategy

Build the smallest end-to-end path first, then expand features without widening the upstream patch unnecessarily.

The first milestone is not a polished Telegram UI. It is proof that a Telegram message can control the **same Copilot CLI session object used by VS Code**, and that SDK events from that session can be projected back to Telegram.

## 2. Phase 0 — baseline and guardrails

### Tasks

- Record upstream commit/version metadata.
- Confirm the current Copilot extension builds/tests unchanged on the downstream branch.
- Add Telegram project docs and source directory skeleton.
- Confirm the current controller-path configuration (`registerCopilotCLIServices`) and record the V1/non-controller path as a later compatibility target.
- Confirm the initial packaging target is the VS Code fork with its bundled Copilot extension; do not require an independent extension ID for this milestone.
- Add a compile-time/downstream marker so logs identify the Telegram build.

### Exit criteria

- Clean upstream-equivalent build succeeds.
- No behavior changes yet.
- Documentation and compatibility baseline committed.

## 3. Phase 1 — remote-control registry and Mission Control migration

> **Sequencing note.** Phase 1 is split. The full registry plus Mission Control migration is the largest and least testable chunk in the project: proving "Mission Control unchanged" needs a real GitHub repository, permissive auth and a live Mission Control backend. Phase 1a first lands the two members that unlock a complete observe/prompt/steer/abort loop with no registry at all, so Telegram can be proven end to end before the migration starts. The registry is unavoidable only for interactive responses, because permission and question racing has exactly one occupied slot.

### Phase 1a — session event and abort seam

Add exactly two transport-neutral members to `ICopilotCLISession`:

```ts
readonly onDidReceiveSessionEvent: Event<SessionEvent>;
abort(): void;
```

Backed by a session-lifetime listener installed in the `CopilotCLISession` constructor (the 17 listeners in `_handleRequestImplInner` are request-scoped, and Mission Control's persistent listener is `/remote`-gated), plus a one-line delegation to the wrapped SDK `abort()`.

This adds no transport branch, no Telegram type and touches no Mission Control code. It is the same seam the registry consumes later.

#### Exit criteria

- A local dev command lists sessions, sends a prompt through the native path, receives SDK events between requests and aborts.
- Total upstream delta is roughly fifteen lines in `copilotcliSession.ts` plus one line in `chatSessions.ts`.

### Phase 1b — registry and Mission Control migration

### Goal

Create the N-transport seam before any Telegram-specific control logic is added. Mission Control must remain semantically compatible after moving behind the seam; duplicate remote event delivery is an existing defect to remove, not behavior to preserve.

### Source work

Create:

```text
src/extension/chatSessions/copilotcli/common/remoteControlTypes.ts
src/extension/chatSessions/copilotcli/node/remoteControlRegistry.ts
src/extension/chatSessions/copilotcli/node/missionControlTransport.ts
```

Modify:

```text
src/extension/chatSessions/vscode-node/chatSessions.ts
src/extension/chatSessions/copilotcli/node/copilotcliSession.ts
```

The `copilotcliSession.ts` change is deliberate: current permission/question handling is hard-coded to `_mcState`, most native SDK listeners are request-scoped, and `ICopilotCLISession` does not expose the required remote actions. Add only transport-neutral publication, response-race and safe-control hooks.

### Required sequence

1. Introduce `IRemoteControlTransport`, normalized remote request/event types and a discriminated `RemoteRequestOrigin`.
2. Introduce `RemoteControlRegistry` with per-session bindings, correlation and disposal.
3. Replace `source.startsWith('command-')` as an authorization/mode signal. Carry typed origin through pending request context and session input; serialize SDK `SendOptions.source` separately.
4. Move Mission Control event, permission and user-input integration behind a `MissionControlTransport` adapter while retaining its API client, buffering and polling behavior.
5. Consolidate request/persistent remote forwarding into one session-lifetime registry publication point with event-ID deduplication and self-parent protection.
6. Verify Mission Control command completion, prompt/steering, abort, permission and question semantics are unchanged while each SDK event is exported once.
7. Register an in-memory second transport in tests and prove event fan-out, first-valid permission/question resolution, prompt routing and abort with both transports present.
8. Prove registry teardown releases all listeners and pending requests.

### Session/reference lifecycle

- `getSession()`/`createSession()` return `IReference<ICopilotCLISession>`.
- A one-shot action disposes the reference in `finally`.
- A bound remote session stores the reference in the binding's `DisposableStore` and releases it on deselection, session deletion, transport disable or extension shutdown.
- Tests assert no use-after-dispose and no leaked reference after repeated attach/detach.

### Native prompt constraint

The in-memory transport sends prompts through:

```text
setPendingCopilotCLIRequestContext(...)
-> workbench.action.chat.openSessionWithPrompt.copilotcli
-> real ChatRequest/toolInvocationToken
-> CopilotCLISession.handleRequest(...)
```

Do not use direct SDK `send()` as the spike shortcut.

The workbench command's promise lasts until the agent response completes. Dispatch it without awaiting the turn, acknowledge the transport immediately and attach a rejection handler. Pending-context cleanup is correlated by session + origin/command ID so an older failure cannot clear a newer request.

### Exit criteria

- Mission Control semantic regression tests pass with exactly one export per SDK event.
- An in-memory second transport can observe and safely control the same session.
- A Telegram-origin request cannot inherit Mission Control `autopilot`, even when Mission Control is active in that mode or a transport payload contains a `command-*` string.
- No transport-specific branch has been added to `CopilotCLISession`.
- References/listeners are released deterministically.

## 4. Phase 2 — Telegram transport foundation

Create:

```text
telegramBotClient.ts
telegramService.ts
telegramTransport.ts
telegramTypes.ts
telegramSettings.ts
```

### Implement

- Bot API HTTPS wrapper or carefully selected dependency.
- `getMe` token validation.
- `getUpdates` long polling.
- update offset/deduplication.
- clean enable/disable lifecycle.
- singleton poller lease keyed by bot identity/token fingerprint,
- explicit rejection of a second consumer when a cross-process lease cannot be acquired,
- bounded retry/backoff.
- `sendMessage`.
- `editMessageText`.
- callback-query acknowledgement.

### Design preference

Avoid a large Telegram framework dependency unless it materially reduces security/lifecycle complexity. The required Bot API surface for V1 is small enough that a lightweight client is viable.

### Exit criteria

VS Code can send/receive Telegram messages reliably; stopping the contribution releases the lease; reload/re-enable and competing-host tests never produce duplicate pollers.

## 5. Phase 3 — pairing and authorization

Create:

```text
telegramPairingService.ts
telegramAuthorization.ts
```

### Implement

- secret storage for bot token,
- single-use expiring pairing code,
- numeric Telegram user-ID allowlist,
- `/pair` handling,
- unauthorized-user rejection,
- revoke/unpair local command,
- remote disable local command.

### Exit criteria

Only the paired user can query any session metadata or issue commands.

## 5a. Phase 3b — native VS Code UI, consent gate and kill switch

Local visibility and revocation must exist **before** a Telegram user can attach to a session. A session that is remotely controllable with no local indicator is a security defect, so this phase blocks Phase 4 rather than following the Telegram UX work.

Create:

```text
telegramStatusBar.ts
telegramSetupWizard.ts
remoteAttachmentIndicator.ts   (transport-neutral, lives with the registry)
```

Modify:

```text
src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts
```

### Implement

- `IRemoteControlRegistry.getAttachments()` / `onDidChangeAttachments` returning `{ transportId, label, themeIcon }`.
- `ChatSessionItem.description` + `tooltip` populated from that info, refreshed through the existing `refreshSession({ reason: 'update', sessionId })`.
- Status bar item with connecting/connected/attached/error states and a warning background while attached.
- QuickPick menu on the status bar item with *Disable remote access* reachable in one click.
- Modal consent gate on first enable, per [SECURITY.md](./SECURITY.md) section 20; cancel is the default action and declining persists nothing.
- Settings registered via `defineSetting()` with the abbreviated disclosure in `markdownDescription`; toggling `enabled` directly still routes through the consent gate.
- Setup wizard: consent → masked token entry → `getMe` validation → pairing challenge → confirmation.
- `stream.warning()` attach notice on the routed stream. Do not use `addUserAssistantMessage()`; it injects a synthetic assistant turn into the SDK session and the model's context.

### Exit criteria

- No entry point can enable the transport without passing the consent modal.
- An attached session shows an indicator in the session list and the status bar within one refresh cycle.
- Disabling from the status bar tears down the poller, releases the lease and clears indicators.
- `copilotCLIChatSessions.ts` contains no Telegram-specific string, icon or identity.

## 6. Phase 4 — session selection and prompting

Create:

```text
telegramCommandRouter.ts
telegramSessionState.ts
```

### Implement

- `/start` / home card,
- session list,
- inline session picker,
- selected-session state,
- status display,
- normal text prompt to an idle selected session through pending request context plus `workbench.action.chat.openSessionWithPrompt.copilotcli`,
- typed Telegram request origin created by the registry rather than accepted from Telegram input,
- immediate Telegram acknowledgement while the native command runs fire-and-forget,
- clear errors for missing/closed sessions.

### Exit criteria

A Telegram user can select a VS Code Copilot session and send a normal prompt through a real VS Code `ChatRequest`; the message appears in native chat and no direct SDK fallback exists.

## 7. Phase 5 — active-turn steering and abort

### Implement

- inspect upstream session status,
- treat normal Telegram text during an active turn as steering,
- reuse the same native command path so upstream busy-session handling selects `mode: 'immediate'`,
- Stop button/callback,
- stale callback protection.

### Exit criteria

A long-running agent task can be redirected and aborted from Telegram while remaining the same underlying VS Code session.

## 8. Phase 6 — event stream and live activity UI

Create:

```text
remoteAgentEvent.ts
telegramEventRenderer.ts
telegramActivityCoalescer.ts
```

Publish events through the registry's session-lifetime hook. Do not attach Telegram to the request-scoped listener store used by native chat rendering.

When attaching to an existing session, install a temporary-buffering live listener, obtain persisted events through the session bridge's `sdkSession.getEvents()`, replay only the supported event types in order, suppress duplicate IDs, flush unseen buffered events, then enter live mode. The SDK session itself remains hidden from Telegram code.

### Event classes

- assistant text/deltas,
- intent,
- reasoning where readable,
- tool start/progress/complete,
- session state,
- subagent state,
- usage/context,
- errors.

### Telegram rendering

Default compact status example:

```text
🤖 Copilot · <model>
<workspace> · <branch>

🧠 Investigating startup flow

Recent actions
├─ 📖 ProcessorFactory.ts
├─ 🔎 Search: CreateAsync
└─ 💻 dotnet test

⏱ Working…
```

Buttons:

```text
[ Stop ] [ Details ]
[ Model ] [ Session ]
```

### Performance requirements

- coalesce high-frequency deltas,
- cap status edit frequency,
- avoid unbounded event history,
- avoid exceeding Telegram message limits.

## 9. Phase 7 — permissions and agent questions

Create:

```text
telegramPendingRequestRegistry.ts
telegramPermissionBridge.ts
telegramUserInputBridge.ts
```

### Implement

- permission request rendering,
- Approve once / Deny callbacks,
- request/session/nonces correlation,
- expiration,
- first-valid-response semantics with local UI and every registered remote transport,
- user choice questions,
- freeform question replies,
- invalidation of resolved buttons.

Telegram V1 exposes only approve-once and deny. It MUST NOT call `setPermissionLevel()` or remotely select a mode that raises permission to `autoApprove`/`autopilot`.

### Exit criteria

A task can continue entirely from the phone through a permission/question cycle.

## 10. Phase 8 — models and modes

### Implement

- display selected model,
- enumerate current Copilot CLI model catalogue,
- model picker,
- safe model switching through current upstream API,
- display/select reasoning effort where supported,
- display agent mode,
- mode picker where supported.

### BYOK/local validation

Test separately with at least:

- normal GitHub-hosted Copilot model,
- OpenAI-compatible local/vLLM model configured through supported upstream provider path,
- Ollama provider if relevant.

Do not special-case local model agent tooling in Telegram. If a model is not compatible with the upstream Copilot agent runtime, report that limitation.

## 11. Phase 9 — optional V2 own-ID companion research

This phase is not on the critical path for V1. V1 runs inside the bundled Copilot extension and adds no third-party extension ID.

Before creating a V2 companion, verify that a supported Copilot session-control seam exists across the extension boundary. Product proposal authorization alone does not expose Copilot's internal services.

If a V2 own-ID extension is pursued, create:

```text
proposedApiSetup.ts
```

### Implement

- choose and record an extension ID owned by the project,
- declare the exact required proposals in the companion `package.json`,
- detect missing required proposal access safely,
- run the preflight before initializing any proposal-dependent service,
- fail closed with an actionable diagnostic.

For a companion bundled into the custom VS Code fork:

- add the exact extension ID and proposal list to `product.json#extensionEnabledApiProposals` at build time,
- add a build check that the product and manifest proposal lists match,
- never edit `product.json` during extension activation.

For a private standalone VSIX experiment:

- show a consent UI,
- locate runtime `argv.json`,
- perform a JSONC-preserving update with backup/rollback,
- add only this extension ID,
- require a full restart,
- verify availability after restart.

The current public `GitHub.copilot-chat` export is insufficient for that seam. Do not claim hosted Copilot authentication is allowed or blocked by Microsoft signing until a separate source/runtime investigation is complete.

## 12. Phase 10 — release hardening

### Implement

- diagnostic commands/log channel,
- release compatibility metadata,
- bundled-fork artifact packaging and optional explicitly scoped internal VSIX packaging,
- dependency/license inventory,
- checksums,
- upstream rebase CI,
- end-to-end regression suite,
- user-facing setup/readme documentation.

## 13. Suggested source touch points

### Expected modified upstream files

Phase 1a requires one narrow edit plus the composition-root line:

```text
src/extension/chatSessions/copilotcli/node/copilotcliSession.ts
src/extension/chatSessions/vscode-node/chatSessions.ts
```

Phase 1b rewires the interactive-response call sites in the same file. The native UI work adds one more:

```text
src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts
```

That edit sets `ChatSessionItem.description`/`tooltip` from registry attachment info and subscribes to `onDidChangeAttachments` to call the existing `refreshSession()`. It must remain transport-neutral — no Telegram label, icon or identity in this file.

### Possible additional seam edits

Only if required:

```text
src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts
package.json
```

Keep the `copilotcliSession.ts` patch narrow and transport-neutral. Its required responsibilities are event publication, interactive-response coordination and safe action binding; Telegram API types and rendering never enter this file.

## 14. Suggested configuration keys

Names are provisional and should follow upstream naming conventions.

```text
github.copilot.telegram.enabled
github.copilot.telegram.activityDetail
github.copilot.telegram.pollTimeout
github.copilot.telegram.notifications.enabled
github.copilot.telegram.statusBar.enabled
```

Register with `defineSetting()` in `platform/configuration/common/configurationService.ts` and mirror in `contributes.configuration`. `enabled` carries the abbreviated risk disclosure in its `markdownDescription` and still routes through the consent gate when toggled directly.

Do NOT put the bot token into a configuration key.

## 15. Suggested commands

Provisional:

```text
github.copilot.telegram.setup
github.copilot.telegram.testConnection
github.copilot.telegram.startPairing
github.copilot.telegram.revokePairing
github.copilot.telegram.disable
github.copilot.telegram.showStatus
github.copilot.telegram.showLog
github.copilot.telegram.statusBarMenu
github.copilot.telegram.configureProposedApi
github.copilot.telegram.openRuntimeArguments
```

All commands declare `enablement` clauses so pairing and disable actions do not appear in the palette while the feature is off. `statusBarMenu` is the status bar item's command and is not surfaced in the palette (`f1: false` equivalent).

## 16. Dependency decision

Before selecting a Telegram library, compare:

- direct Bot API implementation,
- grammY,
- Telegraf,
- other maintained Node libraries.

Decision criteria:

- bundle size,
- Node version compatibility with upstream Copilot extension,
- long-poll lifecycle control,
- callback typing,
- dependency/security history,
- ease of mocking,
- upstream maintenance activity.

V1 needs a small API subset; dependency minimization has real value inside an upstream-tracking fork.

## 17. Definition of done for each phase

A phase is complete only when:

- implementation compiles with upstream Copilot,
- tests cover the new behavior,
- no unrelated upstream functionality is duplicated,
- errors are visible and safe,
- session references, listeners and poller leases have deterministic ownership,
- Mission Control regression tests pass after registry changes,
- documentation is updated if the actual API differs from this plan,
- the downstream patch remains reviewable against upstream.
