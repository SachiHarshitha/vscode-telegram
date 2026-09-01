# Setup, Release and Licensing

> **Status:** Current engineering/release reference
> **Scope:** `copilot-telegram` downstream branch
> **Last reviewed:** 2026-09-01
> **Legal note:** This records engineering observations and release constraints; it is not legal advice.

## 1. Current distribution architecture

The implemented project runs inside the downstream VS Code source fork:

```text
VS Code source fork
    -> bundled modified Copilot implementation
        -> RemoteControlRegistry
            -> Mission Control transport
            -> Telegram transport
```

This architecture can use the same internal session objects, native chat request lifecycle and proposed APIs as the bundled Copilot code.

It is **not** equivalent to a normal third-party Marketplace extension.

See [ADR-0004](./adr/0004-bundled-fork-before-standalone-extension.md).

## 2. Why a separate custom-ID extension is different

A separate extension identity can use stable VS Code APIs and can be granted proposed APIs in development/private environments, but that does not automatically provide:

- ownership of the official Copilot session provider,
- access to internal `CopilotCLISessionService` instances,
- the same product-level assumptions as the bundled Copilot implementation,
- visibility/control of all sessions surfaced by the official provider.

Therefore proposal enablement is only one part of the problem.

### Research path: fork-bundled own-ID companion

A companion bundled into a custom VS Code product would require exact build-time proposal registration for its own extension ID.

### Research path: private standalone own-ID VSIX

A private development build may enable proposed APIs for its ID through the supported development/runtime mechanism. This remains an experiment and does not create a public Copilot session-control API.

The current branch does not require either path for normal development.

## 3. Agent Host compatibility

The current release architecture now has a limited bridge to modern Agent Host-owned history:

- Telegram `/sessions` can discover Agent Host-owned local session metadata,
- sessions are still workspace-authorized before display,
- an idle Agent Host session can be forked into a new extension-host **Remote Pilot** session,
- a source session still in use by VS Code is rejected,
- Telegram does not directly attach to the live Agent Host/AHP session.

Direct AHP client operation is a future architecture investigation, not a current packaging promise.

## 4. Development launcher

From the repository root:

```powershell
.\extensions\copilot\script\telegram-remote\launch-dev.ps1
```

The development launcher prepares/builds the source runtime and opens the repository with the modified Copilot code under the downstream development environment.

Useful options include:

```powershell
# Reuse current build output.
.\extensions\copilot\script\telegram-remote\launch-dev.ps1 -SkipBuild

# Open a different test repository using the same dev profile.
.\extensions\copilot\script\telegram-remote\launch-dev.ps1 -WorkspacePath C:\path\to\repo

# Use an isolated/disposable profile.
.\extensions\copilot\script\telegram-remote\launch-dev.ps1 -ProfilePath C:\path\to\profile
```

The reusable development profile is intentionally separated from the user's normal VS Code profile. Credentials are not passed through launcher arguments.

If source-build GitHub authentication cannot complete through the normal browser callback, the development profile can use GitHub device-code authentication where supported.

## 5. Telegram setup flow

The current product flow is:

```text
local enable/setup
    -> confidentiality/security disclosure
    -> enter bot token locally
    -> validate with Telegram getMe
    -> store token in SecretStorage
    -> acquire singleton poller lease
    -> create short-lived pairing challenge
    -> pair private Telegram identity
    -> authorize current VS Code workspace scope
    -> allow session discovery/control within that scope
```

Default Telegram operation needs no webhook, inbound port, public IP or Tailscale.

## 6. Stored-state lifecycle

### Disable Remote Access

- blocks new remote dispatch immediately,
- stops/releases polling,
- preserves protected configuration for later re-enable where safe.

### Enable Remote Access

Reuses stored state only when token, pairing and current workspace consent are still valid.

### Reconnect

Used for recoverable connection/ownership failures. It may perform the implemented poller ownership handoff.

### Forget Configuration

Removes saved token, consent, pairing and configured marker after disabling access.

Workspace/pairing/token changes invalidate stale session selection rather than silently widening scope.

## 7. Development and release tests

Use the current script set under:

```text
extensions/copilot/script/telegram-remote/
```

The important distinction is:

- deterministic/unit/integration suites should use fake credentials and no Telegram network access,
- explicit real-bot smoke tests remain opt-in,
- release-candidate acceptance includes clean-profile and coexistence testing.

The release gate is documented in [TEST_STRATEGY.md](./TEST_STRATEGY.md) and [PHASE8_ACCEPTANCE.md](./PHASE8_ACCEPTANCE.md).

## 8. Real-bot development smoke test

The development smoke harness is separate from product SecretStorage setup.

Where the current script supports it, copy the sample environment file to a local ignored `.env`, supply a dedicated test bot token and run the explicit real-bot option.

Do not:

- commit the `.env`,
- print loaded secrets,
- use production/private repository content for a transport smoke test,
- confuse the smoke-test token injection with the product setup architecture.

## 9. Packaging requirements

A distributable development/release artifact should be produced through the fork's build/package tooling so the modified Copilot implementation and the matching VS Code source stay aligned.

Accompany artifacts with at least:

```text
exact source/upstream commit metadata
matching VS Code/Copilot versions
resolved Copilot SDK/runtime version where available
patch/revision identity
artifact checksum
applicable license files/notices
release notes / known limitations
```

The current release-report script is the preferred machine-readable source when available:

```powershell
cd extensions/copilot
.\script\telegram-remote\generate-release-report.ps1 -TestStatus passed -ArtifactPath <artifact-path>
```

Use dirty-worktree overrides only for explicitly non-release engineering previews.

## 10. Public artifact positioning

A public artifact from this branch should be described as an **experimental downstream fork/prototype**, not as an official GitHub Copilot distribution.

Recommended disclosure:

> This is an unofficial experimental project and is not affiliated with or endorsed by GitHub or Microsoft. It modifies open-source VS Code/Copilot integration code to explore transport-neutral remote control, with Telegram as the first remote client.

Do not present a separately distributed artifact as though its publisher were GitHub/Microsoft.

## 11. Marketplace boundary

The current architecture depends on source-level Copilot integration and proposal-sensitive surfaces. It should not be presented as a normal Marketplace-installable third-party extension with equivalent functionality.

A future Marketplace-compatible product would require one of:

- stable upstream APIs for the needed session/control surfaces,
- an upstream-supported remote-client/Agent Host integration path,
- a redesign that accepts reduced functionality and avoids internal/proposed dependencies.

## 12. Source licensing

The VS Code/Copilot source in this repository is distributed under its applicable MIT license notices. Downstream modifications must retain upstream copyright/license notices where required.

Repository license reference:

[`../../LICENSE.txt`](../../LICENSE.txt)

The public Copilot SDK is also MIT-licensed; verify the exact dependency/version license in the release artifact rather than relying only on this document.

## 13. Copilot CLI/runtime licensing

The Copilot CLI/runtime dependency has its own license/terms and should not be assumed to inherit the SDK's MIT terms.

Engineering rule:

> Keep the third-party Copilot CLI/runtime dependency unmodified. Modify the VS Code integration/remote-control layer instead.

Before public binary distribution, audit the exact packaged dependencies and include required notices/licenses.

## 14. Trademarks and branding

Open-source copyright permission does not automatically grant trademark rights.

Public releases should:

- use a project-controlled name/icon/publisher identity,
- state that the project is unofficial,
- use “GitHub Copilot” and “VS Code” descriptively when explaining compatibility/origin,
- avoid visual/identity choices that imply GitHub or Microsoft sponsorship,
- preserve required third-party notices.

## 15. Authentication and service entitlement

Source licensing is separate from entitlement to GitHub-hosted Copilot services.

The project should use the end user's own supported authentication/entitlement path and must not proxy unrelated users through a developer's personal Copilot credentials.

Hosted authentication behavior for self-built distributions should be treated as a runtime compatibility result and recorded empirically; do not infer that open-source licensing alone guarantees hosted-service entitlement.

## 16. Release CI

The downstream compatibility workflow should remain non-destructive:

```text
checkout downstream source
    -> compare/sync against recorded upstream
    -> build/typecheck
    -> run focused Copilot + Telegram tests
    -> package selected artifact
    -> inventory licenses/notices
    -> calculate checksum
    -> produce compatibility report
```

A scheduled compatibility job should report failure rather than silently publishing or pushing a conflicted rebase.

## 17. Public release checklist

Before publishing an artifact outside the development environment:

- [ ] distribution mode clearly identified as bundled downstream fork/prototype
- [ ] exact tested VS Code/Copilot/source revision recorded
- [ ] Agent Host behavior described as discovery + fork handover, not direct AHP control
- [ ] known custom-ID/session-provider limitations disclosed where relevant
- [ ] Telegram token absent from settings/logs/artifacts
- [ ] non-E2E Telegram disclosure present
- [ ] dependency licenses/notices audited
- [ ] upstream notices retained
- [ ] Copilot CLI/runtime unmodified
- [ ] unofficial/non-endorsement disclaimer present
- [ ] checksums produced
- [ ] automated tests pass
- [ ] clean-profile/manual acceptance completed for a release candidate

## 18. References

- VS Code proposed API: https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- VS Code extension publishing: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Telegram Bot API: https://core.telegram.org/bots/api
- Copilot SDK license: https://github.com/github/copilot-sdk/blob/main/LICENSE
- Copilot CLI license: https://github.com/github/copilot-cli/blob/main/LICENSE.md