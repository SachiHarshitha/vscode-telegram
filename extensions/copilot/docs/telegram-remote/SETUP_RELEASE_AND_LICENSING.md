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

This is the architecture described by the implementation plan. It can change `CopilotCLISession`, use the existing product/service composition and route remote prompts through the native chat request path. Proposal access is supplied by the fork's product configuration and bundled extension setup. Normal users of this build should not be asked to edit `argv.json` merely to enable the bundled Copilot code.

Initial deliverables are therefore development builds of the VS Code fork (or explicitly internal packages produced by that fork), with exact source compatibility metadata.

### Future possibility: independent extension

```text
Stock VS Code
  -> separately installed own-ID extension/VSIX
  -> supported Copilot remote-control API (not available today)
```

The small public export of the installed `GitHub.copilot-chat` extension does not expose the session control required here. An independent Marketplace extension is therefore not just a repackaging exercise: it requires a stable upstream remote-control extension point or a substantial redesign with reduced functionality.

The `argv.json` and own-extension-ID guidance below applies only to experiments with this future independent-extension path.

## 2. Proposed APIs by packaging mode

VS Code's proposed-API enforcement is extension-ID based.

A non-builtin extension that declares proposed APIs but is not product-allowlisted or runtime-enabled has those proposal declarations removed at runtime. The bundled fork should instead declare/allow the modified Copilot extension through its product configuration and validate that configuration in the built product.

Official guidance:

https://code.visualstudio.com/api/advanced-topics/using-proposed-api

For an independent development/own-ID extension, a persistent development configuration may use `argv.json`:

```json
{
  "enable-proposed-api": [
    "our.publisher.extension"
  ]
}
```

The official documentation describes proposed APIs as unstable and unsuitable for normal Marketplace publication. Treat own-ID proposal enablement as a **developer/private experiment**, not the release mechanism for the current fork.

## 3. Future own-ID first-run setup design

A future renamed independent build should start with a minimal preflight before initializing code that requires proposed APIs. This does not solve the missing public Copilot session-control API by itself.

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

## 4. Future own-ID `argv.json` update requirements

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

## 5. Future own-ID restart behavior

A normal **Reload Window** is not the required setup path. Runtime arguments are consumed by the VS Code application/main-process startup path.

The extension should display:

> Setup complete. Close all VS Code windows and reopen VS Code to enable the required APIs.

Do not make the core flow depend on undocumented internal relaunch services.

## 6. Telegram setup

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

## 7. Packaging

For the current architecture, development artifacts should be built through the VS Code fork's product/build tooling so the modified bundled extension, proposal allowlist and integration source remain aligned. If an internal VSIX is also produced for targeted testing, document that it is not equivalent to the complete bundled-fork distribution and record the required host configuration.

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

The current bundled fork must record exactly which extension identity and product allowlist it builds with. Do not impersonate the official publisher in a separately distributed Marketplace package.

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

- [ ] distribution mode identified as bundled fork or independent extension
- [ ] bundled extension identity/product proposal configuration recorded and tested
- [ ] own extension ID and proposal setup/rollback tested only if shipping an independent private build
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
