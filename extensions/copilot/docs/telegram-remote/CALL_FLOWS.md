# Call Flows

> **Status:** Current runtime reference
> **Scope:** `copilot-telegram` downstream branch
> **Last reviewed:** 2026-09-01
>
> These diagrams describe the implemented control paths. Historical phase sequencing is intentionally omitted.

## 1. Activation and transport registration

```mermaid
sequenceDiagram
    participant VS as VS Code
    participant CSC as ChatSessionsContrib
    participant REG as RemoteControlRegistry
    participant MC as MissionControlTransport
    participant TR as TelegramRemoteContribution

    VS->>CSC: create Copilot CLI services
    CSC->>REG: create shared registry
    CSC->>MC: register Mission Control transport
    CSC->>TR: create Telegram contribution in same service container
    TR->>REG: register Telegram transport + capabilities
    TR->>TR: if enabled, validate stored state and start one poller
```

The generic registry is shared. Telegram does not create an independent Copilot SDK/session manager.

## 2. Telegram connection lifecycle

```mermaid
sequenceDiagram
    participant U as Local user
    participant W as Setup/Lifecycle UI
    participant C as TelegramRemoteContribution
    participant S as Secret/pairing/consent state
    participant T as TelegramService

    U->>W: Set Up / Enable / Reconnect
    W->>S: classify readiness
    alt token + pairing + workspace consent current
        W->>C: resume stored connection
        C->>T: acquire singleton lease and start
    else workspace consent stale/missing
        W-->>U: local workspace authorization
        W->>C: resume with stored token/pairing
    else pairing missing
        W-->>U: pair with stored token
    else token missing/invalid
        W-->>U: full setup
    end

    U->>W: Disable
    W->>C: block dispatch synchronously
    C->>T: stop poll + release lease
```

Only one healthy `getUpdates` consumer is allowed per bot token. Automatic competing owners fail visibly; explicit reconnect may perform the implemented ownership handoff.

## 3. Pairing

```mermaid
sequenceDiagram
    participant U as Local user
    participant P as Pairing service
    participant TG as Telegram

    U->>P: start pairing
    P->>P: create expiring single-use challenge
    P-->>U: show /pair <challenge>
    U->>TG: /pair <challenge>
    TG->>P: update(from.id, chat.id, challenge)
    P->>P: validate private chat + challenge + expiry
    P->>P: persist numeric Telegram identity
    P-->>TG: paired
```

Authorization uses numeric identity, not username/display name.

## 4. Session list

Telegram now lists two local ownership domains.

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as TelegramCommandRouter
    participant S as CopilotCLISessionService
    participant A as WorkspaceScopePolicy

    T->>R: /sessions
    R->>S: getRemoteControlSessions()
    S-->>R: extensionHost + agentHost session metadata
    loop every item
        R->>A: authorize workingDirectory
        A-->>R: allow / reject
    end
    R-->>T: picker
```

Extension-host sessions are directly selectable. Agent Host-owned sessions are marked `↪` and require handover.

## 5. Select an extension-host session

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant S as Session service
    participant A as Scope policy

    T->>R: select session
    R->>S: getSessionItem(id)
    S-->>R: metadata
    R->>A: reauthorize
    A-->>R: scope fingerprint
    R->>R: persist selected session metadata
    R-->>T: status
```

Selection does not acquire and retain an `IReference<ICopilotCLISession>`.

## 6. Agent Host session handover

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant S as CopilotCLISessionService
    participant AH as Agent Host session
    participant EH as New Remote Pilot session

    T->>R: select ↪ session
    R->>S: getRemoteControlSessionItem(id)
    S-->>R: source=agentHost
    R->>S: forkAgentHostSession(id)
    S->>AH: registerSessionInUse(id)
    alt already in use
        S-->>R: inUse
        R-->>T: close locally and retry
    else available
        S->>S: forkSession(...)
        S-->>R: forked(newId)
        R->>R: select newId
        R-->>T: new Remote Pilot session selected
    end
```

This is a controlled **fork/handover**, not direct control of the live Agent Host session and not an AHP client connection.

## 7. Prompt to selected session

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant A as Scope policy
    participant REG as RemoteControlRegistry
    participant D as RemotePromptDispatcher
    participant VS as VS Code chat command
    participant S as CopilotCLISession
    participant SDK as Copilot SDK

    T->>R: prompt
    R->>A: authorize selected session now
    A-->>R: allowed
    R->>REG: createRequestOrigin(telegram,...)
    R->>D: dispatch(sessionId,prompt,origin,options)
    D->>D: setPendingCopilotCLIRequestContext(...)
    D->>VS: openSessionWithPrompt.copilotcli
    D-->>R: accepted + completion promise
    R-->>T: acknowledge/start activity
    VS->>S: real ChatRequest + tool token
    S->>SDK: send
    SDK-->>S: events
    S-->>REG: session events
    REG-->>R: remote activity
    R-->>T: live/persistent presentation
```

Telegram does not await the whole VS Code command before acknowledging the user. The command may remain pending for the full agent turn.

## 8. Mid-turn steering

The same native path is used while a session is busy.

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant D as RemotePromptDispatcher
    participant VS as Native chat path
    participant S as CopilotCLISession
    participant SDK as Copilot SDK

    Note over S,SDK: current turn running
    T->>R: steering instruction
    R->>D: dispatch same selected session
    D->>VS: native request path
    VS->>S: real ChatRequest
    S->>SDK: send(... mode=immediate)
    SDK-->>S: continued events
```

Reply-to-activity steering first resolves bounded message correlation and revalidates identity, selected session and workspace scope.

## 9. Event projection

```mermaid
flowchart LR
    SDK[SDK SessionEvent]
    SES[CopilotCLISession bridge]
    REG[RemoteControlRegistry]
    PROJ[Remote event projection]
    AGG[ActivityAggregator]
    UI[Telegram activity UI]

    SDK --> SES --> REG --> PROJ --> AGG --> UI
```

The remote feed is session-lifetime state, not a reuse of request-scoped native rendering listeners.

Replay of persisted events seeds internal state only. It is not presented as new activity.

## 10. Tool activity

```mermaid
sequenceDiagram
    participant SDK as SDK
    participant REG as Registry
    participant A as ActivityAggregator
    participant T as Telegram

    SDK-->>REG: tool start
    REG->>A: projected event
    A-->>T: create semantic tool round
    SDK-->>REG: progress
    REG->>A: same toolCallId
    A-->>T: update running round
    SDK-->>REG: complete/fail
    REG->>A: same toolCallId
    A-->>T: finalize round
```

Read/search bursts may aggregate. Commands, edits and interactive requests remain distinct where that improves steerability and reviewability.

## 11. Permission request

```mermaid
sequenceDiagram
    participant SDK as SDK
    participant S as CopilotCLISession
    participant L as Local VS Code UI
    participant REG as Registry
    participant MC as Mission Control
    participant TG as Telegram

    SDK-->>S: permission requested
    par local
        S->>L: show permission UI
        L-->>S: response
    and remote
        S->>REG: requestPermission(...)
        REG-->>MC: request
        REG-->>TG: request
        MC-->>REG: optional response
        TG-->>REG: approve-once / deny
        REG-->>S: first valid remote response
    end
    S->>S: first valid result wins
    S->>SDK: respondToPermission once
```

Telegram cannot change the session-wide permission policy.

## 12. User question

```mermaid
sequenceDiagram
    participant SDK as SDK
    participant S as CopilotCLISession
    participant REG as Registry
    participant TG as Telegram

    SDK-->>S: user_input requested
    S->>REG: requestUserInput(...)
    REG-->>TG: choices + correlated freeform route
    TG-->>REG: answer
    REG-->>S: first valid response
    S->>SDK: respondToUserInput once
```

## 13. Plan exit/approval

```mermaid
sequenceDiagram
    participant SDK as SDK
    participant S as CopilotCLISession
    participant REG as Registry
    participant TG as TelegramPlanBridge

    SDK-->>S: exit_plan_mode requested
    S->>REG: requestExitPlanMode(safe actions)
    REG-->>TG: interactive / exit_only / reject / feedback
    TG-->>REG: correlated response
    REG-->>S: first valid response
    S->>SDK: respondToExitPlanMode once
```

Remote types cannot represent autopilot/autopilot-fleet/autoApproveEdits.

## 14. Stop/abort

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant REG as Registry
    participant S as Bound session
    participant SDK as SDK

    T->>R: native Stop or /stop
    R->>R: validate identity/session/request
    R->>REG: abort(sessionId, telegram)
    REG->>S: abort()
    S->>SDK: abort()
    SDK-->>S: terminal/state events
    S-->>REG: activity
    REG-->>R: terminal state
    R-->>T: stopped/final update
```

## 15. Model selection

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant M as Combined model bridge
    participant D as RemotePromptDispatcher
    participant VS as Native request path
    participant S as CopilotCLISession

    T->>R: /model
    R->>M: native + VS Code LM catalogue
    M-->>R: provider-qualified choices
    R-->>T: picker
    T->>R: choose model/effort
    T->>R: next prompt
    R->>D: validated model preference
    D->>VS: selected model configuration
    VS->>S: real request
    S->>S: apply/update selected model
```

Catalogue visibility does not by itself prove backend compatibility.

## 16. Workspace file browsing

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as Router
    participant A as Scope policy
    participant F as WorkspaceFileBrowser

    T->>R: /files
    R->>A: authorize selected session
    A-->>R: workspace root
    R->>F: list root/subpath
    F->>F: containment + traversal/symlink/binary checks
    F-->>R: bounded entries/preview
    R-->>T: inline picker or read-only preview
```

File browsing is presentation-only in the current implementation; editing from Telegram is not implied.

## 17. Error handling

```mermaid
flowchart TD
    I[Incoming Telegram action] --> A{Paired and current?}
    A -->|no| X[Reject without session metadata]
    A -->|yes| W{Workspace/session authorized?}
    W -->|no| Y[Reject / refresh selection]
    W -->|yes| D[Dispatch]
    D --> R{Accepted?}
    R -->|yes| OK[Acknowledge and stream state]
    R -->|no| ER[Explicit error; preserve safe state]
```

No accepted remote action should disappear silently.