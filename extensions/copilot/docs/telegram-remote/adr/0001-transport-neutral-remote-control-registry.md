# ADR 0001: Use a transport-neutral remote-control registry

- **Status:** Accepted
- **Date:** 2026-09-01

## Context

The initial integration problem was broader than Telegram. Existing Copilot session code already contained remote-control behavior for Mission Control, including event publication and interactive response handling. Adding Telegram directly into `CopilotCLISession` would have created a second set of transport-specific branches inside a high-churn upstream file.

The project also needs transport provenance to remain security-significant. A Telegram callback must not be able to impersonate Mission Control or inherit an elevated mode simply by choosing a particular SDK `source` string.

## Decision

Introduce a generic `RemoteControlRegistry` under:

```text
extensions/copilot/src/extension/remoteControl/**
```

and keep Telegram-specific code under:

```text
extensions/copilot/src/extension/telegramRemote/**
```

The generic registry owns:

- transport registration and attachment;
- transport capabilities;
- typed remote request origins;
- session event publication;
- permission, user-input and plan-exit response races;
- abort routing;
- transport-neutral attachment metadata.

Telegram and Mission Control depend on the generic layer. The generic layer does not depend on Telegram Bot API types, pairing state, formatting, tokens or callback payloads.

## Code evidence

The current contract is defined in:

```text
src/extension/remoteControl/common/remoteControlTypes.ts
```

`IRemoteControlTransportCapabilities` explicitly grants operations such as prompt submission, permission responses and abort. `RemoteRequestOrigin` is created and validated by the registry rather than inferred from untrusted transport input.

The registry implementation lives in:

```text
src/extension/remoteControl/node/remoteControlRegistry.ts
```

The Telegram adapter lives separately in:

```text
src/extension/telegramRemote/**
```

## Consequences

### Positive

- Telegram does not become part of the Copilot agent/runtime model.
- Mission Control and Telegram can share first-valid-response behavior.
- Security-sensitive origin and capability checks have one authority.
- A future transport can be added without copying Copilot session logic.
- Upstream churn is concentrated into a small number of deliberate integration seams.

### Negative

- The fork still needs a narrow modification to upstream Copilot session composition and lifecycle code.
- The registry is currently an internal bundled-fork interface, not a supported public VS Code extension API.
- A generic abstraction creates maintenance cost if upstream Copilot later introduces an equivalent supported remote-control API.

## Revisit when

Supersede this ADR if VS Code/Copilot exposes a stable external multi-client session-control API or Agent Host/AHP becomes the authoritative integration boundary for this project.
