# Implementation Plan

## 1. Delivery strategy

Build the smallest end-to-end path first, then expand features without widening the upstream patch unnecessarily.

The first milestone is not a polished Telegram UI. It is proof that a Telegram message can control the **same Copilot CLI session object used by VS Code**, and that SDK events from that session can be projected back to Telegram.

## 2. Phase 0 — baseline and guardrails

### Tasks

- Record upstream commit/version metadata.
- Confirm the current Copilot extension builds/tests unchanged on the downstream branch.
- Add Telegram project docs and source directory skeleton.
- Decide downstream extension ID for test builds.
- Add a compile-time/downstream marker so logs identify the Telegram build.

### Exit criteria

- Clean upstream-equivalent build succeeds.
- No behavior changes yet.
- Documentation and compatibility baseline committed.

## 3. Phase 1 — session integration spike

### Goal

Prove access to existing Copilot CLI sessions from a downstream contribution.

### Source work

Create:

```text
src/extension/telegramRemote/node/telegramRemoteContribution.ts
src/extension/telegramRemote/node/remoteControlCoordinator.ts
```

Modify the narrow composition root in:

```text
src/extension/chatSessions/vscode-node/chatSessions.ts
```

Instantiate `TelegramRemoteContrib` with the same child `IInstantiationService` that owns `ICopilotCLISessionService` and related Copilot CLI services.

### Spike functionality

- log session create/change/delete events,
- call `getAllSessions()`,
- obtain a session reference using `getSession()`,
- inspect session ID/title/status/model,
- subscribe to or expose enough session event information for remote projection,
- invoke a safe test prompt/steering path from a local command before adding Telegram networking.

### Exit criteria

A local VS Code command can select an existing Copilot CLI session and send/steer it without constructing a parallel agent session.

## 4. Phase 2 — Telegram transport foundation

Create:

```text
telegramBotClient.ts
telegramService.ts
telegramTypes.ts
telegramSettings.ts
```

### Implement

- Bot API HTTPS wrapper or carefully selected dependency.
- `getMe` token validation.
- `getUpdates` long polling.
- update offset/deduplication.
- clean enable/disable lifecycle.
- bounded retry/backoff.
- `sendMessage`.
- `editMessageText`.
- callback-query acknowledgement.

### Design preference

Avoid a large Telegram framework dependency unless it materially reduces security/lifecycle complexity. The required Bot API surface for V1 is small enough that a lightweight client is viable.

### Exit criteria

VS Code can send/receive Telegram messages reliably and stopping the contribution stops the poller without duplicates.

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
- normal text prompt to idle selected session,
- clear errors for missing/closed sessions.

### Exit criteria

A Telegram user can select a VS Code Copilot session and send a normal prompt to it.

## 7. Phase 5 — active-turn steering and abort

### Implement

- inspect upstream session status,
- treat normal Telegram text during an active turn as steering,
- reuse existing `mode: 'immediate'` path,
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
- first-valid-response semantics with local UI if feasible through the selected seam,
- user choice questions,
- freeform question replies,
- invalidation of resolved buttons.

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

## 11. Phase 9 — first-run proposed API setup

Create:

```text
proposedApiSetup.ts
```

### Implement

- detect missing required proposal access safely,
- consent UI,
- locate runtime `argv.json`,
- JSONC-preserving update,
- backup/rollback,
- add only this extension ID,
- full-restart instruction,
- post-restart verification.

This phase may be developed earlier if a renamed extension ID blocks normal testing.

## 12. Phase 10 — release hardening

### Implement

- diagnostic commands/log channel,
- release compatibility metadata,
- VSIX packaging,
- dependency/license inventory,
- checksums,
- upstream rebase CI,
- end-to-end regression suite,
- user-facing setup/readme documentation.

## 13. Suggested source touch points

### Expected modified upstream file

Initially aim for one primary integration edit:

```text
src/extension/chatSessions/vscode-node/chatSessions.ts
```

### Possible additional seam edits

Only if required:

```text
src/extension/chatSessions/copilotcli/node/copilotcliSession.ts
src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts
package.json
```

Before editing `copilotcliSession.ts`, first determine whether the required behavior can be exposed through:

- existing public methods,
- existing session service methods,
- a small event/accessor interface,
- a transport-neutral remote coordinator.

## 14. Suggested configuration keys

Names are provisional and should follow upstream naming conventions.

```text
github.copilot.telegram.enabled
github.copilot.telegram.activityDetail
github.copilot.telegram.pollTimeout
github.copilot.telegram.notifications.enabled
```

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
github.copilot.telegram.configureProposedApi
github.copilot.telegram.openRuntimeArguments
```

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
- documentation is updated if the actual API differs from this plan,
- the downstream patch remains reviewable against upstream.
