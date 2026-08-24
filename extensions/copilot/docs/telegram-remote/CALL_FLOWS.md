# Call Flows

This document captures the intended runtime call paths. Names are architectural and may be adjusted to match final implementation types.

## 1. Extension activation

```mermaid
sequenceDiagram
    participant VS as VS Code
    participant EXT as Copilot extension activation
    participant PRE as ProposedApiSetup
    participant CSC as ChatSessionsContrib
    participant REG as RemoteControlRegistry
    participant MC as MissionControlTransport
    participant TR as TelegramRemoteContrib

    VS->>EXT: activate()
    EXT->>CSC: register controller-path Copilot services
    CSC->>REG: create shared remote-control registry
    CSC->>MC: register Mission Control transport
    CSC->>TR: instantiate contribution using same service container
    TR->>REG: register Telegram transport
    TR->>TR: when enabled, verify stored readiness then acquire singleton poller lease

    Note over PRE,VS: ProposedApiSetup is V2-only; V1 adds no third-party extension ID
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
- only one poller may consume a configured bot token,
- a second extension host/process must acquire a cross-process lease or fail explicitly rather than compete for updates.

### 2.1 Enable, reconnect and synchronous disable

```mermaid
sequenceDiagram
    participant U as Local user
    participant W as TelegramSetupWizard
    participant C as TelegramRemoteContribution
    participant S as Secret/consent/pairing state
    participant T as TelegramService

    U->>W: Enable Remote Access
    W->>S: classify token + token-bound pairing + exact-scope consent
    alt all current
        W->>C: resumeStoredConnection(scope)
        C->>T: start(token) / acquire singleton lease
        T-->>C: validated bot
        C-->>W: authorized connection
        Note over C,W: router restores selection only after identity + session-scope checks
    else workspace consent required
        W-->>U: local consent dialog only
        W->>S: save current scope; reuse token + paired user
        W->>C: resumeStoredConnection(scope)
    else pairing missing
        W-->>U: local consent + saved-token pairing flow
    else token missing
        W-->>U: full consent/token/pairing setup flow
    end

    opt retryable failed or unexpectedly stopped
        U->>W: Reconnect
        W->>C: deduplicated resume using same stored readiness checks
    end

    U->>W: Disable Remote Access
    W->>C: cancel lifecycle generation
    C->>C: synchronously block updates/callbacks and suspend routing
    C->>T: abort poll and release lease
    opt correlated local turn remains active
        C->>T: retain outbound-only client
        Note over C,T: SDK terminal event updates activity/final answer, then detaches
    end
    W->>W: persist enabled=false; keep configured marker
```

Setup, Enable and Reconnect share one in-flight operation. Concurrent commands cannot start a second poller. Automatic Enable remains conservative when another healthy owner exists; explicit Reconnect transfers the token-fingerprinted lease, gives the former owner one heartbeat window to abort, and only then starts the new poll. Disable invokes the contribution before its first asynchronous wait, so dispatch is blocked even if network cleanup stalls; any later completion from the cancelled generation cannot revive access. A configured disabled state exposes only Enable in the status menu. Workspace-consent recovery is amber and local-only, without token entry or pairing. Authentication/API failures use Set Up Again, while retryable failures and unexpected stopped state expose Reconnect.

During pairing, the contribution is `pairing-only`: all commands, callbacks, and prompts are ignored except the exact pending `/pair` command. It becomes `authorized` only after token validation, paired identity persistence, and current workspace consent are all active.

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
    participant A as WorkspaceScopePolicy
    participant S as ICopilotCLISessionService

    T->>R: Sessions
    R->>S: getAllSessions(token)
    S-->>R: session items
    loop every item before metadata is sent
        R->>A: authorize workingDirectory against current consented roots
        A-->>R: authorized scope or reject
    end
    R-->>T: inline session picker
    T->>R: callback(select sessionId)
    R->>S: getSessionItem(sessionId)
    S-->>R: current session metadata
    R->>A: reauthorize callback target
    A-->>R: authorized scope fingerprint
    R->>R: persist versioned selection
    R-->>T: edit picker into status card
```

Listing and selecting sessions do not acquire a live wrapper reference and never expose metadata for rejected sessions. Empty windows, missing/invalid working directories, foreign roots and stale consent/session-scope fingerprints fail closed. Prompt, steering, stop, restoration, activity edits and final answers repeat the authorization check rather than trusting the picker-time decision.

## 5. Normal prompt to idle session

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as TelegramTransport
    participant A as WorkspaceScopePolicy
    participant REG as RemoteControlRegistry
    participant X as PendingRequestContext
    participant VS as VS Code chat command
    participant P as Copilot chat participant
    participant S as CopilotCLISession
    participant SDK as Copilot SDK Session

    T->>R: text prompt
    R->>A: authorize selected session now
    A-->>R: current authorized scope
    R->>REG: submitPrompt(sessionId, text, updateId)
    REG->>REG: create typed telegram origin
    REG->>X: set pending context(prompt, origin)
    REG->>VS: dispatch openSessionWithPrompt.copilotcli (do not await)
    REG-->>R: accepted / dispatching
    R-->>T: send initial Rich progress round + request-bound Stop
    VS->>P: real ChatRequest + toolInvocationToken
    P->>X: take pending request context
    P->>S: handleRequest(...)
    S->>SDK: send(prompt, agentMode)
    SDK-->>S: events
    S-->>REG: publish session events
    REG-->>R: projected remote events
    R->>A: reauthorize before publish/flush
    R->>R: ActivityAggregator -> semantic ActivityRounds
    R-->>T: one Rich Message per round
    R-->>T: edit running rounds in place
```

`executeCommand()` remains pending until `responseCompletePromise` settles, so the transport does not await it. It attaches a rejection handler and reports progress/completion through registry events. If dispatch later fails, clear only the correlated pending context and return an explicit Telegram error. Direct SDK `send()` is not a fallback because it bypasses the VS Code request lifecycle and cannot supply the required `ChatParticipantToolToken`.

## 6. Mid-turn steering

Upstream Copilot already treats a request received while the session is busy as steering and sends the SDK request with `mode: 'immediate'`.

```mermaid
sequenceDiagram
    participant T as Telegram
    participant R as TelegramTransport
    participant REG as RemoteControlRegistry
    participant VS as VS Code chat command
    participant S as CopilotCLISession
    participant SDK as Copilot SDK Session

    Note over S,SDK: Existing agent turn is running
    T->>R: "Do not change the DB layer"
    R->>REG: submitPrompt(sessionId, text, updateId)
    REG->>REG: create typed telegram origin
    REG->>VS: pending context + dispatch command without awaiting turn
    REG-->>R: steering dispatch accepted
    R-->>T: send current request progress round + Stop
    VS->>S: handleRequest(real ChatRequest)
    S->>SDK: send({ prompt, mode: "immediate" })
    SDK-->>S: steering accepted / continued events
    S-->>REG: publish activity events
    REG-->>R: normalized remote events
    R-->>T: append semantic Rich Message rounds
```

Reference: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing

### Reply to a specific activity bubble

```mermaid
sequenceDiagram
    participant T as Telegram user
    participant TL as TelegramActivityTimeline
    participant R as TelegramCommandRouter
    participant D as RemotePromptDispatcher
    participant VS as Native VS Code chat path
    participant S as CopilotCLISession

    T->>TL: reply to bot message_id with steering text
    TL->>TL: resolve chat/message correlation
    TL-->>R: sessionId + requestId + activityRoundId
    R->>R: revalidate paired identity, selected session and workspace scope
    R->>D: dispatch same session + typed Telegram origin
    D->>VS: pending context + openSessionWithPrompt.copilotcli
    VS->>S: real ChatRequest/tool token
    S->>S: busy session -> SDK immediate steering
```

If the activity generation is complete, replaced, expired, deleted from correlation state or no longer steerable, the router returns an explicit stale-activity response and does not dispatch.

## 7. Tool execution activity

```mermaid
sequenceDiagram
    participant SDK as SDK Session
    participant S as CopilotCLISession
    participant C as RemoteControlRegistry
    participant A as ActivityAggregator
    participant TL as TelegramActivityTimeline
    participant T as Telegram

    SDK-->>S: tool.execution_start
    S-->>C: publish SDK event
    C->>A: projected tool start
    A-->>TL: new command/edit/read/search round
    TL-->>T: sendRichMessage(details block when useful)
    SDK-->>S: tool.execution_progress / partial result
    S-->>C: publish SDK event
    C->>A: projected tool progress
    A-->>TL: update same round by toolCallId
    TL-->>T: throttled editMessageText(rich_message)
    SDK-->>S: tool.execution_complete
    S-->>C: publish SDK event
    C->>A: projected tool completion
    A-->>TL: complete same round
    TL-->>T: edit original Rich Message
```

Consecutive read/search tools share a semantic inspection round until a reasoning, progress, command, edit, subagent, interaction or terminal boundary. Consecutive SDK-visible intent/reasoning events append to one **Thinking…** Rich Message until one of those non-reasoning boundaries occurs. Commands and file edits remain separate rounds. An edit failure falls back to a new Rich Message linked to the former one with `ReplyParameters`.

## 8. Permission request

Telegram is an attached registry responder for a concrete pending permission request. The existing first-valid-response-wins race remains authoritative.

```mermaid
sequenceDiagram
    participant SDK as SDK Session
    participant S as CopilotCLISession
    participant VS as VS Code local approval
    participant REG as RemoteControlRegistry
    participant MC as MissionControlTransport
    participant TG as TelegramTransport

    SDK-->>S: permission.requested(requestId)
    par Local response
        S->>VS: show local permission UI
        VS-->>S: local response
    and Remote response
        S->>REG: waitForPermission(request)
        REG-->>MC: request permission response
        REG-->>TG: request permission response
        MC-->>REG: optional remote response
        TG-->>REG: approve-once or deny
        REG-->>S: first valid remote response
    end
    S->>S: accept first valid resolution
    S->>SDK: respondToPermission(requestId, response)
    S-->>VS: invalidate/resolve remaining prompt
    S-->>TG: invalidate buttons / show result
```

Stale Telegram callbacks MUST NOT be allowed to resolve a later permission request.

Telegram cannot set the session permission level and cannot return an `autoApprove`/`autopilot` escalation. The only V1 results are approve-once and deny.

## 9. Agent user question

```mermaid
sequenceDiagram
    participant SDK as SDK Session
    participant S as CopilotCLISession
    participant VS as VS Code local question UI
    participant C as RemoteControlRegistry
    participant M as MissionControlTransport
    participant T as TelegramTransport

    SDK-->>S: user_input.requested(requestId, question, choices)
    par Local response
        S->>VS: show question carousel
        VS-->>S: local answer
    and Remote responses
        S->>C: waitForUserInput(request)
        C-->>M: publish question
        C-->>T: render question + choices
        M-->>C: optional remote answer
        T-->>C: choice or bound free-form answer
        C-->>S: first valid remote response
    end
    S->>S: accept first valid resolution
    S->>SDK: respondToUserInput(requestId, response)
    S-->>T: invalidate/resolve question
```

## 10. Abort

```mermaid
sequenceDiagram
    participant T as Telegram user
    participant TT as TelegramTransport
    participant C as RemoteControlRegistry
    participant S as registered session control
    participant SDK as SDK Session

    T->>TT: Stop callback
    TT->>TT: validate user + selected session + callback nonce
    TT->>C: abort(sessionId)
    C->>S: abort()
    S->>SDK: abort()
    SDK-->>S: cancellation/session events
    S-->>C: idle/error/end state
    C-->>TT: stopped
    TT-->>T: stopped
```

## 11. Model selection

```mermaid
sequenceDiagram
    participant T as Telegram
    participant C as TelegramTransport
    participant R as RemoteControlRegistry
    participant M as ICopilotCLIModels / SDK
    participant S as CopilotCLISession

    T->>C: Open model picker
    C->>M: get available models
    M-->>C: model metadata
    C-->>T: inline model picker
    T->>C: select modelId
    C->>R: setSelectedModel(sessionId, modelId)
    R->>S: update selected model
    S-->>R: selected model / error
    R-->>C: selected model / error
    C-->>T: model status updated
```

Cross-provider/BYOK changes may have stronger constraints than same-provider model changes. The implementation must follow the current upstream API rather than assuming all provider changes are hot-swappable.

## 12. Session event projection

```mermaid
flowchart LR
    A[SDK SessionEvent] --> B[Session-lifetime publication hook]
    B --> C[RemoteControlRegistry]
    C --> N[RemoteAgentEvent projector]
    N --> D[ActivityAggregator]
    D --> E[Semantic ActivityRounds]
    E --> F[TelegramRichRenderer]
    F --> G[One focused Rich Message bubble per round]
    G --> H[sendRichMessage / editMessageText rich_message]
    C --> I[Permission/question request race]
    I --> E
```

Persisted SDK events may be replayed when attaching Telegram to an existing session. Ephemeral deltas should not be expected to exist after the fact. Replay seeds bounded internal correlation/state only and is never presented as new current activity or a new answer.

Phase 5.3 marks replay delivery explicitly and ignores replay for current UI output. Each current request can have multiple chronological semantic bubbles, but not one bubble per microscopic event. Bubbles with useful round-local detail are independently expandable; short status/progress bubbles remain compact, while the final assistant answer is directly visible and formatted. Running rounds update no faster than the configured 750 ms minimum edit interval; new/waiting/failed/terminal rounds flush immediately. Every send/edit revalidates the paired identity, selected session and current workspace scope. Permission and user-input requests are individual correlated rounds, not generic activity output.

The session-lifetime hook is distinct from native request-scoped listeners, which are disposed after each request. Its disposable belongs to the registry session binding.

Attach/replay order:

```text
install live listener into temporary buffer
  -> call sdkSession.getEvents()
  -> filter supported persisted event types
  -> replay in event order while recording event IDs
  -> flush unseen buffered live events
  -> switch to direct live publication
```

Remote forwarding has exactly one publication point. Request-scoped native rendering may still observe the same SDK events, but it MUST NOT also publish them to the registry. Duplicate IDs are suppressed and no forwarded event may reference its own ID as `parentId`.

Reference: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events

## 13. Future own-ID extension proposal authorization

### 13.1 Fork-bundled V2 companion

```mermaid
sequenceDiagram
    participant B as Product build
    participant M as Companion package.json
    participant P as product.json
    participant VS as VS Code startup
    participant E as Own-ID companion activation

    B->>M: read extension ID + enabledApiProposals
    B->>P: validate matching extensionEnabledApiProposals entry
    B-->>B: fail build on missing ID or proposal mismatch
    VS->>P: resolve proposed-API authorization before activation
    VS->>E: activate companion
    E->>E: preflight required APIs
    alt APIs available
        E->>E: continue initialization
    else APIs unavailable
        E-->>VS: fail closed with product-registration diagnostic
    end
```

Activation never edits `product.json`. This path is not needed by V1, which runs inside the bundled Copilot extension.

### 13.2 Private standalone V2 experiment

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

This `argv.json` flow does not run for V1 or for a correctly registered fork-bundled V2 companion.

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
