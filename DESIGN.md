# Plyfold design notes

## Decisions

- **macOS only** to start with
- **The UI is fully custom** (Tauri + our own UI). We do not use the native Liquid Glass: it cannot be used throughout a WebView, so it would end up half-applied
- **We do not write our own agent loop**. Plyfold is an ACP client that drives existing CLIs (Claude Code, Codex, OpenCode, Gemini CLI) behind the scenes
- **Registering multiple API keys for one CLI is a core requirement**
  - A "profile" is CLI × credentials × config directory
  - Keys live in the Keychain and are passed as environment variables at launch. Key-related environment variables from the parent process are not inherited
  - Custom endpoints (proxies, gateways) are supported as a generic "endpoint URL + key" feature; no specific provider is built in
- **Sessions (records) and panes (views) are separate**
  - Session: the unit of record Plyfold owns (the log of ACP traffic, the worktree, the profile)
  - Pane: only a view onto a running session. Closing it keeps the record
- **Each session gets its own git worktree**. Diffs are built from git, not from ACP diffs
- **Fork** opens a new session with `session/fork` (the agent keeps the conversation; it does not resend it, so the transcript is copied from Plyfold's log). The new session gets its own worktree, branched from the source's current commit; uncommitted files stay behind. Forking into the same workspace is refused while any agent is already running there, so two agents never edit one directory. A worktree shared that way is removed only when the last session using it is deleted or cleaned up, and its changes cannot be discarded while another session still uses it. Gemini CLI does not advertise fork

## Layout

```
crates/
  plyfold-acp       ACP client. Our own JSON-RPC transport + the official schema (agent-client-protocol-schema 1.18, v1)
                    plyfold-mock-agent (a mock agent for tests and UI work; uses no tokens)
  plyfold-profile   Profile resolution, Keychain, built-in agent definitions
  plyfold-store     Sessions and the event log (SQLite)
  plyfold-worktree  Per-session worktrees, and diffs that include untracked files
  plyfold-core      The engine. Ties the four crates above together and publishes state changes as EngineEvent (the UI talks only to this)
  plyfold-cli       Developer CLI (plyfold start / resume / sessions / log / diff / rm / keys)
  plyfold-probe     ACP verification and benchmarks (docs/probe-findings.md)
```

State lives in `~/Library/Application Support/plyfold/` (`config.toml`, `plyfold.db`, `worktrees/`, `profiles/`).

## Decisions driven by the probes (docs/probe-findings.md)

| Finding | How the design handles it |
|---|---|
| Only Claude returns diffs | Diffs are built from the worktree with git |
| "Reject" means different things per agent (the turn continues / ends) | The UI shows "reject and continue" and "stop" as separate actions |
| The reported auth status is unreliable (says "subscription" even with an API key) | Plyfold keeps and displays the profile name and endpoint itself |
| Some agents stop without finishing their work | If nothing arrives for a while during a turn, the session becomes `Stalled` and the user is notified |
| The response (end of turn) can overtake notifications | The transport inserts a "barrier": every notification of the turn is delivered before the end of the turn is reported |
| Errors can come back as ordinary messages | Open. We still need a way to detect errors inside messages |
| Unknown session/update variants can arrive | Always keep the raw JSON, and treat it as typed only when it parses into a known type |
| Notices from gateways get mixed into messages | Open. There is no way yet to tell them apart from model output |

## Engine contract

- `start_session` → create the worktree → resolve the profile → launch the agent → session/new → set_mode (if a default_mode is set)
- `reopen_session` restores the context if the agent supports session/load. Otherwise it creates a new session and emits a Notice that the context was lost
- When the app restarts, sessions that were running last time become `Closed` (the record and the worktree are kept)
- On interrupt, pending permission requests are answered with "cancelled" before session/cancel is sent (as ACP requires)
- All ACP traffic is written to the event log with keys redacted

## Open questions

- Which interaction patterns to borrow from Claude Code, OpenCode and Codex (under discussion)
- (Decided) Diffs are viewed in a full-screen view opened from the diff count in a pane, with a file list and unified / split views
- (Decided) Worktree cleanup happens from the diff view: commit → merge with --no-ff into the branch currently checked out in the original repository (on conflict, abort and restore) / push to origin and open a PR with gh / discard back to the base commit. None of these are allowed mid-turn
- The worktree itself is deleted when the session is deleted (whether to delete it automatically after merging is undecided)
