# Setup, Release and Licensing

> This document records engineering/release constraints and is not legal advice.

## 1. Two distinct packaging architectures

### Current implementation target: bundled fork

```text
VS Code source fork
  -> bundled, modified Copilot extension
  -> RemoteControlRegistry
  -> Mission Control + Telegram transports
```

This is the architecture described by the implementation plan. It can change `CopilotCLISession`, use the existing product/service composition and route remote prompts through the native chat request path. V1 does not add a separate third-party extension: it runs inside the built-in Copilot extension, whose manifest declares the proposed APIs it uses. Validate those APIs in the built product. Normal users of this build should not be asked to edit `argv.json` merely to enable the bundled Copilot code.

Initial deliverables are therefore development builds of the VS Code fork (or explicitly internal packages produced by that fork), with exact source compatibility metadata.

### Future possibility: own-ID companion extension

```text
V2 option A: custom VS Code fork
  -> product-registered, own-ID companion extension
  -> supported Copilot remote-control seam (not available today)

V2 option B: stock VS Code/private development host
  -> separately installed own-ID extension/VSIX
  -> runtime proposal enablement
  -> supported Copilot remote-control API (not available today)
```

The small public export of the installed `GitHub.copilot-chat` extension does not expose the session control required here. An independent Marketplace extension is therefore not just a repackaging exercise: it requires a stable upstream remote-control extension point or a substantial redesign with reduced functionality.

The product-registration and `argv.json` guidance below applies only to experiments with these future V2 paths.

## 2. Proposed APIs by packaging mode

VS Code's proposed-API enforcement is extension-ID based.

A non-builtin extension that declares proposed APIs but is not product-allowlisted or runtime-enabled has those proposal declarations removed at runtime. V1 avoids that case because the modified Copilot extension is built in and already declares its proposals in `package.json`. The built product must still verify that those APIs remain available.

### V2 fork-bundled companion registration

If V2 introduces a separate own-ID companion bundled into the custom VS Code product, register it at build time:

```jsonc
{
  "extensionEnabledApiProposals": {
    "our.publisher.extension": [
      "<exact-proposal-required-by-the-final-v2-design>"
    ]
  }
}
```

The exact extension ID must match the companion manifest, and the product proposal list must match `package.json#enabledApiProposals`. In VS Code's proposal resolver, a product entry overrides the manifest declaration; an incomplete product list can therefore remove proposals the extension requested.

This is product build configuration, not extension initialization. VS Code resolves it before activating the extension. The V2 activation preflight may diagnose missing or mismatched registration, but it MUST NOT attempt to edit `product.json`.

Product registration grants only the listed VS Code API proposals. It does not expose Copilot's internal session service to another extension.

### V2 private standalone runtime enablement

Official guidance:

https://code.visualstudio.com/api/advanced-topics/using-proposed-api

For a private standalone development/own-ID extension, a persistent development configuration may use `argv.json`:

```json
{
  "enable-proposed-api": [
    "our.publisher.extension"
  ]
}
```

The official documentation describes proposed APIs as unstable and unsuitable for normal Marketplace publication. Treat own-ID proposal enablement as a **developer/private experiment**, not the release mechanism for the current fork.

## 3. Future private standalone own-ID first-run setup design

A future private standalone build should start with a minimal preflight before initializing code that requires proposed APIs. A fork-bundled V2 companion uses the same preflight only as verification and directs configuration failures back to the product build. Neither path solves the missing public Copilot session-control API by itself.

### User flow

```text
Install VSIX
  -> extension activation/preflight
  -> proposed APIs unavailable
  -> explain why they are required
  -> user explicitly chooses Enable
  -> safely update argv.json
  -> require full VS Code restart
  -> next activation verifies availability
  -> continue Telegram setup
```

### Consent copy requirements

The setup UI should tell the user:

- the exact extension ID being added,
- that experimental/proposed VS Code APIs are being enabled for that extension,
- that VS Code must be fully restarted,
- how to reverse the change.

Do not silently modify runtime arguments.

## 4. Future private standalone own-ID `argv.json` update requirements

The helper MUST:

- locate the correct VS Code runtime arguments file for the active product/profile,
- support JSONC/comments,
- preserve unrelated keys and formatting as far as practical,
- preserve other extension IDs in `enable-proposed-api`,
- avoid duplicate entries,
- write atomically where practical,
- create a backup before the first modification,
- expose a command to open the file for inspection,
- expose a command to remove this extension ID again.

Example transformation:

```jsonc
// Before
{
  "disable-hardware-acceleration": true,
  "enable-proposed-api": ["other.extension"]
}
```

```jsonc
// After
{
  "disable-hardware-acceleration": true,
  "enable-proposed-api": [
    "other.extension",
    "our.publisher.extension"
  ]
}
```

## 5. Future private standalone own-ID restart behavior

A normal **Reload Window** is not the required setup path. Runtime arguments are consumed by the VS Code application/main-process startup path.

The extension should display:

> Setup complete. Close all VS Code windows and reopen VS Code to enable the required APIs.

Do not make the core flow depend on undocumented internal relaunch services.

## 6. Telegram setup

### Persistent Code OSS development launcher

The current bundled-fork implementation can be exercised as a real extension-development instance. From the repository root, run:

```powershell
.\extensions\copilot\script\telegram-remote\launch-dev.ps1
```

The launcher prepares the source runtime, compiles Code OSS and the Copilot extension, and opens the repository with `extensions/copilot` as the extension development path. The manifest's `onStartupFinished` event activates the extension; V1 does not need a separate Telegram extension ID or an `argv.json` edit.

By default, reusable state is isolated under `%LOCALAPPDATA%\vscode-telegram\dev-profile`:

```text
user-data/   settings, account/session metadata, workspace trust, global storage and encrypted SecretStorage
extensions/  extensions installed only for this development environment
```

Sign into GitHub/Copilot and complete Telegram setup in the opened Code OSS window once. Later launches with the same profile reuse that configuration. Credentials are never passed to or stored in the script. SecretStorage values remain tied to the current Windows user/machine and should not be copied as a portable credential bundle.

Useful options:

```powershell
# Reuse the compiled output for a faster launch.
.\extensions\copilot\script\telegram-remote\launch-dev.ps1 -SkipBuild

# Open another test repository while retaining the same login/configuration.
.\extensions\copilot\script\telegram-remote\launch-dev.ps1 -WorkspacePath C:\path\to\test-repository

# Use a separate clean or disposable profile.
.\extensions\copilot\script\telegram-remote\launch-dev.ps1 -ProfilePath C:\path\to\clean-profile
```

Close any Code OSS development window using this profile before relaunching after a rebuild. If it remains open, Code OSS may route the new window to the existing application process and keep the previously loaded extension host. Do not add `--use-inmemory-secretstorage`; that test-only option deliberately prevents credential persistence.

If the normal browser callback cannot return to the unpackaged source build, enable `github-authentication.preferDeviceCodeFlow` in this development profile and retry GitHub sign-in.

On Windows, normal extension testing does not require every optional Code OSS native integration to be available. The launcher initializes only missing `telemetry.machineId`, `telemetry.sqmId` and `telemetry.devDeviceId` values in its isolated profile, matching the source-workbench test launcher. This prevents a missing telemetry-identity module from becoming a fatal first-run lookup and does not copy or create credentials. Other unavailable optional integrations can still write nonfatal warnings to the development logs.

For a full-native runtime check, pass `-RequireNativeRuntime`. That mode verifies and rebuilds the startup-critical native modules. If it reports missing Spectre libraries, use Visual Studio Installer to add the VS 2022 x64/x86 Spectre-mitigated MSVC, ATL and MFC components listed in the official [VS Code source prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites), restart PowerShell and rerun the launcher.

Recommended sequence:

1. Verify the bundled fork's Copilot/session-controller integration is active.
2. Display the confidentiality warning: Telegram bot chats are not end-to-end encrypted and selected development content will transit Telegram infrastructure.
3. Enter Telegram bot token locally.
4. Validate token with Telegram `getMe`.
5. Save token to protected secret storage.
6. Acquire the singleton poller lease.
7. Start pairing.
8. Generate short-lived pairing challenge.
9. User messages the bot with the challenge.
10. Store authorized Telegram numeric user ID.
11. Show connection/session status.

No Tailscale or inbound firewall configuration is required for the default long-polling mode.

Current Phase 6 behavior is deliberately conservative:

- only sessions whose valid file-URI working directory is inside a root of the currently consented window are shown or controllable;
- an empty window, missing working directory or foreign/sibling workspace fails closed; cross-workspace local approval is not implemented yet;
- permission prompts expose only per-request **Approve once** and **Deny** controls; Telegram cannot change the permission policy;
- plan review exposes only **Implement Plan**, **Approve Plan Only**, **Reject Plan**, and reply-bound feedback; remote clients cannot select autopilot modes;
- SDK-visible activity is converted into bounded, redacted semantic rounds; no hidden model chain-of-thought is exposed;
- each meaningful round is one expandable Telegram Rich Message, and running tool rounds are edited in place.

Lifecycle controls:

- **Disable Remote Access** blocks dispatch synchronously and stops polling but retains the protected token, consent, pairing and non-secret configured marker;
- **Enable Remote Access** reconnects without token entry only when that stored state matches the exact current machine/workspace scope;
- **Reconnect** appears for retryable connection failures or an unexpectedly stopped enabled lifecycle;
- authentication/configuration failures use **Set Up Again**;
- **Forget Configuration** disables access and removes token, consent, pairing and the configured marker;
- a previously configured disabled instance shows muted `Telegram: Off` when the status-bar visibility setting is enabled, while the Enable command always remains available in the Command Palette.

Changing the bot token, paired identity, consent schema, workspace roots or selected session working directory invalidates the prior selection. Reopen the intended repository in the development window and select its session again; never work around rejection by broadening a path setting.

### Phase 5.1 deterministic regression test

From the Copilot extension directory:

```powershell
cd extensions/copilot
.\script\telegram-remote\test-phase5.1.ps1
```

This runner currently covers 25 files / 232 tests using only fake credentials and in-memory Telegram hosts. It does not read `.env` or contact the real Bot API. Real-bot verification remains a separate human checklist in [TEST_STRATEGY.md](./TEST_STRATEGY.md#13-manual-smoke-test-script).

### Phase 6 deterministic regression test

From the Copilot extension directory:

```powershell
cd extensions/copilot
.\script\telegram-remote\test-phase6.ps1
```

This current runner covers 27 Telegram Remote files / 169 tests plus 14 focused Copilot CLI plan-response tests. It uses no persistent token and makes no Telegram or Mission Control network request.

### Configured Agent Chat models

Models configured through the Agent Chat picker are read from VS Code's active language-model registry (the profile resource is `chatLanguageModels.json`). A chat debug `models.json` snapshot is diagnostic output, not the configuration source. Restart or reload the development window after changing provider configuration, then use `/models`; the Telegram picker paginates the complete merged native/configured catalogue.

Configured model credentials remain owned by their VS Code provider. Telegram Remote retains only the opaque selected model identity and routes inference through the local authenticated bridge; it does not read or copy provider API keys.

### Phase 2 developer smoke test

The development harness does not store the token in VS Code and is not the product setup flow. Copy `extensions/copilot/.env.sample` to `extensions/copilot/.env`, fill `TELEGRAM_BOT_TOKEN`, then run:

```powershell
cd extensions/copilot
.\script\telegram-remote\test-phase2.ps1 -RealBot
```

By default the real test calls only `getMe` and a short `getUpdates`. Sending a test message additionally requires `TELEGRAM_TEST_CHAT_ID` and `TELEGRAM_REAL_TEST_SEND_MESSAGE=true`. The `.env` file is ignored and the runner never prints loaded values. Phase 3 replaces this development-only injection with consented VS Code SecretStorage.

## 7. Packaging

For the current architecture, development artifacts should be built through the VS Code fork's product/build tooling so the modified built-in extension, its proposal declarations and integration source remain aligned. If V2 adds a fork-bundled own-ID companion, its product proposal registration becomes part of that build contract. If an internal standalone VSIX is also produced for targeted testing, document that it is not equivalent to the complete bundled-fork distribution and record the required host configuration.

Every release artifact should include or be accompanied by:

```text
VS Code fork build and/or explicitly scoped internal VSIX
SHA256 checksum
release notes
LICENSE / applicable license notices
ThirdPartyNotices or dependency license inventory
UPSTREAM_VERSION metadata
```

Suggested downstream version metadata:

```text
Upstream VS Code commit: 0984c920744f2013d0ad2bc5e826fa45a64069ab
Upstream Copilot extension: 0.63.0
Telegram patch version: 0.1.0
Distribution: bundled fork development build
```

## 8. Marketplace restrictions

VS Code explicitly advises that extensions using proposed APIs should not be published to the Visual Studio Marketplace.

Therefore V1 MUST NOT claim that the current bundled-fork implementation is a Marketplace-installable extension.

A future Marketplace release requires one of:

- required proposals become stable VS Code APIs,
- Microsoft/GitHub expose a stable remote-session/transport extension point,
- the project is redesigned to avoid proposed APIs and source-level Copilot internals and accepts the resulting feature loss.

## 9. Extension identity

### Official upstream identity

Upstream Copilot uses the GitHub publisher/extension identity and receives product-level privileges/allowlists in VS Code.

A public downstream project does not own that publisher identity and must not impersonate it.

### Independent downstream identity

Any future independently published artifact should use an identity controlled by the project owner, for example:

```text
<owned-publisher>.<owned-extension-name>
```

For private proposed-API experiments, that identity is the one enabled by the runtime/development setup.

V1 must record that Telegram runs inside the bundled Copilot identity and does not introduce another extension ID. A V2 companion must use an owned identity and record its exact `extensionEnabledApiProposals` product entry. Do not impersonate the official publisher in a separately distributed Marketplace package.

## 10. Source licensing

### VS Code Copilot extension source

The `extensions/copilot` source in this repository is MIT-licensed. The license allows use, modification and redistribution subject to preserving the copyright/license notice.

Repository license file:

[`../../LICENSE.txt`](../../LICENSE.txt)

### Copilot SDK

The public Copilot SDK is MIT-licensed.

Reference:

https://github.com/github/copilot-sdk/blob/main/LICENSE

The downstream Telegram code may therefore use an independent open-source license such as MIT, subject to preserving upstream notices for copied/modified upstream code.

## 11. Copilot CLI runtime licensing

The `@github/copilot`/Copilot CLI runtime is not governed solely by the SDK's MIT license.

Current GitHub Copilot CLI license permits redistribution of **unmodified** copies only when all listed conditions are met, including that the CLI is part of an application/service providing material functionality beyond the CLI, is not distributed standalone/primary, and retains applicable license/copyright/trademark notices.

Reference:

https://github.com/github/copilot-cli/blob/main/LICENSE.md

Engineering rule:

> Do not patch or redistribute a modified Copilot CLI runtime. Modify the VS Code integration/Telegram layer only and keep the runtime dependency unmodified.

Before any public binary release, perform an exact dependency-license audit of the packaged artifact.

## 12. Trademarks and branding

Open-source copyright permission does not automatically grant trademark rights.

Public releases should:

- use their own project/product name and icon,
- state that the project is unofficial,
- use GitHub Copilot / VS Code names descriptively only when explaining compatibility,
- avoid a name/icon/publisher presentation that implies endorsement by GitHub or Microsoft,
- retain required third-party notices.

Suggested README disclaimer:

> This is an unofficial project and is not affiliated with or endorsed by GitHub or Microsoft. It contains and/or derives from open-source components distributed under their respective licenses.

## 13. GitHub service authentication and entitlement

Source/software licensing is separate from entitlement to GitHub-hosted Copilot services.

The project should use the end user's own supported authentication/entitlement path. It must not proxy multiple unrelated users through a developer's personal Copilot token/subscription.

BYOK/local-provider use follows the current Copilot SDK/CLI provider configuration and applicable provider terms.

The source review performed for this design did not establish whether a self-built VS Code/Copilot fork can reuse every hosted Copilot authentication flow, nor whether any failure would be caused by signing, product identity or another entitlement check. Treat hosted authentication as an explicit implementation spike and record observed behavior; do not state a definitive signing limitation without source/runtime evidence.

## 14. Release CI

A release workflow should eventually:

```text
checkout downstream branch
verify recorded upstream commit
install/build dependencies
compile Copilot extension
run upstream relevant tests
run Telegram tests
build/package the selected bundled-fork artifact (and optional scoped internal VSIX)
scan/package licenses
calculate SHA256
attach artifact + compatibility metadata
```

Do not auto-publish a rebased build if upstream compatibility tests fail.

## 15. Public release checklist

Before publishing any bundled-fork build or independent artifact outside the development team:

- [ ] distribution mode identified as V1 bundled fork, V2 fork-bundled companion or V2 private standalone extension
- [ ] V1 bundled Copilot identity/manifest proposal access recorded and tested
- [ ] V2 fork-bundled companion ID and `extensionEnabledApiProposals` entry synchronized and tested, if produced
- [ ] V2 standalone own-ID proposal setup/rollback tested only if shipping a private VSIX
- [ ] exact supported VS Code version documented
- [ ] Telegram token never stored in settings/logs
- [ ] non-E2E Telegram confidentiality warning shown during setup
- [ ] dependency licenses audited
- [ ] upstream MIT notices retained
- [ ] Copilot CLI runtime unmodified
- [ ] Copilot CLI license included if redistributed in artifact
- [ ] third-party notices generated/reviewed
- [ ] unofficial/non-endorsement disclaimer present
- [ ] checksums published
- [ ] automated tests pass
- [ ] release notes identify upstream commit

## 16. References

- VS Code proposed API: https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- VS Code extension publishing: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Telegram Bot API: https://core.telegram.org/bots/api
- Copilot SDK license: https://github.com/github/copilot-sdk/blob/main/LICENSE
- Copilot CLI license: https://github.com/github/copilot-cli/blob/main/LICENSE.md
