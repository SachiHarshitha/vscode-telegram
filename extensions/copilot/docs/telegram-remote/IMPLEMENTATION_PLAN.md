# Implementation Record and Next Steps

> **Status:** Historical phase record + current engineering backlog
> **Scope:** `copilot-telegram` downstream branch
> **Last reviewed:** 2026-09-01
>
> This file used to contain the complete step-by-step implementation plan. Most of those steps are now implemented, and keeping a very large “future tense” plan became misleading. This version records the architectural progression, the validation scripts that remain in the repository, and the next decisions that still matter.

For current behavior use:

- [README.md](./README.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [FEATURES.md](./FEATURES.md)
- [TEST_STRATEGY.md](./TEST_STRATEGY.md)

For design rationale use [adr/](./adr/README.md).

## 1. Initial problem

The project began with a narrow goal:

> Allow a developer to observe and control VS Code Copilot agent work remotely through Telegram without rebuilding the coding-agent runtime.

The initial source review found that the required capabilities already existed across upstream Copilot, but were not exposed as one public extension API:

- session lifecycle,
- Copilot SDK events,
- steering/abort,
- permissions/questions/plan interactions,
- Mission Control remote-control behavior,
- model selection,
- IDE/MCP integration,
- native VS Code chat rendering.

That led to a downstream architecture that generalizes the existing remote-control seams rather than building a separate agent.

## 2. Architectural progression

```text
Stage 1
Source review and project specification
    |
Stage 2
Transport-neutral RemoteControlRegistry
    |
Stage 3
Telegram transport + secure pairing/lifecycle
    |
Stage 4
Workspace/session authorization + native prompt routing
    |
Stage 5
Session-lifetime event projection + Telegram activity UX
    |
Stage 6
Permission / question / plan response arbitration
    |
Stage 7
Model/mode integration + VS Code LM bridge
    |
Stage 8
Release/compatibility automation
    |
Current
Agent Host session discovery + fork handover
```

The latest step is important: the branch can now discover sessions owned by VS Code's Agent Host and hand an idle one over by forking it into a new extension-host **Remote Pilot** session. It does not directly control the original Agent Host session over AHP.

## 3. Phase 1 — generic remote-control framework

### Objective

Remove the assumption that Mission Control is the only remote-control transport.

### Implemented outcome

`src/extension/remoteControl/**` now provides a transport-neutral internal framework with:

- transport registration/capabilities,
- trusted request provenance,
- session binding/attachment state,
- event fan-out,
- permission/question/plan response arbitration,
- abort,
- native prompt-dispatch support.

Mission Control remains supported through the same generic framework.

### Key decision

Telegram-specific Bot API/auth/rendering types do not enter the generic layer.

See [ADR-0001](./adr/0001-transport-neutral-remote-control-registry.md).

## 4. Phase 2 — Telegram transport foundation

### Objective

Build a dependency-light Telegram Bot API transport that can be tested without a real bot.

### Implemented outcome

The Telegram layer gained:

- Bot API client,
- long polling,
- update normalization,
- command/callback routing,
- initial pairing/auth support,
- deterministic fake-host testing,
- optional explicit real-bot smoke support.

### Validation script

```powershell
cd extensions/copilot
.\script\telegram-remote\test-phase2.ps1
```

Use any real-bot option only with a dedicated test bot and non-sensitive repository/content.

## 5. Phase 3 — secure lifecycle and transport ownership

### Objective

Make remote enablement a controlled local security decision rather than “bot token = access”.

### Implemented outcome

The branch added:

- protected token storage,
- private-chat numeric pairing,
- explicit enable/disable lifecycle,
- bounded retries/work queues,
- singleton bot-poller ownership,
- local consent/disclosure,
- safe reconnect/ownership recovery.

### Validation scripts

```powershell
.\script\telegram-remote\test-phase3.ps1
.\script\telegram-remote\test-phase3b.ps1
```

## 6. Phase 4 — session scope and native request routing

### Objective

Control the same Copilot session that VS Code owns, while preventing cross-workspace session leakage.

### Implemented outcome

- current workspace/session authorization policy,
- persisted selection fingerprinting,
- session picker/control routing,
- native prompt dispatcher,
- no direct SDK `send()` from Telegram,
- same-session steering through upstream busy-session behavior.

### Security property

A session being returned by the global session service is not sufficient authorization. Its working directory must be within the currently consented workspace scope.

### Validation script

```powershell
.\script\telegram-remote\test-phase4.ps1
```

See [ADR-0002](./adr/0002-use-native-vscode-request-lifecycle.md).

## 7. Phase 5 — activity projection and Telegram UX

### Objective

Present useful agent progress remotely without flooding Telegram with raw SDK events or pretending to expose hidden reasoning.

### Implemented outcome

- session-lifetime event publication,
- replay/live deduplication,
- bounded event projection,
- semantic activity aggregation,
- correlated Telegram messages/drafts,
- rich tool/interaction presentation,
- reply-to-activity steering,
- read-only workspace file browser,
- native command/control surfaces.

### Validation scripts

```powershell
.\script\telegram-remote\test-phase5.ps1
.\script\telegram-remote\test-phase5.1.ps1
```

## 8. Phase 6 — interactive response arbitration

### Objective

Allow Telegram to participate in the same permission/question/plan interactions as local VS Code and Mission Control without bypassing upstream policy.

### Implemented outcome

- first-valid-response-wins permission arbitration,
- approve-once/deny Telegram permission controls,
- correlated choice/freeform user questions,
- non-elevating plan-exit responses,
- stale/replayed response protection,
- transport-origin isolation.

Telegram cannot enable autopilot/auto-approval through these bridges.

### Validation script

```powershell
.\script\telegram-remote\test-phase6.ps1
```

## 9. Phase 7 — model and mode integration

### Objective

Expose useful model selection remotely while preserving the native Copilot agent harness.

### Implemented outcome

- native Copilot CLI model catalogue,
- VS Code LM catalogue integration,
- configured-model adapter into the Copilot SDK harness,
- supported reasoning-effort selection,
- actual selected-model visibility,
- non-elevating remote mode selection.

Catalogue visibility remains separate from backend compatibility claims.

### Validation script

```powershell
.\script\telegram-remote\test-phase7.ps1
```

## 10. Phase 8 — release and upstream compatibility

### Objective

Turn the prototype into a reproducible engineering artifact rather than a one-machine source experiment.

### Implemented outcome

- release-oriented aggregate test runner,
- compatibility/release report generation,
- checksum/license inventory support,
- clean-profile manual acceptance checklist,
- upstream rebase/compatibility workflow support.

### Validation

```powershell
.\script\telegram-remote\test-phase8.ps1
.\script\telegram-remote\generate-release-report.ps1 -TestStatus passed -ArtifactPath <artifact-path>
```

Manual signoff remains in [PHASE8_ACCEPTANCE.md](./PHASE8_ACCEPTANCE.md).

## 11. Current addition — Agent Host session handover

### Problem discovered

As VS Code moved session ownership toward Agent Host, a Telegram integration that only enumerated the extension-host CLI provider no longer represented the complete local session history.

### Implemented response

The session service now exposes a remote-control discovery surface that includes:

```text
extensionHost sessions
+
agentHost-owned sessions
```

Telegram displays Agent Host-owned sessions with `↪`.

On selection:

1. revalidate the source session/workspace,
2. verify the source is Agent Host-owned,
3. attempt to claim/check source-session use,
4. reject if it is still in use locally,
5. otherwise fork it using the existing session-fork path,
6. select the resulting extension-host Remote Pilot session,
7. release the source lock.

This is intentionally not direct Agent Host mutation.

See [ADR-0003](./adr/0003-agent-host-session-handover.md).

## 12. Why the current branch remains bundled

The project tested/considered a separate custom extension identity, but the required architecture is not simply “enable the same proposed APIs”.

Important constraints include:

- session/provider ownership,
- internal Copilot service access,
- product-level assumptions around the official/bundled implementation,
- incomplete public remote-control surfaces.

Therefore the current prototype remains a bundled downstream integration while cleaner SDK/Agent Host/AHP options are evaluated.

See [ADR-0004](./adr/0004-bundled-fork-before-standalone-extension.md).

## 13. Current engineering backlog

The remaining work should be driven by architecture value, not by adding Telegram features indiscriminately.

### P0 — release-quality validation

- keep Agent Host discovery/handover covered by deterministic and real acceptance tests,
- keep upstream compatibility metadata accurate,
- validate release artifacts on clean profiles,
- validate Telegram Bot API live-draft/Stop behavior with real bot versions used by the build,
- keep documentation synchronized with the actual session ownership model.

### P1 — session architecture investigation

- evaluate whether the modern Copilot SDK can independently enumerate/resume the exact sessions needed by a custom-ID client,
- evaluate whether a supported AHP path can allow Telegram/Emagin8 to become another client of the same Agent Host session,
- prefer upstream/public client APIs over expanding private storage/ownership heuristics.

### P1 — remote UX

- attachments/images only with bounded secure handling,
- completion/attention notifications,
- richer file operations only after a dedicated write/security design.

### P2 — alternate clients/transports

- Telegram Mini App only if native bot UI becomes a real limitation,
- additional messaging transports only after the transport-neutral core proves the abstraction remains useful,
- multi-machine federation only with a separate identity/network/security model.

## 14. Architecture decision rule for new work

Before adding a feature, ask:

1. Does upstream Copilot/VS Code already own this behavior?
2. Can the remote layer call/reuse it instead of copying it?
3. Does the change belong in generic `remoteControl/**` or Telegram-specific `telegramRemote/**`?
4. Does it change the security/permission/ownership boundary?
5. Does it make the fork harder to remove later?
6. Is there now a public Agent Host/SDK/AHP capability that makes the existing private seam unnecessary?

If the answer to the last question is yes, prefer migration over another downstream patch.

## 15. Current success criterion

The project is successful as an architecture prototype when it demonstrates that:

- one Copilot agent/runtime remains authoritative,
- remote clients can be added behind a transport-neutral control layer,
- mobile remote control can preserve native VS Code session/request semantics,
- security/permission boundaries remain explicit,
- modern Agent Host-owned history can be handed over without pretending simultaneous ownership is safe,
- the downstream patch can be explained, tested and rebased as a coherent architectural change rather than a collection of Telegram-specific hacks.