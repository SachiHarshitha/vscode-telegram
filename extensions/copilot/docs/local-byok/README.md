# Local BYOK build: Copilot + self-hosted models

This build of the Copilot extension lets **Copilot Business/Enterprise seats** use self-hosted,
OpenAI-compatible models (for example vLLM) next to the Copilot models. A typical use is running
the Explore subagent, which makes many search and read calls, on a local model while the main
agent stays on a Copilot model.

## What changes compared to the stock extension

| | Stock | Local build |
|---|---|---|
| Managed seat without the `client_byok` org policy | No BYOK | **Custom Endpoint provider only** |
| Individual / internal seats, signed out | All BYOK providers | All BYOK providers (unchanged) |
| Anthropic, OpenAI, Gemini, xAI, OpenRouter, Azure, Ollama providers for managed seats | Off | Off, and hidden in Manage Models |
| Allowed Custom Endpoint hosts | Any | `localByok.allowedHosts` in the packaged `package.json` (default `*`) |

Stock builds are unaffected: the `localByok` field exists only in VSIXs produced by
`scripts/package-local-copilot.ps1`.

Code: `getClientBYOKAccess` / `isUrlAllowedByLocalBYOKPolicy` in
`src/extension/byok/common/byokProvider.ts`, provider registration in
`src/extension/byok/vscode-node/byokContribution.ts`, context keys in
`src/extension/contextKeys/vscode-node/contextKeys.contribution.ts`.

## Build

Copilot ships built into VS Code. A user-installed copy is only loaded when its version is
**strictly greater** than the built-in one, and its `engines.vscode` must match the installed
VS Code. So build from the release branch of the stable VS Code your users run, not from `main`.

```powershell
git fetch upstream release/1.139
git switch feature-local            # based on upstream/release/1.139
./scripts/package-local-copilot.ps1 -Install          # -Install runs npm ci; needed after switching branches
# restrict hosts later if IT wants to:
./scripts/package-local-copilot.ps1 -AllowedHosts 'vllm.corp.internal','*.gpu.corp.internal' -BuildNumber 2
```

The VSIX is written to `.build/local-copilot/copilot-chat-<major>.<minor>.<yyyyMMdd><NN>.vsix`,
for example `0.67.2026092301`. That is above the built-in `0.67.0` and below the next release's
`0.68.0`.

### Monthly VS Code update

When VS Code updates (for example to 1.140, bundling Copilot 0.68.0), the built-in copy has the
higher version and VS Code falls back to it: local models disappear, nothing breaks. Rebase
`feature-local` onto the new `upstream/release/1.1xx` and rebuild. Do **not** use a
much higher version (for example `0.99.0`) to avoid this: it would keep overriding newer built-in
copies and break when the proposed APIs change.

## Install

```powershell
code --install-extension .build/local-copilot/copilot-chat-0.67.2026092301.vsix --force
```

In the Extensions view, **GitHub Copilot** should show the stamped version. If it still shows
`0.67.0`, the VSIX version is not higher than the built-in one; the log (**Help > Toggle
Developer Tools**) shows `Skipping extension ... in favour of the builtin extension`.

## vLLM server

Agent mode and subagents need tool calling. Start vLLM with a tool parser that matches the model:

```bash
vllm serve Qwen/Qwen2.5-Coder-32B-Instruct \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --max-model-len 65536
```

An API key is optional (`--api-key`).

## Configure the models

**Chat: Manage Language Models** > **Add Models** > **Custom Endpoint**, or edit
`chatLanguageModels.json` directly.

Discover every model from the server (needs a vLLM version that reports `max_model_len`):

```jsonc
{
  "vendor": "customendpoint",
  "name": "vLLM",
  "url": "http://vllm-host:8000/v1"
  // "apiKey": "${input:...}"   // only if the server uses --api-key
}
```

Discovered models are assumed to support tool calling; the context window comes from
`max_model_len`, and output is capped at 16K tokens or a quarter of the window.

Or list models explicitly, which controls names and limits:

```jsonc
{
  "vendor": "customendpoint",
  "name": "vLLM",
  "models": [
    {
      "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
      "name": "Qwen2.5 Coder 32B",
      "url": "http://vllm-host:8000/v1",
      "toolCalling": true,
      "vision": false,
      "contextWindow": 65536,
      "maxOutputTokens": 8192
    }
  ]
}
```

## Use a local model for Explore

```jsonc
// settings.json
"chat.exploreAgent.defaultModel": "Qwen2.5 Coder 32B (customendpoint)"
```

Pick the value from the setting's dropdown to get the exact name. Custom agents can target the
model with `model: Qwen2.5 Coder 32B (customendpoint)` in their `.agent.md` front matter.

## Troubleshooting

- **No "Custom Endpoint" in Add Models**: the VSIX is not active (see Install), or the
  `github.copilot.clientByokEnabled` context key is false. Check **Output > GitHub Copilot Chat**
  for `BYOK: registered 1 provider(s) (customEndpointOnly): customendpoint`.
- **Group added but no models**: the server does not report `max_model_len`, or the URL is not
  allowed by `allowedHosts` (the log says so). List the models explicitly instead.
- **Explore fails or loops**: the server was started without `--enable-auto-tool-choice`, or the
  model handles parallel tool calls poorly. Try a larger model.
