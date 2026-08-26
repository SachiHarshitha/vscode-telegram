# Feature Matrix

Legend:

- **P0** — required for first usable release.
- **P1** — high-priority follow-up.
- **P2** — later/optional.
- **Upstream** — primarily provided by existing Copilot/VS Code code.
- **Telegram** — implemented in the new remote transport layer.
- **Glue** — small downstream integration between the two.

The **Target** column records current implementation status, not only the eventual product target.

## Core features

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Telegram bot connection | P0 | Telegram | Required | Bot API `getUpdates` long polling |
| Bot token secure storage | P0 | Telegram/VS Code | Required | Use VS Code secret storage where possible |
| Telegram account pairing | P0 | Telegram | Required | Short-lived pairing code + numeric Telegram user ID |
| Paired-user allowlist | P0 | Telegram | Required | Fail closed for all other users |
| Connection health/status | P0 | Telegram | Required | Connected, retrying, unauthorized, disabled |
| Transport-neutral remote-control registry | P0 | Glue | Implemented | Extracted under `remoteControl/**`; preserves Mission Control and hosts capability-validated Telegram/synthetic attachment, event and control seams |
| Mission Control compatibility | P0 | Upstream + Glue | Required | Command/control semantics unchanged; duplicate event export removed |
| Typed remote request origin | P0 | Glue | Implemented | Registry-issued identity-trusted provenance; capabilities default off and elevating modes require an explicit grant |
| Exactly-once remote event publication | P0 | Glue | Implemented | Collapse overlapping MC listeners; deduplicate by upstream event ID |
| Existing-session event replay | P0 | Upstream + Glue | Implemented | Replay seeds internal state only and is never presented as new current work |
| Session list | P0 | Upstream + Glue | Implemented | Reuse `getAllSessions()`, then authorize each session working directory against the current consented window roots |
| Session metadata | P0 | Upstream + Glue | Required | Title, ID, working directory, status |
| Select active remote session | P0 | Telegram | Required | Telegram-side routing state only |
| Create session | P0 | Upstream + Glue | Implemented | `/new [prompt]` stages a controller session in an authorized open workspace; the first native prompt materializes it |
| Resume session | P0 | Upstream + Glue | Implemented for existing session metadata | Reuse persistent Copilot session; never acquire a wrapper only to list/select |
| Send prompt | P0 | Upstream + Glue | Implemented | Fire-and-forget native command; create the editable activity card immediately; no direct SDK send |
| Mid-turn steering | P0 | Upstream + Glue | Implemented | Same native request path; upstream busy handling uses SDK `mode: immediate` |
| Queue follow-up prompt | P1 | Upstream + Glue | Planned | SDK enqueue/default behavior |
| Abort active work | P0 | Upstream + Glue | Implemented | Registry capability and active-attachment checks invoke the bound session's narrow abort seam |
| Live assistant output | P0 | Upstream + Telegram | Implemented | SDK-visible deltas/full messages become semantic Rich Message rounds with bounded edits |
| Agent intent/status | P0 | Upstream + Telegram | Implemented when exposed | Consecutive SDK-visible intent/reasoning summaries update one expandable **Thinking…** round; request-scoped semantic deduplication collapses repeated event representations across boundaries, and nested-agent assistant streams stay out of the root timeline; no hidden chain-of-thought |
| Tool start/progress/complete | P0 | Upstream + Telegram | Implemented | Tool-call correlation; semantic read/search grouping; command/edit start-to-completion updates |
| Permission request | P0 | Upstream + Glue | Implemented | Individual Rich Message bubble, callback-correlated with the live SDK request |
| Permission approve/deny | P0 | Upstream + Glue | Implemented | Approve-once/deny only; first-valid-response-wins; replay/stale controls fail closed |
| Agent user-question request | P0 | Upstream + Glue | Implemented | Individual bubble with callback choices and correlated freeform reply |
| Plan approval/exit-plan response | P1 | Upstream + Glue | Implemented | Local, Mission Control and Telegram race once; remote actions are limited to `interactive`/`exit_only` or denial/feedback |
| Subagent activity | P1 | Upstream + Telegram | Implemented | Compact semantic start/complete/failure summaries |
| Session errors | P0 | Upstream + Telegram | Required | Visible remote failure state |
| Context/token usage | P1 | Upstream + Telegram | Implemented | Bounded summary only when provided by runtime |
| Session title updates | P1 | Upstream + Telegram | Implemented | Follow upstream `session.title_changed` |

## Model and mode features

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Show current model | P0 | Upstream + Telegram | Implemented | Shows the persisted Telegram selection for the exact paired identity, consent scope and selected session; otherwise reads the active wrapper or transiently reads/closes the inactive SDK session |
| List Agent Chat models | P0 | Upstream + Glue | Implemented | Merges `ICopilotCLIModels` with visible `vscode.lm` models; the inline picker is paginated so every entry remains reachable |
| Select model | P1 | Upstream + Glue | Implemented | Native CLI models use the ordinary model path; configured VS Code models use an additive SDK provider registry backed by the exact selected LM object; the validated choice persists across disable/reconnect and reload for the same authorized session |
| Reasoning effort selection | P1 | Upstream + Glue | Implemented where supported | Offered and accepted only when the feature is enabled and the selected catalogue model lists the effort |
| Show current agent mode | P0 | Upstream + Telegram | Implemented when live | Reads the live session bridge only; inactive/unknown mode is omitted rather than guessed |
| Change mode | P1 | Upstream + Glue | Implemented | Telegram offers only `interactive` and `plan`; runtime guards reject `autoApprove`, `autopilot`, and `autopilot_fleet` elevation |
| BYOK provider compatibility | P1 | Upstream + Glue | Integration implemented; backend compatibility unclaimed | VS Code retains provider credentials and serves inference through the LM API; no backend is declared compatible until the full matrix passes |
| vLLM/OpenAI-compatible endpoint | P1 | Upstream | Planned | Through supported Copilot BYOK configuration |
| Ollama compatibility | P1 | Upstream | Planned | Through supported Copilot BYOK configuration |
| VS Code LM discovery and execution | P1 | VS Code + Telegram | Implemented | Uses `vscode.lm.selectChatModels()` plus an authenticated loopback Responses adapter into the existing Copilot SDK agent harness |

## Telegram UX features

| Feature | Priority | Target | Notes |
| --- | --- | --- | --- |
| Home/status card | P0 | Implemented | Telegram-safe HTML card with an emoji title, bold field labels, section spacing, and escaped dynamic session/model/workspace values |
| Native command menu | P0 | Implemented | Startup registers the exact nine-command list and configures Telegram's global `commands` menu button without a per-chat override |
| Opt-in quick controls | P0 | Implemented | `/controls` enables a per-paired-user/chat persistent keyboard whose button text is the literal slash-command payload required by Telegram; `/controls_off` explicitly restores normal text-input mode |
| State-aware control keyboard | P0 | Implemented | Central idle/running/disconnected factory; selected-session status changes from the native CLI service update Telegram for both local- and Telegram-started turns, and keyboard markup is resent only when the visible state changes |
| Inline session picker | P0 | Implemented | Structured emoji-titled card with bold workstation/workspace labels and opaque callback buttons |
| Inline model picker | P1 | Implemented | Combined, paginated catalogue with opaque callbacks and nested supported reasoning-effort choices |
| Inline workspace file browser | P1 | Implemented | Read-only, bounded text previews below the selected authorized workspace; opaque callbacks and in-place menu edits |
| Inline mode picker | P1 | Implemented | Interactive/plan only; preference applies to the next Telegram prompt |
| Stop controls | P0 | Implemented, awaiting real-bot validation | Bot API 10.3 renders native Stop on every active draft and routes `stopped_message_generation` through the registry-owned abort path; `/stop` and the legacy `■ Stop` payload remain fallbacks, including for a selected locally started task |
| Permission buttons | P0 | Implemented | Approve once / deny; opaque callback correlation and first-valid-response-wins |
| User question buttons | P0 | Implemented | Choice buttons + reply-to-question freeform route |
| Plan review controls | P1 | Implemented | Implement interactively / approve only / reject; reply-to-plan feedback; no remote autopilot action |
| Live activity draft | P0 | Implemented, awaiting real-bot validation | One ephemeral `sendRichMessageDraft` per active run uses a stable draft ID, semantic `<tg-thinking>` states, a 10-second heartbeat, and Bot API 10.3 native Stop; generic start/idle/reasoning states are not persisted |
| Granular activity timeline | P0 | Implemented | Meaningful completed tools/interactions may remain persistent; any such message immediately restores the active live draft, while the terminal assistant answer intentionally replaces it |
| Focused Rich activity bubble | P0 | Implemented | Tool/interaction rounds with useful detail use `InputRichBlockDetails`; short lifecycle/progress updates stay compact and final assistant answers render directly as formatted rich HTML |
| Running-round in-place update | P0 | Implemented | Running phases update the live draft instead of creating messages; completed command/tool activity may be persisted, and final assistant text is sent once after the draft heartbeat stops |
| Reply-to-bubble steering | P0 | Implemented | Message correlation resolves the activity, then uses the normal native prompt/steering dispatcher |
| Rich draft streaming | P1 | Adapter implemented, intentionally unused in V1 timeline | Drafts are 30-second ephemeral previews with no persistent reply target; persistent send/edit is used for steerable rounds |
| Slash command shortcuts | P1 | Implemented | Native menu exposes `/new`, `/sessions`, `/model`, `/status`, `/files`, `/stop`, `/controls`, `/settings`, and `/help`; compatibility aliases include `/start`, `/models`, `/mode`, `/deselect`, and `/controls_off` |
| Idempotent inline interactions | P0 | Implemented | Every routed callback is answered; unchanged status renders skip Bot API edits and changed menus edit the tracked message instead of recreating it |
| Images/files from Telegram | P1 | Planned | Controlled download + SDK attachment path |
| Notifications on completion | P1 | Planned | Completion/failure/approval-needed |
| Telegram Mini App | P2 | Optional | Rich dashboard only if bot UI becomes limiting |

## VS Code UI features

All native indicators render transport-neutral registry state; Telegram strings never enter upstream files. See [ARCHITECTURE.md](./ARCHITECTURE.md) section 16.

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Remote indicator in session list | P0 | Glue | Required | `ChatSessionItem.description` + `tooltip`; `badge`/`status`/`metadata` already used upstream |
| Live indicator refresh | P0 | Glue | Required | Existing `refreshSession({reason:'update'})` driven by `onDidChangeAttachments` |
| Status bar item | P0 | Telegram | Implemented | Connecting/connected/attached/error/needs-consent/off states with state-aware controls |
| One-click kill switch | P0 | Telegram | Implemented | QuickPick Disable blocks dispatch synchronously before asynchronous cleanup |
| Discoverable disabled state | P0 | Telegram | Implemented | Muted `Telegram: Off` item after prior configuration, subject to status visibility setting |
| Capability/state-aware controls | P0 | Telegram | Implemented | Enable while disabled; Reconnect only for recoverable failure/stopped state; no inapplicable Unpair/Disable |
| In-chat attach notice | P0 | Glue | Required | `stream.warning()` on the existing routed stream; no-ops when no UI stream |
| Modal consent gate | P0 | Telegram | Required | Blocks first enable; cancel is default |
| Setup wizard | P0 | Telegram | Required | QuickPick/InputBox; token entry masked |
| Settings + disclosure text | P0 | Telegram | Required | `defineSetting()` + `markdownDescription` warning; token never a setting |
| Command palette gating | P1 | Telegram | Implemented | State-aware `enablement` clauses improve discoverability; handlers still revalidate security state |
| Diagnostics output channel | P1 | Telegram | Implemented | Dedicated content-free redacted lifecycle channel plus copyable compatibility report |
| Session-list remote filter | P2 | Glue | Optional | Only if many sessions are attached at once |
| Webview dashboard | P2 | Telegram | Rejected for V1 | Commands + settings cover the surface; revisit only if it stops scaling |

## Workspace and Git context

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Show working directory | P0 | Upstream | Required | Existing session metadata |
| Show repository/branch | P1 | Upstream/VS Code | Planned | Reuse existing Git services where possible |
| Show dirty state | P1 | Upstream/VS Code | Planned | Avoid rebuilding SCM UI |
| Changed-file summary | P1 | Upstream + Telegram | Planned | Derive from upstream edit/tool/session data |
| Open native diff from VS Code | P1 | Upstream | Existing | Telegram may request/open local UI, but remote diff UI is separate |
| Commit from Telegram | P2 | Upstream + permission | Optional | Explicit high-risk approval |
| Push from Telegram | P2 | Upstream + permission | Optional | Disabled by default / explicit approval |
| Multi-workspace/folder information | P1 | Upstream | Planned | Reuse session workspace services |
| Multi-VS-Code-window global gateway | P2 | Custom infrastructure | Deferred | Avoid until core path is stable |

## Setup and operations

| Feature | Priority | Target | Notes |
| --- | --- | --- | --- |
| Validate V1 bundled-Copilot proposal access | P0 | Required | Verify the built-in extension retains the proposals declared by its manifest; do not require `argv.json` |
| Register an own-ID companion in fork product configuration | P2 | V2 research | Build-time `extensionEnabledApiProposals` entry synchronized with the companion manifest; never changed during activation |
| Detect proposed-API availability | P2 | V2 own-ID research | Fail-closed activation guard before proposed APIs are touched |
| First-run proposed-API explanation | P2 | Private standalone research | User consent before runtime-argument modification |
| Persist extension ID in `argv.json` | P2 | Private standalone research | Preserve JSONC/content; back up first |
| Full-restart instruction | P2 | Private standalone research | Reload Window is insufficient |
| Bot connection test | P0 | Required | Validate token via Bot API |
| Pairing wizard | P0 | Required | Local code -> Telegram confirmation |
| Disable remote access | P0 | Required | Immediate local kill switch |
| Enable stored configuration | P0 | Implemented | Exact-scope SecretStorage token + consent + token-bound pairing; no token re-entry |
| Reconnect after failure | P0 | Implemented | Retryable failures/stopped lifecycle only; authentication failures route to setup |
| Forget configuration | P0 | Implemented | Stops access, removes token/consent/pairing, and clears configured marker |
| Concurrent lifecycle safety | P0 | Implemented | Generation-bound setup/enable/reconnect plus synchronous disable and resume deduplication |
| Diagnostics/log view | P1 | Implemented | Dedicated Telegram channel for lifecycle, authorization, polling and bounded-delivery state |
| Upstream version display | P1 | Implemented in copied/generated diagnostics | Exact commit in release report; extension/runtime/patch versions in local diagnostics |
| Automated update/rebase CI | P1 | Implemented | Scheduled/manual ephemeral upstream rebase, targeted tests, packaging and compatibility artifact |

## Security features

| Feature | Priority | Target |
| --- | --- | --- |
| Numeric Telegram user-ID authorization | P0 | Required |
| Expiring pairing challenge | P0 | Required |
| Secret token local protected storage | P0 | Required |
| Callback nonce/request validation | P0 | Required |
| Permission request/session correlation | P0 | Required |
| Workspace/session context displayed on destructive actions | P0 | Required |
| Log redaction | P0 | Required |
| Remote disable/kill switch | P0 | Required |
| Modal consent before first enable | P0 | Required; cancel is the default action |
| Persistent local indicator while attached | P0 | Session list + status bar |
| Current-workspace session authorization | P0 | Implemented; URI-identity containment against current consented roots, fail closed for empty/missing/foreign working directories |
| Remote permission escalation prevention | P0 | Implemented; Telegram can resolve only a correlated request with approve-once/deny and cannot mutate permission policy |
| Non-E2E confidentiality disclosure | P0 | Required before enabling bot transport |
| Singleton poller lease | P0 | Automatic competing consumer fails visibly; explicit Reconnect performs a nonce-checked ownership handoff before the new poll starts |
| Rate limiting | P1 | Implemented; pairing attempts, authorized messages/callbacks, outbound queue and transient retries are bounded |
| Audit trail | P1 | Implemented; content-free and credential-redacted local output channel |
| Configurable permission policy | P1 | Planned |
| Multiple paired users/roles | P2 | Deferred |

## Explicitly unsupported promises

The project MUST NOT claim these capabilities unless upstream APIs change and the implementation is verified:

- guaranteed hidden chain-of-thought access,
- guaranteed full coding-agent compatibility for every model merely because it is visible in `vscode.lm`,
- public Marketplace compatibility while the project requires proposed APIs,
- end-to-end encryption for Telegram bot conversations,
- seamless operation in Remote SSH, Dev Containers or Codespaces in V1,
- remote control of arbitrary native Copilot sessions through the small public `GitHub.copilot-chat` exported API alone,
- zero-maintenance compatibility with future proposed-API changes.

## Feature acceptance rule

A feature is considered implemented only when:

1. the correct upstream API/service is identified,
2. authorization and session routing are defined,
3. error behavior is visible to the Telegram user,
4. automated tests cover the transport/glue behavior,
5. upstream changes do not require duplicating the core Copilot implementation.
