# Project Specification

> **Status:** Current project specification for the `copilot-telegram` downstream branch.
>
> **Last implementation review:** 2026-09-01, including Agent Host session discovery/fork handover and the implemented non-elevating plan-response bridge.

## 1. Project name

Working name: **Telegram Remote Control for VS Code Copilot**.

The final public name should avoid implying official GitHub or Microsoft endorsement.

## 2. Problem statement

VS Code Copilot already provides a mature, actively maintained coding-agent implementation with native session management, tools, permissions, model support, worktrees, checkpoints, IDE integration and GitHub Mission Control remote control.

The missing capability for this project is a lightweight remote interface through Telegram that can:

- observe a Copilot agent session represented by the local Copilot/CLI session infrastructure,
- discover both extension-host and eligible Agent Host-owned local sessions,
- send new prompts,
- steer work already in progress,
- answer permissions and agent questions,
- answer non-elevating plan-exit requests,
- stop execution,
- switch session/model/mode where supported,
- expose useful progress from a mobile device,
- optionally use local/BYOK models supported by the Copilot runtime.

Rebuilding the Copilot extension would unnecessarily duplicate a large and actively maintained codebase. The project therefore extends the upstream implementation with the smallest possible remote-control seam and keeps Telegram-specific behavior outside the agent runtime.

## 3. Product objective

> Add Telegram as a first-class remote-control transport for Copilot sessions hosted inside VS Code while preserving upstream Copilot behavior and minimizing downstream source divergence.

## 4. Architecture objective

The implemented abstraction is transport-neutral and shared with Mission Control:

```text
CopilotCLISession
      |
      +-- VS Code native request/UI lifecycle
      +-- RemoteControlRegistry
              +-- MissionControlTransport
              +-- TelegramTransport
              +-- future transports
```

Telegram must not become intertwined with agent execution logic. The generic registry/framework lives under `extension/remoteControl`, replaces Mission Control-only branches for events and interactive responses, and is also exercised by synthetic transport tests. Telegram protocol/authorization/UI code remains under `extension/telegramRemote`; the generic layer never imports Telegram Bot API, token, pairing or callback types. This is an internal bundled-fork seam, not a stable public extension API.

Remote user messages are injected through the existing VS Code native chat command path so VS Code creates a real `ChatRequest` and tool-invocation token. Telegram does not call SDK `send()` directly for ordinary prompt dispatch and does not maintain an independent conversation as the source of truth.

Agent Host-owned sessions are treated as a separate ownership domain. The current branch can discover them for remote-control continuity, but Telegram does not attach directly to their live AHP session. An eligible idle Agent Host session is explicitly forked into a new extension-host controller session before Telegram selects it.

## 5. Primary users

Initial target:

- developers running VS Code Desktop,
- developers who already use Copilot agent/CLI sessions,
- users who want to monitor or steer coding work from a phone,
- users who may use both GitHub-hosted and compatible local/BYOK models.

V1 is optimized for a single developer controlling their own workstation rather than a multi-tenant SaaS deployment.

## 6. Functional requirements

### FR-1 Telegram connectivity

The extension SHALL connect to Telegram through a bot token using Bot API long polling by default.

The extension SHALL NOT require an inbound network port, public IP, webhook server or Tailscale for normal operation.

### FR-2 Pairing and authorization

The extension SHALL allow only explicitly paired Telegram users to control VS Code sessions.

Pairing SHALL use a short-lived challenge generated locally by the extension and validated against the Telegram numeric user ID.

### FR-3 Session discovery and control

The remote-control session catalogue SHALL expose authorized extension-host sessions and eligible Agent Host-owned session metadata available through the existing Copilot session infrastructure.

For extension-host sessions, the user SHALL be able to:

- view sessions,
- select a session,
- start a session where supported,
- resume an existing session,
- send a normal prompt,
- steer an in-progress turn,
- stop/abort execution.

For Agent Host-owned sessions, the current proof of concept SHALL:

- show eligible sessions distinctly in the Telegram picker,
- revalidate their working directory against the current consented workspace,
- refuse handover while the source session is in use,
- fork an eligible source into a new extension-host controller session,
- select the resulting fork for Remote Pilot control.

The current implementation SHALL NOT claim direct AHP control of the original live Agent Host session.

Live extension-host session access SHALL respect the `IReference<ICopilotCLISession>` acquire/dispose contract.

### FR-3a Native Telegram command UI

Bot startup SHALL register the product command list with Telegram and configure the global native commands menu button. The optional reply keyboard SHALL remain disabled by default, persist its opt-in only for the exact paired numeric user/chat, and expose centrally generated idle, running and disconnected layouts. Removing controls SHALL send Telegram's explicit keyboard-removal markup.

Slash commands and reply-keyboard labels SHALL normalize into one application action dispatcher. Authorization SHALL be revalidated for every command, button, callback and free-text prompt; keyboard visibility and callback contents SHALL never be treated as authorization. Stop controls SHALL delegate to the transport-neutral registry abort seam.

Session, model and workspace-file choices SHALL use opaque, bounded, expiring callback state and inline keyboards. Every routed callback query SHALL be answered, and tracked inline menus SHALL edit their existing message or accept an already-unchanged edit as success. Workspace file browsing SHALL be read-only, scoped below the selected authorized session workspace, reject traversal/symlink entry navigation and binary content, and bound preview size. This native Bot API interface SHALL NOT introduce a Telegram Mini App.

### FR-4 Live activity

The extension SHALL project useful SDK session events through an explicit session-lifetime registry hook, including as available:

- assistant intent/status,
- assistant text deltas,
- readable reasoning events,
- tool start/progress/complete,
- permission requests,
- user-input requests,
- subagent activity,
- session state changes,
- usage/context information,
- errors.

The native renderer's request-scoped listeners SHALL NOT be treated as a reusable persistent session feed. Raw events SHALL first become transport-neutral semantic activity rounds. One meaningful activity round SHALL map to one Telegram Rich Message bubble; related read/search bursts SHALL aggregate, while command, edit, permission, question, subagent and meaningful direction changes SHALL remain distinct. A running round SHALL be edited in place, with throttling only where semantic boundaries do not already provide a natural limit.

Each activity message SHALL be correlated by chat/message ID to its session, request and round. A reply to a still-steerable bubble SHALL travel through the normal native Copilot remote-prompt path and steer the active session. Stale replies SHALL fail visibly without creating a second session.

Remote projection SHALL publish each supported SDK event exactly once within the session process. Attaching to an existing extension-host session SHALL use filtered SDK event replay through the session bridge, with buffered live events and event-ID deduplication across the replay/live boundary.

### FR-5 Permission handling

When the SDK requests permission, the Telegram user SHALL be able to approve or deny the request with structured callback buttons.

Where the upstream VS Code UI and other registered remote transports present the same permission, the design SHALL support first-valid-response-wins semantics.

Telegram SHALL expose only approve-once and deny in V1. It SHALL NOT raise the session permission level to `autoApprove` or `autopilot`, directly or through a remote mode change.

Transport origin SHALL be created by the registry and carried as a discriminated internal value. SDK `SendOptions.source` strings SHALL NOT determine transport identity, effective mode or permission level; Telegram SHALL remain non-elevated while Mission Control is active in `autopilot`.

### FR-6 User questions and plan approval

Agent questions, plan-exit/approval requests and other supported interactive inputs SHALL be representable remotely where the underlying SDK/session exposes a response API.

The implemented question path supports callback choices and a freeform reply to the correlated question bubble.

The implemented plan-exit bridge allows only non-elevating outcomes offered by the live request, including `interactive` or `exit_only`, plus denial/feedback. Telegram and Mission Control SHALL NOT select `autopilot`, `autopilot_fleet`, `autoApproveEdits` or otherwise raise the permission policy through the plan-response path.

Local VS Code, Mission Control and Telegram SHALL continue to use first-valid-response-wins semantics for the same live request.

### FR-7 Models

The Telegram UI SHALL display the currently selected model.

The project SHOULD use the Copilot SDK model catalogue/session model APIs as an authoritative source for native Copilot CLI-backed agent sessions.

VS Code language-model discovery MAY supplement that catalogue. Configured VS Code language models SHALL enter the existing agent harness only through the authenticated bridge implemented by this project; discovery alone MUST NOT imply that every `vscode.lm` model supports the full Copilot agent harness.

### FR-8 Local/BYOK providers

The design SHALL remain compatible with supported Copilot/VS Code model-provider paths, including compatible local or OpenAI-style endpoints when the active runtime/provider supports them.

Provider credentials SHALL NOT be sent through Telegram.

No backend SHALL be advertised as fully compatible until the corresponding model/provider matrix has been exercised.

### FR-9 Workspace and session context

Telegram SHALL show enough context to prevent accidental operations in the wrong project, including where available:

- workspace/folder,
- repository,
- branch,
- session title/id,
- current mode,
- current model.

Every session-facing action SHALL revalidate the selected session against the current consented workspace scope rather than trusting a previously persisted session ID alone.

### FR-10 Settings and onboarding

The bundled-fork build SHALL provide a first-run setup flow for:

- Telegram bot token entry,
- Telegram pairing,
- disclosure that Telegram bot chats are not end-to-end encrypted,
- exact-workspace consent,
- security defaults.

Proposed-API enablement for a future independent/own-ID extension is a separate experimental path, not a V1 setup requirement for the bundled fork.

Sensitive secrets SHALL use VS Code secret storage or an equivalently protected local mechanism.

## 7. Non-functional requirements

### NFR-1 Minimal upstream delta

Upstream Copilot source modifications SHOULD be restricted to a small number of explicit integration seams. Generic downstream code SHALL live under `extension/remoteControl` and concrete adapter code under `extension/telegramRemote`.

### NFR-2 Upstream compatibility

Every release SHALL record the upstream VS Code commit and Copilot extension version against which it was built.

The project SHALL support regular rebase/sync against `microsoft/vscode`.

Agent Host ownership/session-storage assumptions SHALL be compatibility-tested because they are implementation-sensitive.

### NFR-3 Fail closed

If pairing, permission state, session ownership, session routing or security state is ambiguous, remote actions SHALL be denied or ignored rather than guessed.

### NFR-4 No silent command loss

Every accepted Telegram control message SHALL result in one of:

- immediate acknowledgement/dispatch without awaiting the full agent turn,
- queued/steering state,
- explicit rejection,
- explicit error.

### NFR-5 Recoverability

Temporary Telegram failures, VS Code reloads and transient network errors SHOULD recover without corrupting the active Copilot session.

### NFR-6 Testability

Telegram transport, routing, permission mapping, Agent Host handover and event rendering SHALL be testable without a real Telegram account through mock Bot API and mock/session-service interfaces where practical.

### NFR-7 Deterministic lifecycle

Session references, SDK listeners, pending-response waiters and the Telegram poller lease SHALL have explicit owners and deterministic disposal. Only one consumer may long-poll a bot token; a competing consumer fails visibly.

### NFR-8 Bounded remote work

Pairing attempts, authorized messages, callbacks, outbound Bot API work and transient retries SHALL be bounded. A stopped/replaced lifecycle generation SHALL not deliver stale queued work.

### NFR-9 Redacted operability

Lifecycle diagnostics and release compatibility metadata SHALL omit credentials and user content. Release artifacts SHALL record exact source compatibility, licenses and checksums and SHALL identify the remote-control framework as an internal bundled-fork boundary.

## 8. V1 scope

V1 includes:

- VS Code Desktop/local extension host.
- Telegram Bot API long polling.
- One configured Telegram bot.
- Explicit Telegram user pairing/allowlist.
- Existing extension-host Copilot CLI session discovery/control.
- Agent Host-owned session discovery plus explicit idle-session fork/handover into a Remote Pilot controller session.
- Session prompt and mid-turn steering.
- Abort.
- Activity projection.
- Permission responses.
- User-question responses.
- Non-elevating plan-exit responses.
- Model/mode visibility and supported selection.
- Basic session/workspace metadata.
- Read-only bounded workspace-file browsing.
- Secure bot token storage.
- Bundled VS Code fork packaging/configuration.
- Optional V2 proposal-registration/setup research for a future own-ID companion extension.
- Upstream sync metadata.

## 9. Explicit non-goals for V1

- Reimplementing the Copilot agent runtime.
- Replacing the native VS Code Copilot UI.
- Screen scraping or UI automation.
- Guaranteeing hidden chain-of-thought access.
- Direct multi-client AHP control of a live Agent Host session.
- Multi-user SaaS operation.
- Multiple computers under one bot identity.
- Slack/Teams/Discord transports.
- Telegram Mini App.
- Rich web dashboard.
- Tailscale dependency.
- Remote SSH/Dev Containers/Codespaces support guarantees.
- Public Visual Studio Marketplace publication while proposed APIs and source-level Copilot internals remain required.

## 10. Success criteria

V1 is successful when a developer can:

1. install/run the matching bundled VS Code fork build,
2. complete first-run setup and explicit workspace consent,
3. pair a Telegram account,
4. select an existing extension-host Copilot session or hand over an eligible idle Agent Host-owned session into a new Remote Pilot fork,
5. observe an agent executing work,
6. send a steering instruction while it is working,
7. approve/deny an operation remotely,
8. answer an agent question remotely,
9. answer a non-elevating plan-exit request remotely,
10. stop the task remotely,
11. return to VS Code and continue using the selected controller session without a Telegram-owned parallel conversation state.

The same acceptance run must also show that Mission Control behavior remains unchanged after the registry refactor, that a second poller cannot consume the configured bot token, and that Agent Host handover refuses a source session that is still in use.

## 11. Technical principles

1. **Reuse upstream first.** If Copilot already provides it, call it rather than recreating it.
2. **Transport independence.** Agent/session logic must not depend on Telegram-specific types.
3. **Native request lifecycle.** Remote prompts use the existing pending-context + VS Code chat command path; Telegram never fabricates a tool token or bypasses `handleRequest()`.
4. **Explicit session ownership.** Extension Host and Agent Host ownership are distinguished; remote continuity never bypasses the Agent Host in-use lock.
5. **Structured commands.** Permissions and destructive actions use callback IDs/state, never natural-language guessing.
6. **Explicit context.** Always show and revalidate session/workspace identity on remote control surfaces.
7. **Secure by default.** Unpaired users receive no session information and remote input cannot raise permission level.
8. **Observable behavior, not hidden CoT.** Render reliable agent events and readable reasoning only when explicitly exposed.
9. **Rebaseability with a deliberate seam.** Accept the narrow Copilot session/service hooks because they remove transport-specific branches and reduce later conflicts.
10. **Do not overclaim Agent Host integration.** Current support is discovery plus controlled fork/handover, not direct AHP multi-client control.

## 12. Upstream dependencies

Primary source dependencies:

- `ChatSessionsContrib` service composition: [`../../src/extension/chatSessions/vscode-node/chatSessions.ts`](../../src/extension/chatSessions/vscode-node/chatSessions.ts)
- Session service and Agent Host handover: [`../../src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts`](../../src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts)
- Active SDK session wrapper / Mission Control: [`../../src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`](../../src/extension/chatSessions/copilotcli/node/copilotcliSession.ts)
- SDK/models: [`../../src/extension/chatSessions/copilotcli/node/copilotCli.ts`](../../src/extension/chatSessions/copilotcli/node/copilotCli.ts)
- MCP bridge: [`../../src/extension/chatSessions/copilotcli/node/mcpHandler.ts`](../../src/extension/chatSessions/copilotcli/node/mcpHandler.ts)
- Generic remote-control contract: [`../../src/extension/remoteControl/common/remoteControlTypes.ts`](../../src/extension/remoteControl/common/remoteControlTypes.ts)
- Native remote prompt dispatcher: [`../../src/extension/remoteControl/vscode-node/remotePromptDispatcher.ts`](../../src/extension/remoteControl/vscode-node/remotePromptDispatcher.ts)
- Telegram session picker/handover routing: [`../../src/extension/telegramRemote/node/telegramCommandRouter.ts`](../../src/extension/telegramRemote/node/telegramCommandRouter.ts)

External specifications:

- https://docs.github.com/en/copilot/how-tos/copilot-sdk/features
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence
- https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- https://core.telegram.org/bots/api
