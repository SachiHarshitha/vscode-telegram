# Release-Candidate Acceptance

> **Status:** Current manual release gate
> **Scope:** `copilot-telegram` downstream branch
> **Last reviewed:** 2026-09-01
>
> Automated tests are necessary but do not approve a release candidate by themselves. This checklist is performed against a clean build/profile. Do not paste bot tokens, prompts, callback payloads, answers or private workspace paths into the signoff report.

The remote-control seam remains an internal framework in this downstream fork. The current Agent Host integration is **session discovery + fork handover**, not direct AHP control.

## 1. Automated gate

Close development Extension Hosts that may lock generated runtime files, then from `extensions/copilot` run the current release suite:

```powershell
.\script\telegram-remote\test-phase8.ps1
.\script\telegram-remote\generate-release-report.ps1 -TestStatus passed -ArtifactPath <artifact-path>
```

Confirm:

- [ ] build/typecheck passes
- [ ] generic remote-control tests pass
- [ ] Telegram tests pass
- [ ] focused Copilot CLI/native-dispatch tests pass
- [ ] Agent Host discovery/handover tests pass
- [ ] packaging succeeds
- [ ] compatibility/license/checksum report is generated from a clean tree
- [ ] generated metadata contains no secret-shaped/user-content data

## 2. Clean-profile launch

- [ ] Launch the matching downstream build with a new profile.
- [ ] Confirm Copilot functions normally before Telegram is configured.
- [ ] Confirm Telegram performs no poll/network activity before explicit enablement.
- [ ] Confirm diagnostics expose versions/lifecycle state but no token, prompt, answer, callback payload or private path.

## 3. Setup and authorization

- [ ] Complete the local confidentiality/security disclosure.
- [ ] Validate a dedicated test bot token.
- [ ] Pair one private Telegram identity.
- [ ] Authorize the current test workspace.
- [ ] Verify an unpaired user cannot retrieve session metadata.
- [ ] Verify switching to another workspace blocks previous remote selection until locally authorized.

## 4. Session discovery and ownership

### Extension-host session

- [ ] Create/open an extension-host Copilot CLI-backed session in the authorized workspace.
- [ ] `/sessions` lists it normally.
- [ ] Selecting it attaches/selects directly without creating a duplicate remote mirror session.

### Agent Host session

- [ ] Create/open a current Agent Host-owned session in the authorized workspace.
- [ ] `/sessions` shows it with the `↪` handover marker/explanation.
- [ ] While the source is still in use locally, selecting it is rejected with the expected “close locally and retry” behavior.
- [ ] After the source becomes available, selecting it creates a **new Remote Pilot session** and selects that new session.
- [ ] Verify subsequent Telegram activity belongs to the forked Remote Pilot session, not the original Agent Host session.
- [ ] Return to VS Code and confirm the source/history relationship is understandable and no source-session lock is left stuck.

## 5. Prompt and steering

- [ ] Send a prompt from Telegram and confirm it appears through the native VS Code Copilot chat/session path.
- [ ] Confirm Telegram acknowledges without waiting for the whole turn.
- [ ] Start a longer task and steer it mid-turn from Telegram.
- [ ] Reply to a steerable activity message and confirm the same selected session is steered.
- [ ] Reply to a stale/completed activity message and confirm no dispatch occurs.

## 6. Activity presentation

- [ ] Confirm the live activity surface updates while the task runs.
- [ ] Confirm tool/interaction events are semantically grouped rather than emitted as raw event spam.
- [ ] Confirm final assistant output is delivered once.
- [ ] Confirm only SDK-visible reasoning/intent summaries are shown; no hidden chain-of-thought claim is made.
- [ ] Confirm completed/replayed historical events are not presented as fresh current work when attaching to an existing session.

## 7. Permission/question/plan controls

- [ ] Trigger a permission request and verify Telegram offers only **Approve once** and **Deny**.
- [ ] Let local VS Code win once and confirm the Telegram control becomes stale.
- [ ] Let Telegram win once and confirm only one SDK resolution occurs.
- [ ] Answer a choice question remotely.
- [ ] Answer a correlated freeform question remotely.
- [ ] Complete a plan review through `interactive`/`exit_only`/reject/feedback as applicable.
- [ ] Confirm no Telegram surface can select autopilot/autopilot-fleet or persistent auto-approval.
- [ ] With Mission Control active, confirm Telegram requests do not inherit Mission Control elevation.

## 8. Stop/abort

- [ ] Stop a Telegram-started turn using the current native/live control.
- [ ] Repeat with `/stop`.
- [ ] Stop a selected locally started extension-host/Remote Pilot turn where supported.
- [ ] Confirm stale/wrong-session Stop controls cannot cancel another request.
- [ ] Confirm terminal state clears active Stop controls.

## 9. Model and file UX

- [ ] Open the model picker and verify the merged/current catalogue is navigable.
- [ ] Select a supported model and reasoning effort where applicable.
- [ ] Verify `/status` reports actual selected state rather than a stale preference.
- [ ] Browse the authorized workspace with `/files`.
- [ ] Confirm traversal/out-of-root paths and binary/oversized previews are rejected.
- [ ] Confirm file browsing remains read-only.

## 10. Lifecycle and competing hosts

- [ ] Disable Telegram during/after normal use and confirm new remote dispatch is blocked immediately.
- [ ] Re-enable using valid stored state without unnecessary token re-entry.
- [ ] Exercise reconnect after a recoverable transport failure.
- [ ] Start a second host using the same bot token and confirm automatic second ownership fails visibly.
- [ ] Exercise explicit reconnect/takeover and confirm the displaced poller stops before the replacement becomes authoritative.
- [ ] Forget configuration and confirm token, pairing, consent, selection, callbacks and poller ownership are removed.

## 11. Mission Control coexistence

- [ ] Attach/use Mission Control and Telegram on the same extension-host/Remote Pilot session where supported.
- [ ] Confirm each remote transport receives one logical event stream rather than duplicate SDK-event fan-out.
- [ ] Race local/Mission Control/Telegram permission/question/plan responses and confirm exactly one valid response wins.
- [ ] Confirm Mission Control behavior remains usable after the generic registry refactor.

## 12. Signoff evidence

Record only non-sensitive evidence:

```text
candidate artifact/build identity
exact downstream commit
recorded upstream/base relationship
VS Code/Copilot/SDK versions
OS/test environment
release-report/checksum reference
Bot API smoke result
Agent Host handover result
Mission Control coexistence result
models/providers actually exercised
known limitations
reviewer/test date
```

Do not mark an untested provider/deployment architecture as compatible.

## 13. Release decision

A candidate should not be promoted if any of these remain unresolved:

- cross-workspace/session authorization failure,
- stale callback/reply dispatch,
- remote permission elevation,
- Agent Host source-lock or ownership ambiguity,
- duplicate bot poller ownership,
- native prompt path mismatch,
- token/content leakage in diagnostics/artifacts,
- inaccurate documentation claiming direct Agent Host/AHP control,
- missing license/compatibility metadata.