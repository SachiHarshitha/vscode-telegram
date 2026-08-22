# Setup, Release and Licensing

> This document records engineering/release constraints and is not legal advice.

## 1. Release strategy

The current architecture depends on proposed VS Code APIs already used by the upstream Copilot extension. A downstream extension identity is therefore not a normal Marketplace extension today.

Recommended release phases:

1. **Development/private VSIX** — prove Telegram control against the tracked upstream commit.
2. **Developer preview VSIX** — publish signed/checksummed release artifacts outside Marketplace with exact upstream compatibility metadata.
3. **Marketplace release only if/when the required VS Code APIs become stable or an upstream supported remote-control extension point becomes available.**

## 2. Proposed API requirement

VS Code's proposed-API enforcement is extension-ID based.

A non-builtin extension that declares proposed APIs but is not product-allowlisted or runtime-enabled has those proposal declarations removed at runtime.

Official guidance:

https://code.visualstudio.com/api/advanced-topics/using-proposed-api

The documented persistent configuration is `argv.json`:

```json
{
  "enable-proposed-api": [
    "our.publisher.extension"
  ]
}
```

The official documentation currently describes VS Code Insiders for sharing proposed-API extensions. The VS Code source also recognizes the runtime `--enable-proposed-api` extension-ID set. This project should therefore treat proposed-API operation as a **developer/private distribution mechanism**, not a supported Marketplace contract.

## 3. First-run setup design

A renamed downstream build should start with a minimal preflight before initializing code that requires proposed APIs.

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

## 4. `argv.json` update requirements

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

## 5. Restart behavior

A normal **Reload Window** is not the required setup path. Runtime arguments are consumed by the VS Code application/main-process startup path.

The extension should display:

> Setup complete. Close all VS Code windows and reopen VS Code to enable the required APIs.

Do not make the core flow depend on undocumented internal relaunch services.

## 6. Telegram setup after preflight

Recommended sequence:

1. Enable proposed APIs if needed.
2. Restart VS Code.
3. Enter Telegram bot token locally.
4. Validate token with Telegram `getMe`.
5. Save token to protected secret storage.
6. Start pairing.
7. Generate short-lived pairing challenge.
8. User messages the bot with the challenge.
9. Store authorized Telegram numeric user ID.
10. Show connection/session status.

No Tailscale or inbound firewall configuration is required for the default long-polling mode.

## 7. Packaging

Development artifacts should be built as VSIX packages using the upstream extension build/package tooling or an explicitly documented downstream wrapper.

Every release artifact should include or be accompanied by:

```text
extension VSIX
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
Distribution: VSIX developer preview
```

## 8. Marketplace restrictions

VS Code explicitly advises that extensions using proposed APIs should not be published to the Visual Studio Marketplace.

Therefore V1 MUST NOT claim Marketplace support while it depends on these APIs.

A future Marketplace release requires one of:

- required proposals become stable VS Code APIs,
- Microsoft/GitHub expose a stable remote-session/transport extension point,
- the project is redesigned to avoid proposed APIs and accepts the resulting feature loss.

## 9. Extension identity

### Official upstream identity

Upstream Copilot uses the GitHub publisher/extension identity and receives product-level privileges/allowlists in VS Code.

A public downstream project does not own that publisher identity and must not impersonate it.

### Downstream identity

The public/private downstream artifact should use an identity controlled by the project owner, for example:

```text
<owned-publisher>.<owned-extension-name>
```

That identity must be the one persisted in `enable-proposed-api` during first-run setup.

A same-ID build may be useful as a local experiment to compare behavior with upstream, but it is not the recommended public distribution model.

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

## 14. Release CI

A release workflow should eventually:

```text
checkout downstream branch
verify recorded upstream commit
install/build dependencies
compile Copilot extension
run upstream relevant tests
run Telegram tests
package VSIX
scan/package licenses
calculate SHA256
attach artifact + compatibility metadata
```

Do not auto-publish a rebased build if upstream compatibility tests fail.

## 15. Public release checklist

Before publishing a VSIX outside the development team:

- [ ] own extension ID and branding in place
- [ ] proposed API setup/rollback tested
- [ ] exact supported VS Code version documented
- [ ] Telegram token never stored in settings/logs
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
