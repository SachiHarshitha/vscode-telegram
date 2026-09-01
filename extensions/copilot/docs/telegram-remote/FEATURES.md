# Feature Matrix

> **Status:** Current reference
> **Scope:** `copilot-telegram` downstream branch
> **Last reviewed:** 2026-09-01
>
> This file records what is implemented in the branch today. Planned items are explicitly marked as such. It is not a wish list.

## Legend

- **P0** — required for the usable remote-control path.
- **P1** — high-value follow-up or partially validated capability.
- **P2** — optional/later work.
- **Upstream** — primarily provided by VS Code/Copilot.
- **Remote core** — implemented in `src/extension/remoteControl/**`.
- **Telegram** — implemented in `src/extension/telegramRemote/**`.
- **Glue** — narrow edits in existing Copilot session/composition code.

## Session and control plane

| Feature | Priority | Ownership | Status | Notes |
| --- | --- | --- | --- | --- |
| Transport-neutral remote-control registry | P0 | Remote core + Glue | **Implemented** | `IRemoteControlRegistry` owns transport registration, attachment, typed provenance, interactive-response fan-in and abort. |
| Mission Control compatibility | P0 | Upstream + Remote core | **Implemented** | Mission Control remains a transport over the same generic registry rather than a Telegram-specific fork. |
| Typed remote request provenance | P0 | Remote core | **Implemented** | Registry-created origin objects are the trust boundary; SDK `source` strings are not authorization. |
| Extension-host session discovery | P0 | Upstream + Glue | **Implemented** | Existing CLI-backed sessions remain selectable through the normal session service. |
| Agent Host session discovery | P0 | Upstream + Glue | **Implemented** | `getRemoteControlSessions()` adds Agent Host-owned session metadata to the Telegram picker. |
| Agent Host session handover | P0 | Upstream + Glue + Telegram | **Implemented** | An idle Agent Host session is forked into a new extension-host **Remote Pilot** session before Telegram controls it. This is not direct AHP attachment. |
| Agent Host session currently in use | P0 | Glue + Telegram | **Implemented fail-closed** | Handover is rejected while the source session is still locked/in use by VS Code. |
| Session creation | P0 | Upstream + Glue | **Implemented** | `/new` stages session metadata and the first native request materializes the session. |
| Session selection | P0 | Telegram | **Implemented** | Telegram stores routing metadata only; the conversation remains upstream-owned. |
| Prompt dispatch | P0 | Remote core + Glue | **Implemented** | Uses pending request context plus `workbench.action.chat.openSessionWithPrompt.copilotcli`; no direct SDK `send()`. |
| Mid-turn steering | P0 | Upstream + Glue | **Implemented** | Uses the same native request path; busy-session handling becomes immediate steering upstream. |
| Abort/stop | P0 | Remote core + Glue | **Implemented** | Registry capability and active attachment checks target only the selected bound session. |
| Queue follow-up | P1 | Upstream + Glue | Planned | Keep distinct from immediate steering. |

## Session activity and interaction

| Feature | Priority | Ownership | Status | Notes |
| --- | --- | --- | --- | --- |
| Session-lifetime event projection | P0 | Remote core + Glue | **Implemented** | Remote publication is independent of request-scoped native rendering. |
| Existing-session replay | P0 | Remote core + Glue | **Implemented** | Persisted SDK events seed bounded internal state and are not emitted as fresh user-facing work. |
| Assistant output | P0 | Upstream + Telegram | **Implemented** | SDK-visible assistant output is rendered into Telegram's live/persistent activity surfaces. |
| Reasoning/intent summaries | P0 | Upstream + Telegram | **Implemented when exposed** | Only SDK-visible summaries are rendered; hidden chain-of-thought is never claimed. |
| Tool activity | P0 | Upstream + Telegram | **Implemented** | Tool calls are correlated and semantically grouped instead of flooding Telegram with every raw event. |
| Permission approve-once/deny | P0 | Remote core + Telegram | **Implemented** | First-valid-response wins across local UI, Mission Control and Telegram. No remote policy elevation. |
| User questions | P0 | Remote core + Telegram | **Implemented** | Choice buttons plus correlated freeform replies. |
| Plan exit/approval | P1 | Remote core + Telegram | **Implemented** | Remote actions are limited to `interactive`, `exit_only`, denial and bounded feedback. |
| Subagent activity | P1 | Upstream + Telegram | **Implemented** | Compact semantic start/complete/failure projection. |
| Context/token usage | P1 | Upstream + Telegram | **Implemented when exposed** | Bounded summary only. |
| Session title updates | P1 | Upstream + Telegram | **Implemented** | Tracks upstream title-change events. |

## Telegram UX

| Feature | Priority | Status | Notes |
| --- | --- | --- | --- |
| Bot API long polling | P0 | **Implemented** | Outbound-only `getUpdates`; no webhook/public port required. |
| Native command menu | P0 | **Implemented** | `/new`, `/sessions`, `/model`, `/status`, `/files`, `/stop`, `/controls`, `/settings`, `/help`. |
| Opt-in quick controls | P0 | **Implemented** | Per paired identity/chat; `/controls_off` removes the persistent keyboard. |
| Session picker | P0 | **Implemented** | Extension-host sessions select directly; Agent Host sessions are marked `↪` and trigger handover. |
| Workspace file browser | P1 | **Implemented read-only** | Bounded text previews, workspace containment and opaque callbacks. |
| Live activity draft | P0 | **Implemented; real-bot release validation required** | Uses the current Bot API live-draft path with native Stop where supported. |
| Persistent rich activity | P0 | **Implemented** | Meaningful completed tool/interaction details may remain as stable messages. |
| Reply-to-activity steering | P0 | **Implemented** | Correlation maps a reply back to the selected session/request before native dispatch. |
| Permission/question/plan controls | P0/P1 | **Implemented** | Opaque one-shot callback state; stale controls fail closed. |
| Images/files uploaded from Telegram | P1 | Planned | Requires controlled download and attachment validation. |
| Completion notifications | P1 | Planned | Separate from activity streaming. |
| Telegram Mini App | P2 | Optional | Not required for the native-bot V1 architecture. |

## Model and mode handling

| Feature | Priority | Ownership | Status | Notes |
| --- | --- | --- | --- | --- |
| Show current model | P0 | Upstream + Telegram | **Implemented** | Reads live model state or transiently inspects inactive CLI state without pinning a wrapper. |
| Native Copilot CLI model catalogue | P0 | Upstream | **Implemented** | Reuses `ICopilotCLIModels`. |
| VS Code LM catalogue | P1 | VS Code + Telegram | **Implemented** | Merges models visible through `vscode.lm.selectChatModels()`. |
| Select native model | P1 | Upstream + Glue | **Implemented** | Uses the native selected-model path. |
| Select configured VS Code LM | P1 | Telegram + Glue | **Implemented** | Uses the authenticated loopback Responses bridge into the existing Copilot SDK agent harness. |
| Reasoning effort | P1 | Upstream + Glue | **Implemented where advertised** | Only exposed when the selected model reports support. |
| Remote mode selection | P1 | Remote core + Telegram | **Implemented** | Telegram offers only `interactive` and `plan`. |
| Remote autopilot/auto-approve elevation | P0 | Security boundary | **Intentionally unsupported** | Telegram cannot raise permission level or request autopilot/autopilot-fleet. |
| vLLM/Ollama backend compatibility | P1 | Upstream/provider | Unclaimed until validated | Visibility in a model catalogue is not a compatibility guarantee. |

## Security and lifecycle

| Feature | Priority | Status | Notes |
| --- | --- | --- | --- |
| Numeric Telegram user authorization | P0 | **Implemented** | Never authorize by username/display name. |
| Expiring local pairing challenge | P0 | **Implemented** | Bound to the bot/token lifecycle. |
| SecretStorage bot token | P0 | **Implemented** | Token is not stored in settings or sent to the model. |
| Exact workspace/session authorization | P0 | **Implemented** | URI-identity containment against currently consented roots. |
| Callback replay protection | P0 | **Implemented** | One-shot, bounded and request/session/identity correlated. |
| Remote permission escalation prevention | P0 | **Implemented** | Approve-once/deny and non-elevating plan actions only. |
| Singleton bot poller | P0 | **Implemented** | Competing automatic consumers fail visibly; explicit reconnect performs ownership handoff. |
| Local disable/kill switch | P0 | **Implemented** | Dispatch is blocked before asynchronous cleanup completes. |
| Redacted diagnostics | P1 | **Implemented** | Content-free lifecycle/compatibility diagnostics. |
| Telegram E2E confidentiality | — | **Not provided** | Telegram bot chats are not Secret Chats; this is disclosed before enablement. |

## Native VS Code surfaces

| Feature | Priority | Status | Notes |
| --- | --- | --- | --- |
| Telegram status bar state | P0 | **Implemented** | Connected, attached, authorization-needed, error and disabled states. |
| One-click local disable | P0 | **Implemented** | Available while access is enabled. |
| Command Palette lifecycle controls | P0 | **Implemented** | Setup/enable/reconnect/forget flows revalidate current state. |
| Transport-neutral native attachment indicator | P0 | Partial/current integration | Native UI consumes generic attachment metadata rather than Telegram-specific strings. |
| Webview dashboard | P2 | Rejected for V1 | Native VS Code commands/status plus Telegram UI are sufficient for the current product boundary. |

## Distribution and platform boundaries

| Capability | Status |
| --- | --- |
| Bundled modified Copilot implementation in the downstream fork | **Current implementation** |
| Independent Marketplace extension with equivalent control | **Not currently supported by the required public extension surface** |
| Custom-ID/private experiments | **Validated only as experiments; session/provider ownership differs from the bundled path** |
| Direct client attachment to VS Code's live Agent Host via AHP | **Not implemented** |
| Agent Host session discovery + fork handover into Remote Pilot | **Implemented** |

See [ADR-0003](./adr/0003-agent-host-session-handover.md) and [ADR-0004](./adr/0004-bundled-fork-before-standalone-extension.md).

## Acceptance rule

A feature is marked **Implemented** only when the branch contains the corresponding code path and its security/routing behavior is defined. A provider, deployment mode or backend is not declared compatible merely because it is theoretically reachable.