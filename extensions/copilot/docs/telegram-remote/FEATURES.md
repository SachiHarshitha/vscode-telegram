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
| Transport-neutral remote-control registry | P0 | Glue | Implemented | Preserves Mission Control and hosts Telegram attachment/event/control seams |
| Mission Control compatibility | P0 | Upstream + Glue | Required | Command/control semantics unchanged; duplicate event export removed |
| Typed remote request origin | P0 | Glue | Required | Permission/mode never inferred from transport-supplied source strings |
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
| Abort active work | P0 | Upstream + Glue | Required | Registry safe-control binding; not exposed on `ICopilotCLISession` today |
| Live assistant output | P0 | Upstream + Telegram | Implemented | SDK-visible deltas/full messages become semantic Rich Message rounds with bounded edits |
| Agent intent/status | P0 | Upstream + Telegram | Implemented when exposed | Separate progress/reasoning-summary rounds; no hidden chain-of-thought |
| Tool start/progress/complete | P0 | Upstream + Telegram | Implemented | Tool-call correlation; semantic read/search grouping; command/edit start-to-completion updates |
| Permission request | P0 | Upstream + Glue | Implemented | Individual Rich Message bubble, callback-correlated with the live SDK request |
| Permission approve/deny | P0 | Upstream + Glue | Implemented | Approve-once/deny only; first-valid-response-wins; replay/stale controls fail closed |
| Agent user-question request | P0 | Upstream + Glue | Implemented | Individual bubble with callback choices and correlated freeform reply |
| Plan approval/exit-plan response | P1 | Upstream + Glue | Planned | Reuse SDK/session plan interaction |
| Subagent activity | P1 | Upstream + Telegram | Implemented | Compact semantic start/complete/failure summaries |
| Session errors | P0 | Upstream + Telegram | Required | Visible remote failure state |
| Context/token usage | P1 | Upstream + Telegram | Implemented | Bounded summary only when provided by runtime |
| Session title updates | P1 | Upstream + Telegram | Implemented | Follow upstream `session.title_changed` |

## Model and mode features

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Show current model | P0 | Upstream + Telegram | Required | SDK-backed selected model |
| List Copilot CLI models | P0 | Upstream + Glue | Required | Copilot SDK/model service is authoritative |
| Select model | P1 | Upstream + Glue | Planned | Use session model API supported by current source |
| Reasoning effort selection | P1 | Upstream + Glue | Planned | Only for models exposing supported effort levels |
| Show current agent mode | P0 | Upstream + Telegram | Required | Interactive/plan/autopilot/etc. as supported |
| Change mode | P1 | Upstream + Glue | Planned | Reject any change that raises remote permission to autoApprove/autopilot |
| BYOK provider compatibility | P1 | Upstream | Planned | Do not recreate provider stack |
| vLLM/OpenAI-compatible endpoint | P1 | Upstream | Planned | Through supported Copilot BYOK configuration |
| Ollama compatibility | P1 | Upstream | Planned | Through supported Copilot BYOK configuration |
| VS Code LM discovery | P2 | VS Code + Telegram | Optional | Supplementary display only; not agent-harness guarantee |

## Telegram UX features

| Feature | Priority | Target | Notes |
| --- | --- | --- | --- |
| Home/status card | P0 | Required | Session, model, workspace, status |
| Inline session picker | P0 | Required | Callback buttons |
| Inline model picker | P1 | Planned | Dynamic list |
| Inline mode picker | P1 | Planned | Dynamic list |
| Stop button | P0 | Required | Guard against stale callback/session mismatch |
| Permission buttons | P0 | Implemented | Approve once / deny; opaque callback correlation and first-valid-response-wins |
| User question buttons | P0 | Implemented | Choice buttons + reply-to-question freeform route |
| Granular activity timeline | P0 | Implemented | One semantic `ActivityRound` per meaningful bubble; read/search bursts aggregate without collapsing the whole turn |
| Focused Rich activity bubble | P0 | Implemented | Tool/interaction rounds with useful detail use `InputRichBlockDetails`; short lifecycle/progress updates stay compact and final assistant answers render directly as formatted rich HTML |
| Running-round in-place update | P0 | Implemented | Command/tool completion edits its original Rich Message; a reply-linked replacement is sent if editing fails |
| Reply-to-bubble steering | P0 | Implemented | Message correlation resolves the activity, then uses the normal native prompt/steering dispatcher |
| Rich draft streaming | P1 | Adapter implemented, intentionally unused in V1 timeline | Drafts are 30-second ephemeral previews with no persistent reply target; persistent send/edit is used for steerable rounds |
| Slash command shortcuts | P1 | Partially implemented | `/new`, `/sessions`, `/deselect`, `/stop`, `/status`, `/start`; model commands remain planned |
| Images/files from Telegram | P1 | Planned | Controlled download + SDK attachment path |
| Notifications on completion | P1 | Planned | Completion/failure/approval-needed |
| Telegram Mini App | P2 | Optional | Rich dashboard only if bot UI becomes limiting |

## VS Code UI features

All native indicators render transport-neutral registry state; Telegram strings never enter upstream files. See [ARCHITECTURE.md](./ARCHITECTURE.md) section 16.

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Remote indicator in session list | P0 | Glue | Required | `ChatSessionItem.description` + `tooltip`; `badge`/`status`/`metadata` already used upstream |
| Live indicator refresh | P0 | Glue | Required | Existing `refreshSession({reason:'update'})` driven by `onDidChangeAttachments` |
| Status bar item | P0 | Telegram | Required | Connecting/connected/attached/error; warning background while attached |
| One-click kill switch | P0 | Telegram | Required | QuickPick from the status bar item |
| Discoverable disabled state | P0 | Telegram | Implemented | Muted `Telegram: Off` item after prior configuration, subject to status visibility setting |
| Capability/state-aware controls | P0 | Telegram | Implemented | Enable while disabled; Reconnect only for recoverable failure/stopped state; no inapplicable Unpair/Disable |
| In-chat attach notice | P0 | Glue | Required | `stream.warning()` on the existing routed stream; no-ops when no UI stream |
| Modal consent gate | P0 | Telegram | Required | Blocks first enable; cancel is default |
| Setup wizard | P0 | Telegram | Required | QuickPick/InputBox; token entry masked |
| Settings + disclosure text | P0 | Telegram | Required | `defineSetting()` + `markdownDescription` warning; token never a setting |
| Command palette gating | P1 | Telegram | Planned | `enablement` clauses so pairing actions hide when disabled |
| Diagnostics output channel | P1 | Telegram | Planned | Attach/detach audit trail, redacted |
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
| Diagnostics/log view | P1 | Planned | Connection, pairing, session bridge, event renderer |
| Upstream version display | P1 | Planned | Show source commit and patch version |
| Automated update/rebase CI | P1 | Planned | Detect conflicts against upstream |

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
| Singleton poller lease | P0 | One `getUpdates` consumer per bot token; competing consumer fails visibly |
| Rate limiting | P1 | Planned |
| Audit trail | P1 | Planned |
| Configurable permission policy | P1 | Planned |
| Multiple paired users/roles | P2 | Deferred |

## Explicitly unsupported promises

The project MUST NOT claim these capabilities unless upstream APIs change and the implementation is verified:

- guaranteed hidden chain-of-thought access,
- automatic use of every model registered in `vscode.lm` as a full Copilot coding agent,
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
