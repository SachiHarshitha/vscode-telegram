# ADR 0002: Use the native VS Code Copilot request lifecycle

- **Status:** Accepted
- **Date:** 2026-09-01

## Context

Telegram needs to submit new prompts and mid-turn steering into the same Copilot session that VS Code renders and manages.

Calling the Copilot SDK session directly from Telegram would be simpler mechanically, but it would bypass the native VS Code request path. In the current Copilot integration, `handleRequest()` expects a real VS Code chat request/tool token and the workbench owns important request lifecycle behavior.

A parallel SDK-send path would risk divergence between what Telegram caused and what the VS Code UI/session machinery believes happened.

## Decision

Remote prompts are dispatched through the existing VS Code Copilot chat command path.

`RemotePromptDispatcher` prepares a request-scoped context with:

```text
setPendingCopilotCLIRequestContext(...)
```

and then invokes:

```text
workbench.action.chat.openSessionWithPrompt.copilotcli
```

with the target session resource, steering queue semantics and the selected model/configuration where applicable.

Telegram does not call SDK `send()` directly for normal prompt submission.

## Code evidence

Implemented in:

```text
src/extension/remoteControl/vscode-node/remotePromptDispatcher.ts
```

The dispatcher:

- creates a correlation ID;
- records the registry-issued `RemoteRequestOrigin`;
- carries selected model/reasoning configuration;
- invokes `workbench.action.chat.openSessionWithPrompt.copilotcli`;
- uses `queue: 'steering'`;
- treats command completion separately from agent-turn completion.

## Consequences

### Positive

- VS Code creates the real request/tool invocation context.
- Native session rendering and request lifecycle remain authoritative.
- Local and remote interaction continue through the same session machinery.
- Telegram steering reuses upstream busy-session behavior instead of inventing a second queue.
- Model selection can enter through the same native command boundary.

### Negative

- The internal workbench command is a high-risk compatibility dependency.
- The command is not a stable public Marketplace API contract.
- Changes to Copilot request plumbing require compatibility tests and potentially downstream adaptation.
- Dispatch must be fire-and-forget from Telegram's perspective because the command promise follows the longer VS Code response lifecycle.

## Revisit when

Supersede this ADR if Copilot exposes a supported external session-control API that preserves the native VS Code request lifecycle without depending on an internal workbench command.
