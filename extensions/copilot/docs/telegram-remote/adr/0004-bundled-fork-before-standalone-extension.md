# ADR 0004: Keep the proof of concept inside the bundled Copilot extension

- **Status:** Accepted for current proof of concept
- **Date:** 2026-09-01

## Context

A cleaner product shape would be an independently identified extension that controls Copilot remotely without replacing or modifying the Copilot extension.

The project investigated that direction, but the required session-control surface is not exposed as a normal stable public extension API. VS Code proposed-API authorization is also extension-ID scoped, and enabling proposals for another extension does not automatically grant access to Copilot's private session services.

A custom-ID build can create and manage its own provider/session surface, but that does not make it equivalent to the official Copilot provider or give it transparent ownership of all Copilot sessions.

The working implementation also relies on narrow source-level integration seams such as the native Copilot session service, the transport-neutral session binding and the internal workbench request path.

## Decision

Keep the current proof of concept inside the bundled Copilot extension in the VS Code fork.

Treat independent packaging as a separate architecture problem rather than changing the extension ID and presenting reduced or isolated session behavior as equivalent.

The project may publish source, architecture documentation, demos and development builds, but the current architecture is not described as a Marketplace-ready standalone extension contract.

## Code and documentation evidence

The implementation is composed inside the Copilot extension and adds new source trees under:

```text
extensions/copilot/src/extension/remoteControl/**
extensions/copilot/src/extension/telegramRemote/**
```

while using narrow integrations in the existing Copilot session implementation.

Packaging/proposed-API constraints are documented in:

```text
SETUP_RELEASE_AND_LICENSING.md
```

The public project documentation explicitly distinguishes the bundled-fork proof of concept from future SDK/Agent Host/AHP decoupling work.

## Consequences

### Positive

- The proof of concept can reuse the same Copilot session objects and native request lifecycle used by VS Code.
- Architecture experiments are not blocked by the lack of a stable external session-control API.
- The project can validate the remote-control abstraction before optimizing distribution.
- The limitation is visible and documented instead of hidden behind branding or extension-ID changes.

### Negative

- Distribution is more complex than a normal Marketplace extension.
- Upstream rebases remain a first-class maintenance requirement.
- Public binaries must be described carefully because the fork contains modified upstream Copilot/VS Code code and branding constraints apply independently of the source license.
- The current design remains coupled to source-level Copilot integration seams.

## Revisit when

Supersede this ADR when one of the following is demonstrated end-to-end:

- a supported Copilot SDK integration can enumerate/control the required native sessions without losing VS Code behavior;
- VS Code exposes a stable remote-control/session API for another extension;
- Agent Host/AHP provides a supported way for the remote client to participate in the same sessions used by normal desktop VS Code.
