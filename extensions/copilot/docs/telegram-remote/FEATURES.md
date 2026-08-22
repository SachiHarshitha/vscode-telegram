# Feature Matrix

Legend:

- **P0** — required for first usable release.
- **P1** — high-priority follow-up.
- **P2** — later/optional.
- **Upstream** — primarily provided by existing Copilot/VS Code code.
- **Telegram** — implemented in the new remote transport layer.
- **Glue** — small downstream integration between the two.

## Core features

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Telegram bot connection | P0 | Telegram | Required | Bot API `getUpdates` long polling |
| Bot token secure storage | P0 | Telegram/VS Code | Required | Use VS Code secret storage where possible |
| Telegram account pairing | P0 | Telegram | Required | Short-lived pairing code + numeric Telegram user ID |
| Paired-user allowlist | P0 | Telegram | Required | Fail closed for all other users |
| Connection health/status | P0 | Telegram | Required | Connected, retrying, unauthorized, disabled |
| Session list | P0 | Upstream + Glue | Required | Reuse `ICopilotCLISessionService.getAllSessions()` |
| Session metadata | P0 | Upstream + Glue | Required | Title, ID, working directory, status |
| Select active remote session | P0 | Telegram | Required | Telegram-side routing state only |
| Create session | P0 | Upstream + Glue | Required where supported | Reuse session service |
| Resume session | P0 | Upstream + Glue | Required | Reuse persistent Copilot session |
| Send prompt | P0 | Upstream + Glue | Required | Normal SDK/session send path |
| Mid-turn steering | P0 | Upstream + Glue | Required | Existing Copilot behavior uses SDK `mode: immediate` |
| Queue follow-up prompt | P1 | Upstream + Glue | Planned | SDK enqueue/default behavior |
| Abort active work | P0 | Upstream + Glue | Required | Existing session abort path |
| Live assistant output | P0 | Upstream + Telegram | Required | Coalesce deltas into Telegram message edits |
| Agent intent/status | P0 | Upstream + Telegram | Required when exposed | Render current activity |
| Tool start/progress/complete | P0 | Upstream + Telegram | Required | Compact event renderer |
| Permission request | P0 | Upstream + Glue | Required | Structured Telegram approval buttons |
| Permission approve/deny | P0 | Upstream + Glue | Required | Map callback to SDK permission response |
| Agent user-question request | P0 | Upstream + Glue | Required | Telegram choices/freeform reply |
| Plan approval/exit-plan response | P1 | Upstream + Glue | Planned | Reuse SDK/session plan interaction |
| Subagent activity | P1 | Upstream + Telegram | Planned | Render start/complete/failure |
| Session errors | P0 | Upstream + Telegram | Required | Visible remote failure state |
| Context/token usage | P1 | Upstream + Telegram | Planned | Display only when provided by runtime |
| Session title updates | P1 | Upstream + Telegram | Planned | Follow upstream `session.title_changed` |

## Model and mode features

| Feature | Priority | Ownership | Target | Notes |
| --- | --- | --- | --- | --- |
| Show current model | P0 | Upstream + Telegram | Required | SDK-backed selected model |
| List Copilot CLI models | P0 | Upstream + Glue | Required | Copilot SDK/model service is authoritative |
| Select model | P1 | Upstream + Glue | Planned | Use session model API supported by current source |
| Reasoning effort selection | P1 | Upstream + Glue | Planned | Only for models exposing supported effort levels |
| Show current agent mode | P0 | Upstream + Telegram | Required | Interactive/plan/autopilot/etc. as supported |
| Change mode | P1 | Upstream + Glue | Planned | Reuse existing mode/session APIs |
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
| Permission buttons | P0 | Required | Approve once / deny initially |
| User question buttons | P0 | Required | Choice buttons + freeform route |
| Editable live activity message | P0 | Required | Reduce chat flooding |
| Compact activity mode | P0 | Required | Default |
| Detailed activity mode | P1 | Planned | More tool/reasoning detail |
| Debug activity mode | P2 | Optional | Raw-ish event diagnostics, redacted as needed |
| Slash command shortcuts | P1 | Planned | `/sessions`, `/model`, `/stop`, `/status`, etc. |
| Images/files from Telegram | P1 | Planned | Controlled download + SDK attachment path |
| Notifications on completion | P1 | Planned | Completion/failure/approval-needed |
| Telegram Mini App | P2 | Optional | Rich dashboard only if bot UI becomes limiting |

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
| Detect proposed-API availability | P0 | Required | Activation guard |
| First-run proposed-API explanation | P0 | Required | User consent before modification |
| Persist extension ID in `argv.json` | P0 | Required for renamed VSIX | Preserve existing JSONC/content; back up first |
| Full-restart instruction | P0 | Required | Reload Window is insufficient |
| Bot connection test | P0 | Required | Validate token via Bot API |
| Pairing wizard | P0 | Required | Local code -> Telegram confirmation |
| Disable remote access | P0 | Required | Immediate local kill switch |
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
| Rate limiting | P1 | Planned |
| Audit trail | P1 | Planned |
| Configurable permission policy | P1 | Planned |
| Multiple paired users/roles | P2 | Deferred |

## Explicitly unsupported promises

The project MUST NOT claim these capabilities unless upstream APIs change and the implementation is verified:

- guaranteed hidden chain-of-thought access,
- automatic use of every model registered in `vscode.lm` as a full Copilot coding agent,
- public Marketplace compatibility while the project requires proposed APIs,
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
