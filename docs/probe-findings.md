# ACP probe findings (2026-11-16)

Results gathered with `plyfold-probe`. The ACP Rust SDK is `agent-client-protocol` 5.3.0 (schema 1.18.0, protocol v1).

## Capabilities at initialize and session/new

| Item | claude | codex | gemini | opencode |
|---|---|---|---|---|
| Adapter | @agentclientprotocol/claude-agent-acp 0.107.0 | @agentclientprotocol/codex-acp 2.6.0 | gemini-cli 0.68.0 (`--experimental-acp`) | opencode 2.3.0 (`opencode acp`) |
| session/load | yes | yes | yes | yes |
| Session capabilities | list, resume, fork, close, delete, title, status, options, systemPrompt, additionalDirectories | list, resume, fork, close, delete, title, subagents, systemPrompt, additionalDirectories | none | list, resume, fork, close, delete, additionalDirectories |
| Prompt | image, embeddedContext | image, embeddedContext | image, audio, embeddedContext | image, embeddedContext |
| MCP | http, sse | http | http, sse | http |
| Auth methods | none (status is sent via `auth/status_update` notifications) | api-key, chat-gpt | oauth-personal, gemini-api-key, vertex-ai, gateway | opencode-login |
| Modes | default, acceptEdits, plan, auto, bypassPermissions | read-only, workspace-write, agent, agent-full-access | - | - |
| Config options | mode, model, effort, fast, ultracode, agent | mode, collaboration_mode, model, reasoning_effort, fast-mode | - | model, effort, mode |

## Results of sending real prompts

| What we checked | claude | codex | opencode |
|---|---|---|---|
| Diffs for file edits | yes: `type: diff` in the `tool_call` content | not checked (blocked by the config issue below) | no: the content is text only, no diff |
| Permission requests | yes: `allow_once` / `allow_always` / `reject_once` (when running a command not allowed under `--mode default`) | not checked | none appeared (everything is allowed by default) |
| Cancel | yes: `stopReason: cancelled`, 31 ms after cancel | not checked | not checked |
| Reopen | yes: `session/load` replayed 9 history notifications | not checked | not checked |
| File reads/writes | the agent writes files itself (no `fs/*` requests arrived) | - | same |

## Findings (impact on the design)

1. **All four agents have the five basics**. Every one supports session/load (and all but Gemini also fork and list), so a session-centered design works. Plyfold still keeps its own event log (Gemini has no list)
2. **Plyfold has to build diffs itself**. OpenCode returns no diffs, so building them from the worktree with git diff is the reliable path. ACP diffs are treated as "use if present"
3. **The default profile uses the existing configuration as is**
   - Permissions: allow rules in `~/.claude` apply, so permission requests may not appear
   - Codex: the existing config pointed to a custom provider whose key environment variable was not set, so it stalled
   - The error came back not as an RPC error but as **an ordinary message followed by `end_turn`**. The UI cannot tell it is an error
   - → Isolated profiles are needed both for multiple keys and for reproducibility
4. **Auth status is available over ACP**. Claude and Codex send the account name and plan via `auth/status_update` and `_auth/status_update` notifications. Useful for the profile screen
5. **How API keys are passed differs per CLI**. Codex and Gemini have `api-key`-style auth methods (with `_meta.api-key.provider`). Claude has no auth method, so keys will likely be passed through environment variables (to be confirmed)

## Isolated profiles (with a key for a third-party proxy)

We launched with a profile-specific `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and a key from the Keychain. One key was used for both Claude Code (Anthropic format) and Codex (Responses API).

| What we checked | claude (via proxy) | codex (via proxy) |
|---|---|---|
| Launch and session creation | yes | yes |
| Permission requests | yes (`--mode default`) | yes (`--mode read-only`). Options: `allow_once` / `accept_execpolicy_amendment` (kind allow_always) / `cancel` (kind reject_once) |
| On reject | The tool fails and the turn continues (`end_turn`) | **The whole turn ends** (`stopReason: cancelled`) |
| Diffs | yes: `type: diff` | no: files are written through the shell too (`printf > file`), so no diff arrives |
| Three at once | yes: a regular login, Claude via proxy and Codex via proxy ran without mixing credentials | |
| Key values | not present in the transcript or stderr (redaction works) | |

### Findings

6. **Isolated profiles work**. Just separating the config directory and environment variables let us use multiple credentials at once without touching the regular configuration
7. **Only Claude returns diffs**. Codex and OpenCode do not. We can commit to Plyfold building diffs from the worktree with git diff
8. **"Reject" means different things per agent** (the turn continues or ends). The UI has to show "reject and continue" and "stop" as separate actions
9. **The reported auth status is unreliable**. Even when running on a key (`ANTHROPIC_AUTH_TOKEN`), the adapter reported `"Claude subscription" / "OAuth token"`. Plyfold keeps and displays the profile name and endpoint itself
10. **Notices from Claude Code get mixed into responses**. A warning about the gateway arrived as an `agent_message_chunk` after the model's answer. There is currently no way to tell it apart from model output
11. **The model behind a proxy can be checked through ACP metadata**. `_meta._claude/model` in `usage_update` carries the actual model name returned by the API. The configured display value (`currentValue: opus`) and the model's own claims are not reliable

12. **A custom endpoint can be inspected by calling the API directly**. Look at the shape of `model` and `id` in the response, the token counts, and the response headers (names of the relaying gateways). What we found about this proxy:
    - In both formats, the response carried the same custom model name, not the one we requested
    - The response was in Anthropic format, yet its `id` had the shape of an OpenAI Responses API id (`resp_…`)
    - A prompt of a few words was billed as thousands of input tokens (hidden instructions are being added)
    - The response headers showed that the request passed through several relaying gateways, including one that turns a subscription account into an API
    - → For profiles that use a custom endpoint, Plyfold shows "the model that actually responded". We are also considering a connection check in the settings screen (a direct check like this one)

## Next to check

- [x] Does an isolated profile work with only a key? → confirmed with the proxy key
- [x] Can `parallel` run sessions with different credentials at the same time? → confirmed
- [x] Run Codex in an isolated profile and check diffs and permission requests → confirmed (cancel not checked)
- [ ] Codex cancel
- [ ] OpenCode cancel and reopen
- [ ] Gemini: authenticate with an API key, then run (`--auth gemini-api-key`)
- [ ] The environment variable that isolates OpenCode's configuration (is `XDG_DATA_HOME` enough?)

## Benchmark (`plyfold-probe bench`, 2026-11-16)

We compared the direct routes with routes through a third-party proxy under the same conditions. On each route, four kinds of randomly generated problems were each solved twice.

| Item | Claude direct | Claude proxy | GPT direct (ChatGPT login) | GPT proxy |
|---|---|---|---|---|
| Configured model | opus / medium | opus | gpt-6-luna / medium | gpt-6-luna / medium |
| Model name returned by the API | claude-opus-5-5 | a custom name | not available | not available |
| Token difference (same text) | 4372 | 3758 | 1083 | 1025 |
| Correct | 8/8 | 6/8 (2 timed out) | 0/8 | 8/8 |
| Total time (median) | 22.8s | 48.0s | 2.8s | 35.8s |

- **The same model name behaved completely differently**: the direct gpt-6-luna answered in about 3 seconds and got everything wrong; the proxy's gpt-6-luna took about 36 seconds and got everything right. It is not the model its name says
- **Token-count fingerprinting is not conclusive**: the token counts are reported by the proxy itself, so they may be the relaying gateway's own estimate
- The direct ChatGPT login could not use `gpt-6.1-sol` (not supported). The proxy accepts that name

## Coding benchmark (`plyfold-probe codebench`, 2026-11-16)

We compared four small Rust tasks (expression evaluation, an O(1) LRU, fixing a bug in existing code, an INI parser). Scoring uses visible tests and hidden tests.

| Route | Correct | Total time | Tool calls |
|---|---|---|---|
| Claude direct | 4/4 | 148s | 3–3 |
| Claude proxy | 4/4 | 438s | 9–14 |
| GPT direct (gpt-6-luna) | 4/4 | 152s | 4–6 |
| GPT proxy | 4/4 | 1488s (one task hit the 900 s limit; the code was already complete) | 5–9 |

- At this difficulty the number of correct answers did not differ. The differences were in **speed and number of steps** (the proxy was 3–10x slower) and in **how runs ended** (sometimes the agent kept going after the work was done)
- The direct gpt-6-luna scored 0/8 on tool-less mental arithmetic but solved every task in this format, where it can run code. Problems solved purely in the head, without tools, do not reflect an agent's real ability
- No route modified the tests or Cargo.toml
