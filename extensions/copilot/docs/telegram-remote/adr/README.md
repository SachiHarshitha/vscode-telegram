# Architecture Decision Records

This directory records architectural decisions that materially affect the Telegram remote-control design.

ADRs complement the detailed implementation documents in the parent directory. They are intentionally short and answer four questions:

1. What constraint or problem forced a decision?
2. What did the project choose?
3. What trade-offs follow from that choice?
4. What evidence in the current codebase represents the decision?

## Status vocabulary

- **Accepted** — implemented and currently relied upon.
- **Experimental** — implemented as a proof of concept but not considered a stable product boundary.
- **Superseded** — retained for historical context after a later decision replaces it.

## Decisions

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](./0001-transport-neutral-remote-control-registry.md) | Accepted | Introduce a transport-neutral remote-control registry instead of embedding Telegram logic in Copilot session code |
| [0002](./0002-use-native-vscode-request-lifecycle.md) | Accepted | Dispatch Telegram prompts through the native VS Code Copilot request lifecycle instead of calling SDK `send()` directly |
| [0003](./0003-agent-host-session-handover.md) | Experimental | Discover Agent Host-owned sessions, but continue them through an explicit fork/handover rather than pretending to support direct AHP control |
| [0004](./0004-bundled-fork-before-standalone-extension.md) | Accepted for current POC | Keep the working proof of concept inside the bundled Copilot extension until a stable external session-control boundary exists |

## Maintenance rule

When a decision changes, do not silently rewrite its history. Mark the old ADR **Superseded** and add a new ADR describing the replacement architecture.
