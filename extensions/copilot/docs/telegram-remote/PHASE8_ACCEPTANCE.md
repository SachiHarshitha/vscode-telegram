# Phase 8 release-candidate acceptance

Phase 8 implementation is automated, but a release candidate is not approved until this checklist is performed against a clean bundled build. Do not paste tokens, callback payloads, prompts, answers, or private workspace paths into the report.

The remote-control seam is an internal framework in this bundled fork. It is not a stable public VS Code extension API or a Marketplace-compatible standalone extension point.

## 1. Automated gate

Close every development Extension Host before packaging so generated runtime files are not locked. From `extensions/copilot`:

```powershell
.\script\telegram-remote\test-phase8.ps1
.\script\telegram-remote\generate-release-report.ps1 -TestStatus passed -ArtifactPath <artifact-path>
```

The first command includes extension typecheck, generic/Telegram tests, focused native regressions, lint, packaging, and the focused core workbench test. Release metadata generation requires a clean worktree unless `-AllowDirty` is used for a non-release engineering preview.

## 2. Clean-profile bundled launch

- [ ] Launch the built fork with a new empty profile and extension directory.
- [ ] Confirm the controller marker contains `phase=8`, `patch=18`, `remote-control-framework=generic`, `telegram-native-menu=ready`, `telegram-activity=live-draft`, `telegram-native-stop=ready`, `telegram-diagnostics=redacted`, and `telegram-rate-limits=bounded`.
- [ ] With Telegram never configured, confirm there is no Telegram request, poller lease, listener, or status item.
- [ ] Confirm **Telegram Remote: Copy Diagnostics** contains versions/states but no credentials, prompts, answers, callback payloads, or workspace paths.

## 3. Telegram lifecycle and control

- [ ] Complete confidentiality consent, token validation, private-chat pairing, and exact-workspace authorization.
- [ ] Confirm Telegram's native Menu shows the exact nine registered commands and no setup message is pinned in the conversation.
- [ ] Confirm `/controls` shows literal slash-command buttons, every button triggers its command, and `/controls_off` removes it; active-run Stop is presented by the native live draft rather than a replacement keyboard message.
- [ ] Send a prompt and confirm one animated `<tg-thinking>` live draft reuses the same draft ID, remains visible beyond 30 seconds through its heartbeat, and is replaced by the final answer without persistent Prompt accepted, Copilot started, reasoning, or idle messages.
- [ ] Press the live draft's native Stop control and confirm `stopped_message_generation` cancels only the mapped selected run and produces at most one short stopped confirmation; verify `/stop` remains usable as fallback.
- [ ] Start a turn locally in the selected VS Code session; confirm Telegram creates the same semantic live-draft UI without persistent Running/Idle messages and without selecting an out-of-scope session.
- [ ] Confirm `/stop`, the legacy `■ Stop` payload, and native draft Stop reach the same registry abort seam; explicitly stop one selected locally started task, and confirm stale/foreign controls cannot affect another request.
- [ ] Browse an authorized workspace through `/files`; confirm folders/files use opaque inline callbacks, previews are bounded/read-only, and navigation edits the existing menu message.
- [ ] Select/create a session and send a prompt; confirm one activity sequence and one final answer.
- [ ] Steer an active turn by replying to its Telegram activity.
- [ ] Resolve an approve-once/deny permission request and confirm a stale/replayed callback cannot win.
- [ ] Answer a choice and a freeform user question.
- [ ] Exit plan mode interactively/exit-only and confirm Telegram cannot select autopilot or change the permission policy.
- [ ] Stop an active request explicitly and confirm abort targets only the selected attached session.
- [ ] Enable VS Code Allow All/autopilot locally and confirm tool activity is still projected without duplicate reasoning or a false permission result.
- [ ] Select a model, disable/reconnect/reload, and confirm the exact authorized session restores that model.
- [ ] Disable during a turn and confirm remote dispatch blocks immediately while the local task may finish and deliver its correlated terminal update.
- [ ] Change workspaces and confirm the paired identity/token are reused only after local consent; old-workspace commands remain blocked.
- [ ] Forget Configuration and confirm token, consent, pairing, configured marker, poller, callbacks, and attachments are removed.

## 4. Coexistence and competing hosts

- [ ] Attach Mission Control and Telegram to the same session; confirm each SDK event appears once per transport.
- [ ] Race local, Mission Control, and Telegram permission/question/plan responses; confirm exactly one valid response reaches the SDK and losing controls are cancelled.
- [ ] Start a second host with the same bot token; automatic startup must fail visibly without a second healthy poller.
- [ ] Use explicit **Reconnect** and confirm nonce-checked lease handoff stops the previous owner before the new poller becomes authoritative.
- [ ] Disable/reload/enable and verify configuration and singleton lease behavior are preserved.

## 5. Signoff evidence

Record the generated compatibility report and checksums, artifact identity, clean-profile location, test date, tester, Bot API smoke result, Mission Control coexistence result, and any provider/model matrix actually exercised. Do not mark an untested backend compatible.
