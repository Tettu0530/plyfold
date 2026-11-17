# Plyfold

Plyfold is a macOS desktop app for running coding agents side by side. It drives existing agent CLIs (Claude Code, Codex, OpenCode and Gemini CLI) over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Each session gets its own git worktree, and you can keep several API keys for the same CLI.

Plyfold does not implement its own agent loop. It is an ACP client: the agent CLI does the model calls, tool use and file edits, and Plyfold launches it, shows what it does, answers its permission requests and handles the git side.

![Two sessions side by side: one is running cargo test and showing an inline diff, the other has just written a CHANGELOG entry](docs/assets/screenshot.png)

## Why

- **Multiple keys per CLI.** A *profile* is a CLI plus credentials plus a config directory. You can have a `work` and a `default` profile for Claude Code, each with its own key or endpoint, and pick one per session. Keys live in the macOS Keychain and are passed to the agent only as environment variables at launch.
- **One worktree per session.** Agents work in their own git worktree, so parallel sessions don't edit the same files and your checkout stays as it is. Diffs come from git, not from the agent, so they look the same for every CLI.
- **Panes.** A session is the record (ACP log, worktree, profile). A pane only shows a running session. Close a pane and the session is still there in the sidebar.
- **Motion.** Springs use the same formula as SwiftUI, and popovers and permission cards separate from the element they come from, like liquid. With Reduce motion turned on in macOS, animations become fades.

![The new session screen with three profiles and their usage over the last 30 days](docs/assets/new-session.png)

## Features

- Sessions grouped by repository in the sidebar, with their status (Working, Waiting for permission, Stalled, Idle, Stopped, Error) shown as an icon and a word
- Free pane layout: split any pane left, right, up or down, as many times as you like, or pick the 1, 2 or 4 pane presets. Drag the boundary between panes to resize them (double-click to split evenly)
- Drag a session from the sidebar onto a pane to open it there, or onto a pane's edge to open it in a new split. Drag a pane by its header to move it next to another pane or swap the two; the drop area is outlined before you let go
- A resizable, collapsible sidebar (drag its edge; ⌘B to toggle), with a compact one-line-per-session layout in Settings
- Transcript with messages, thoughts, tool calls, inline diffs and the agent's plan; it follows new output only while you are at the bottom, with a button to jump back down
- Click an image (attached or sent) to view it large
- Preview pane: open a dev server the agent started (localhost URLs found in command output, including background shells) or any URL in a pane, in a sandboxed frame with reload and "open in browser"
- Model, effort and mode switches under the composer (⇧⇥ cycles modes), plus context usage, tokens in and out, tok/s and cost where the agent reports them
- Messages typed during a turn are queued and sent when the turn ends; images and files can be attached from the + menu or with ⌘U, by pasting, or by dropping them on a pane
- Type `@` in the composer to pick a file from the session's working directory (git-tracked and untracked files, ignored ones left out); it is inserted as `@path` and attached as an ACP resource link
- Permission cards inside the pane, also shown in the sidebar and as notifications
- A session is marked Stalled when nothing arrives during a turn for a set time (120 seconds by default)
- Changes view built from git, including untracked files, with unified and split layouts
- From the Changes view: commit, merge into the branch currently checked out in the original repository (`--no-ff`; on conflict the merge is aborted and the repository restored), push and open a pull request with `gh`, discard back to the base commit, or open the worktree in Zed, Cursor, VS Code or Finder
- Profiles per agent with three kinds of authentication: the CLI's existing login, the official API with a key, or a custom provider (base URL plus key)
- Optional separate config directory per profile, so its login and history don't mix with your usual CLI setup
- Connection test per profile: configured model, the model the agent reports, and time to first text. When the two models differ, sessions with that profile show the reported model in the pane header
- ⌘K to search sessions and commands
- Sessions can be reopened later. If the agent supports `session/load`, the conversation context comes back too
- Every ACP message is written to an event log, with secrets redacted

## Supported agents

These are built in. Plyfold starts each one as an ACP server over stdio.

| Agent | Command Plyfold runs | Config directory variable | Key variables not inherited by non-default profiles |
|---|---|---|---|
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.107.0` | `CLAUDE_CONFIG_DIR` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `npx -y @agentclientprotocol/codex-acp@2.6.0` | `CODEX_HOME` | `OPENAI_API_KEY`, `CODEX_API_KEY` |
| OpenCode | `opencode acp` | `XDG_DATA_HOME` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` |
| Gemini CLI | `npx -y @google/gemini-cli@0.68.0 --experimental-acp` | none | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |

The adapter versions are pinned. OpenCode must already be installed and on your `PATH`. The others are fetched by `npx` on first use. Gemini CLI has no config directory variable, so its profiles cannot use a separate config directory.

A default profile (just the agent name) passes your environment through unchanged and uses whatever login the CLI already has. A profile that sets keys or a separate config directory drops the variables in the last column from the inherited environment, so keys from your shell never leak into it.

You can override these definitions or add other ACP agents in `config.toml` under `[agents.<name>]`. There is also a `mock` agent (`plyfold-mock-agent`) for development, which uses no tokens.

## Requirements

- macOS. Plyfold is macOS only (it uses the Keychain and macOS paths)
- Xcode Command Line Tools
- Rust, latest stable (via [rustup](https://rustup.rs)). The workspace uses edition 2024
- Node.js 22.12 or later, with npm
- git
- The agent CLIs you want to use, and their logins or API keys. `npx` (bundled with Node) is enough for Claude Code, Codex and Gemini CLI. OpenCode needs `opencode` installed
- Optional: [GitHub CLI](https://cli.github.com) (`gh`), logged in, for creating pull requests from the Changes view

## Building and running from source

```sh
git clone https://github.com/Tettu0530/plyfold.git
cd plyfold/apps/desktop
npm install
npm run tauri dev
```

`npm run tauri dev` starts the Vite dev server on port 1420 and builds and launches the app. The first Rust build takes a while.

`npm run tauri build` builds an app bundle. It is not signed or notarized.

Tests:

```sh
cargo test --workspace     # from the repository root
cd apps/desktop && npm test
```

There is also a headless development CLI that drives the same engine:

```sh
cargo run -p plyfold-cli -- profiles
cargo run -p plyfold-cli -- start claude --repo /path/to/repo
```

## Where settings and data live

Everything is under `~/Library/Application Support/plyfold/`:

| Path | Contents |
|---|---|
| `config.toml` | Profiles and agent overrides |
| `settings.json` | App settings (language, send key, editor, stall timeout, worktree defaults) |
| `plyfold.db` | Sessions and the ACP event log (SQLite) |
| `worktrees/` | One git worktree per session |
| `profiles/<name>/` | Separate config directories for profiles that use one |

API keys are not stored in these files. They are kept in the macOS Keychain under the service name `plyfold`, with the account `<profile>/<VARIABLE>`. The UI shows only the last four characters.

## Project layout

```
apps/desktop/          Tauri 2 app: React + TypeScript UI (src/), Rust commands (src-tauri/)
crates/
  plyfold-acp          ACP client (JSON-RPC over stdio) and plyfold-mock-agent
  plyfold-profile      Profiles, Keychain access, built-in agent definitions
  plyfold-store        Sessions and the event log (SQLite)
  plyfold-worktree     Per-session worktrees, diffs, commit / merge / PR / discard
  plyfold-core         The engine: ties the crates above together and emits events to the UI
  plyfold-i18n         Engine messages in Japanese, English and Simplified Chinese
  plyfold-cli          Development CLI (plyfold profiles / sessions / start / resume / log / diff / rm / keys)
  plyfold-probe        ACP checks and benchmarks across agents
docs/                  Design notes, i18n rules, probe findings, screenshots
tools/liquid-probe/    Measures Apple's Liquid Glass motion to tune the animations
```

See [DESIGN.md](DESIGN.md) for the design decisions and [docs/probe-findings.md](docs/probe-findings.md) for how the agents differ over ACP.

## Languages

The UI is available in Japanese, English and Simplified Chinese. By default it follows the macOS language and falls back to English. You can change it in Settings.

## Status

Plyfold is early. There is no prebuilt release yet, and the app is not signed, so for now you build it from source. Expect rough edges and breaking changes to `config.toml` and the database.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md) and do not open a public issue.

## License

[MIT](LICENSE)
