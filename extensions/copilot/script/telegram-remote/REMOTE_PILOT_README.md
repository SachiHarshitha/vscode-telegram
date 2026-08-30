# Remote Pilot

Remote Pilot is an Emagin8 UG distribution of GitHub Copilot that adds a security-scoped Telegram remote-control interface for local Copilot CLI sessions in VS Code.

## What's added

- Pair one authorized Telegram account with an explicitly consented VS Code workspace.
- List, create, select and resume Copilot CLI sessions from Telegram.
- Send prompts, steer a running turn, stop work and follow live agent activity.
- Answer correlated permission, question and plan requests without granting elevated permission modes.
- Select supported chat models and reasoning effort, and browse workspace information within the authorized scope.
- Disable, reconnect or completely forget remote access from VS Code at any time.

## Configure Telegram Remote

Open the Command Palette and run **Telegram Remote: Set Up**. The setup keeps the bot token in VS Code SecretStorage and guides you through workspace consent and Telegram account pairing.

[Read the Telegram Remote configuration guide]({{REMOTE_CONFIGURATION_README_URL}}).

> Telegram bot chats are not end-to-end encrypted. Prompts, responses, selected paths and sanitized activity sent through this feature transit Telegram infrastructure.

## Private release note

This package uses the alternate extension ID `{{EXTENSION_ID}}` and is intended for this Code OSS fork or private testing. It retains experimental VS Code API declarations and Copilot command identifiers, so the alternate ID must be authorized for the declared proposed APIs and the package must not be installed alongside the official GitHub Copilot extension. See the configuration guide for the current packaging constraints.

Use Remote Pilot's own **Remote Pilot: Sign In to GitHub** command when authentication is required. VS Code's global **Sign in to use GitHub Copilot** action targets the product-configured `GitHub.copilot-chat` extension and can enable the official extension again.

Remote Pilot is maintained by {{PUBLISHER_DISPLAY_NAME}} and is not an official GitHub or Microsoft distribution. GitHub Copilot access and its applicable terms are still required for the upstream Copilot functionality described below.
