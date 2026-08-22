# Call Flows

This document captures the intended runtime call paths. Names are architectural and may be adjusted to match final implementation types.

## 1. Extension activation

```mermaid
sequenceDiagram
    participant VS as VS Code
    participant EXT as Copilot extension activation
    participant PRE as ProposedApiSetup
    participant CSC as ChatSessionsContrib
    participant TR as TelegramRemoteContrib

    VS->>EXT: activate()
    EXT->>PRE: check required API availability
    alt proposed APIs unavailable
        PRE-->>EXT: setup required
        EXT-->>VS: show setup prompt / limited activation
    else available
        EXT->>CSC: register Copilot services
        CSC->>TR: instantiate contribution using same service container
        TR->>TR: initialize Telegram transport
    end
```

## 2. Telegram long-poll lifecycle

```mermaid
sequenceDiagram
    participant TR as TelegramService
    participant API as Telegram Bot API
    participant R as TelegramCommandRouter

    loop while enabled
        TR->>API: getUpdates(offset, timeout)
        API-->>TR: Update[]
        TR->>TR: advance confirmed offset
        TR->>R: dispatch normalized update
        R-->>TR: response actions
        TR->>API: sendMessage/editMessageText/answerCallbackQuery
    end
```

Requirements:

- offset advances only after an update is safely accepted for processing,
- duplicate update IDs are ignored,
- retry uses bounded backoff,
- only one poller may consume a configured bot token in a given extension process.

## 3. Pairing

```mermaid
sequenceDiagram
    participant U as Local user
    participant P as PairingService
    participant T as Telegram

    U->>P: Start pairing
    P->>P: generate expiring random challenge
    P-->>U: display /pair <challenge>
    U->>T: /pair <challenge>
    T->>P: update(userId, challenge)
    P->>P: validate challenge + expiration
    P->>P: persist authorized numeric Telegram user ID
    P-->>T: pairing successful
```

Security properties:

- pairing code is single-use,
- code expires quickly,
- authorization is bound to Telegram numeric user ID, not username,
- bot token alone does not authorize a Telegram user.

## 4. Session list and selection

```mermaid
sequenceDiagram
    participant T as Telegram user
    participant R as CommandRouter
    participant C as RemoteControlCoordinator
    participant S as ICopilotCLISessionService

    T->>R: Sessions
    R->>C: listSessions(user)
    C->>S: getAllSessions(token)
    S-->>C: session items
    C-->>R: filtered/renderable sessions
    R-->>T: inline session picker
    T->>R: callback(select sessionId)
    R->>C: selectSession(user, sessionId)
    C->>S: getSessionItem(sessionId)
    S-->>C: valid session metadata
    C-->>R: selection accepted
    R-->>T: status card
```

## 5. Normal prompt to idle session

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as CommandRouter
    participant C as RemoteControlCoordinator
    participant S as CopilotCLISession
    participant SDK as Copilot SDK Session

    T->>R: text prompt
    R->>C: sendMessage(selectedSession, text)
    C->>S: inspect session status
    S-->>C: Idle
    C->>S: handle/send normal request
    S->>SDK: send(prompt, agentMode)
    SDK-->>S: events
    S-->>C: event stream
    C-->>R: normalized activity
    R-->>T: edit activity/status message
```

## 6. Mid-turn steering

Upstream Copilot already treats a request received while the session is busy as steering and sends the SDK request with `mode: 'immediate'`.

```mermaid
sequenceDiagram
    participant T as Telegram
    participant C as RemoteControlCoordinator
    participant S as CopilotCLISession
    participant SDK as Copilot SDK Session

    Note over S,SDK: Existing agent turn is running
    T->>C: "Do not change the DB layer"
    C->>S: steer(prompt)
    S->>SDK: send({ prompt, mode: "immediate" })
    SDK-->>S: steering accepted / continued events
    S-->>C: activity events
    C-->>T: steering acknowledged + updated status
```

Reference: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing

## 7. Tool execution activity

```mermaid
sequenceDiagram
    participant SDK as SDK Session
    participant C as RemoteControlCoordinator
    participant E as TelegramEventRenderer
    participant T as Telegram

    SDK-->>C: tool.execution_start
    C->>E: normalize tool start
    E-->>T: update activity card
    SDK-->>C: tool.execution_progress / partial result
    C->>E: coalesce progress
    E-->>T: throttled editMessageText
    SDK-->>C: tool.execution_complete
    C->>E: finalize tool state
    E-->>T: update activity card
```

The renderer should rate-limit message edits and preserve only useful recent actions in compact mode.

## 8. Permission request — local and Telegram race

```mermaid
sequenceDiagram
    participant SDK as SDK Session
    participant S as CopilotCLISession
    participant VS as VS Code local approval
    participant TG as Telegram approval

    SDK-->>S: permission.requested(requestId)
    par Local response
        S->>VS: show local permission UI
        VS-->>S: local response
    and Remote response
        S-->>TG: permission prompt + callback buttons
        TG-->>S: remote response
    end
    S->>S: accept first valid resolution
    S->>SDK: respondToPermission(requestId, response)
    S-->>VS: invalidate/resolve remaining prompt
    S-->>TG: invalidate buttons / show result
```

Stale Telegram callbacks MUST NOT be allowed to resolve a later permission request.

## 9. Agent user question

```mermaid
sequenceDiagram
    participant SDK as SDK Session
    participant C as RemoteControlCoordinator
    participant T as Telegram

    SDK-->>C: user_input.requested(requestId, question, choices)
    C-->>T: render question + choices
    alt choice selected
        T->>C: callback(requestId, choice)
    else free-form allowed
        T->>C: reply text bound to pending request
    end
    C->>SDK: respondToUserInput(requestId, response)
    C-->>T: question resolved
```

## 10. Abort

```mermaid
sequenceDiagram
    participant T as Telegram
    participant C as RemoteControlCoordinator
    participant S as CopilotCLISession
    participant SDK as SDK Session

    T->>C: Stop callback
    C->>C: validate user + selected session + callback nonce
    C->>S: abort()
    S->>SDK: abort()
    SDK-->>S: cancellation/session events
    S-->>C: idle/error/end state
    C-->>T: stopped
```

## 11. Model selection

```mermaid
sequenceDiagram
    participant T as Telegram
    participant C as RemoteControlCoordinator
    participant M as ICopilotCLIModels / SDK
    participant S as CopilotCLISession

    T->>C: Open model picker
    C->>M: get available models
    M-->>C: model metadata
    C-->>T: inline model picker
    T->>C: select modelId
    C->>S: update selected model
    S-->>C: selected model / error
    C-->>T: model status updated
```

Cross-provider/BYOK changes may have stronger constraints than same-provider model changes. The implementation must follow the current upstream API rather than assuming all provider changes are hot-swappable.

## 12. Session event projection

```mermaid
flowchart LR
    A[SDK SessionEvent] --> B[Session event listener]
    B --> C[Remote event normalizer]
    C --> D{Event class}
    D -->|high frequency| E[Coalescer/throttler]
    D -->|interactive| F[Request registry]
    D -->|state/error| G[Immediate notifier]
    E --> H[Telegram renderer]
    F --> H
    G --> H
    H --> I[Bot API]
```

Persisted SDK events may be replayed when attaching Telegram to an existing session. Ephemeral deltas should not be expected to exist after the fact.

Reference: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events

## 13. First-run proposed API enablement

```mermaid
sequenceDiagram
    participant E as Extension
    participant P as ProposedApiSetup
    participant U as User
    participant A as argv.json

    E->>P: preflight()
    P-->>E: required proposed APIs unavailable
    E-->>U: explain requirement + request consent
    U->>E: Enable
    E->>P: enableForExtensionId()
    P->>A: read existing JSONC
    P->>P: create backup / preserve existing keys
    P->>A: add ID to enable-proposed-api array
    P-->>U: full restart required
```

A simple window reload is not considered sufficient because startup arguments are read by the VS Code main process.

Reference: https://code.visualstudio.com/api/advanced-topics/using-proposed-api

## 14. Error handling flow

```mermaid
flowchart TD
    I[Incoming Telegram action] --> A{Authorized?}
    A -->|no| X[Reject without session data]
    A -->|yes| S{Selected session valid?}
    S -->|no| Y[Ask user to select session]
    S -->|yes| D[Dispatch]
    D --> R{Succeeded?}
    R -->|yes| OK[Acknowledge / render result]
    R -->|no| ER[Render explicit error + preserve safe state]
```

No accepted Telegram action should disappear silently.
