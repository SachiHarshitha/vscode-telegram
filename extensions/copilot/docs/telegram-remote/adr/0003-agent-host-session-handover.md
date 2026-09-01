# ADR 0003: Discover Agent Host sessions but hand them over through a fork

- **Status:** Experimental
- **Date:** 2026-09-01

## Context

Recent VS Code/Copilot builds distinguish extension-host Copilot CLI sessions from Agent Host-owned sessions. The legacy session provider deliberately excludes sessions that the Agent Host owns, which means a Telegram UI built only on `getAllSessions()` cannot present all relevant local work.

The project needs better session continuity, but it does not yet have a supported way for a bundled Telegram transport to become another client of the exact live Agent Host/AHP session that VS Code owns.

Pretending that Agent Host sessions are ordinary extension-host sessions would create unsafe ownership and locking behavior.

## Decision

Add a remote-control-specific discovery surface that can enumerate both extension-host and Agent Host-owned session metadata, while keeping ownership explicit.

For Agent Host-owned sessions:

1. show them in the Telegram session picker with a `↪` marker;
2. revalidate the session against the current authorized workspace;
3. require the source session not to be in use;
4. fork the source session through `forkAgentHostSession(...)`;
5. select the resulting extension-host session as the new Remote Pilot session.

The original Agent Host session is not directly remote-controlled by Telegram.

## Code evidence

`CopilotCLISessionService` now exposes:

```text
getRemoteControlSessions(...)
getRemoteControlSessionItem(...)
forkAgentHostSession(...)
```

and classifies session metadata as:

```text
source: 'extensionHost' | 'agentHost'
```

Agent Host ownership is detected from the Copilot session metadata and the VS Code `agentSessionData` directory. The service keeps normal `getAllSessions()` behavior separate from the broader remote-control discovery surface.

`TelegramCommandRouter.sendSessionPicker()` maps Agent Host sessions to `session.fork` callbacks and explains that `↪` sessions continue as a new Remote Pilot session.

`forkAndSelectAgentHostSession()` rejects a source that is still in use by VS Code and selects only the newly forked controller session.

## Consequences

### Positive

- Telegram can surface work that was previously invisible because Agent Host owned it.
- Session ownership remains explicit rather than bypassing Agent Host locks.
- The existing extension-host remote-control machinery can continue to own the Telegram-controlled session.
- The user gets continuity from an Agent Host session without copying conversation state in Telegram.

### Negative

- This is a handover, not true multi-client control.
- The resulting Remote Pilot session has a new session ID.
- The source must be idle/not in use before handover.
- VS Code and Telegram are not simultaneously controlling the same live Agent Host session through AHP.
- The implementation depends on current local session metadata/storage conventions and therefore requires compatibility testing.

## Future direction

A direct Agent Host/AHP architecture remains the cleaner long-term model if a supported connection boundary becomes available:

```text
Agent Host
   |
   +-- VS Code client
   +-- Telegram/remote client
```

Until that boundary is proven and supported, the explicit fork/handover is safer than presenting an unsupported same-session claim.
