# Changelog

All notable changes to Plyfold are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org). While the version starts with 0, any release may change `config.toml`, `settings.json` or the database.

## [Unreleased]

### Fixed

- On macOS the window buttons sit centred in the header, level with the sidebar button, and a little further from the edge
- On Windows the app no longer opens a Command Prompt window beside itself
- Windows and Linux draw thin, rounded scrollbars on a transparent track instead of the system's grey bars
- A button the liquid pulls on stretches by a few pixels at most, and rows inside menus no longer move, so a wide row (the effort row) does not stick out past its menu; the effort submenu grows out of its chevron

### Platforms

- Linux (preview): AppImage and `.deb` packages, API keys in the Secret Service (GNOME Keyring, KWallet), the distribution's name in Settings → Info, and WebKitGTK's DMA-BUF renderer turned off by default (it draws a blank window on some GPUs)

## [0.2.0] - 2026-11-18

Side chats, everyday conversations and a Git pane, for macOS (Apple Silicon) and Windows 10/11 (x64).

### Sessions

- Open a conversation the CLI already has, from the new-session screen, in its own worktree. Gemini CLI has no conversation list
- Everyday conversations: choose Conversation on the new session screen to talk without a repository. Each runs in a folder of its own, may search and read the web, and does not edit files or run commands (the agent is put in a mode that asks, and Plyfold declines). They are grouped apart from the repositories in the sidebar. Their mode cannot be changed (a mode that acts without asking would get past the policy), so they have no mode picker
- Side chat (⌘J, or the button in the pane header): ask about a session without adding to its conversation, even while it works. It is a read-only fork in the same workspace; edits and commands are declined, answers can be added to the main input, and closing it clears it. Gemini CLI cannot fork

### Git

- Git and the changes are one pane, opened next to the session from its header (⌘⇧D): the branch, its base and upstream, fetch, push and pull, the pull request and the commits sit above the changed files, with the diff beside them (in a narrow pane, a file's diff takes the list's place). The column is resizable. The separate Git menu and the full-window changes screen are gone
- A worktree removed outside Plyfold no longer breaks the Git pane: the session continues in the original repository
- A session working in the repository itself also shows its uncommitted changes (against HEAD). Commit, merge and discard stay with worktree sessions

### Composer

- Model and effort share one chip and one menu: the models, then Effort › with the levels in a submenu
- Web searches and page fetches read better: a search lists its hits as links (title and site, opening in the browser), a fetch shows the page as a link and the agent's answer as Markdown, each with its own icon
- Math in messages is typeset with KaTeX: `$…$`, `$$…$$`, `\(…\)` and `\[…\]` (`$$` may run into the formula across lines; code is left as written; a formula KaTeX cannot read is shown as typed)
- Sent messages that start with a slash command show it in blue in the conversation too
- Slash commands: a whole command at the start of the message turns blue, its input hint shows faintly after it, and values its argument can take (from the hint's `[a|b]` choices, or the session's models for `/model`) are offered as you type; ⇥ takes one
- Queued messages can be edited in place (the pencil, or double-click). While one is being edited it is not sent, nor anything after it; saving sends it if the agent is idle. The side chat queues messages typed mid-turn too

### App

- The working indicator is a twelve-bar spinner

### Fixed

- A turn cut off by quitting the app (or the agent exiting) no longer looks like it is still generating after the next start; it ends as interrupted
- After a pull request is merged on the host and its branch deleted there, the branch's commits are no longer shown as unpushed

## [0.1.0] - 2026-11-17

The first release, for macOS (Apple Silicon) and Windows 10/11 (x64; new, please report what doesn't work).

### Agents and profiles

- Runs Claude Code, Codex, OpenCode and Gemini CLI over the Agent Client Protocol, with pinned adapter versions; other ACP agents can be added in `config.toml`
- Several profiles per CLI: the CLI's existing login, an API key, or a custom endpoint (base URL plus key). Keys live in the macOS Keychain (the Credential Manager on Windows) and reach the agent only as environment variables
- Optional separate config directory per profile, so sessions with different keys can run at the same time
- Connection test per profile, and the model the API actually answered with shown next to the configured one
- Usage over the last 30 days per profile on the new session screen

### Sessions

- One git worktree per session (or work in place), sessions grouped by repository with their status
- Transcript with messages, thoughts, tool calls, inline diffs, the agent's plan, token counts, speed and cost where reported
- Permission requests in the pane, in the sidebar and as notifications
- Messages typed mid-turn are queued; images and files can be attached; `@` picks files from the working directory; `/` completes the agent's slash commands
- Model, effort and mode pickers (⇧⇥ cycles the mode); stop a turn; sessions can be reopened later
- Fork a session from its sidebar menu. The new session keeps the conversation, in its own worktree or, once the source agent has stopped, in the same workspace. A shared worktree is removed only with the last session that uses it

### Layout

- Free pane layout: split in any direction, resize, drag sessions from the sidebar and panes by their header, swap and move panes; closing a pane gives its space to its neighbours
- Preview pane for dev servers and other pages
- Collapsible, resizable sidebar; ⌘K search; changeable keyboard shortcuts

### Git

- Changes view built from git, with commit, merge into the original branch, discard and opening the worktree in an editor; open it from the pane header, ⌘K, the Git menu or ⌘⇧D
- Per pane: the branch, how far it is ahead of its base and its upstream, its commits, fetch, push, pull and pull requests via `gh`

### App

- The Plyfold logo: a P made of two panes, one with a folded corner, as the app icon and in the app
- English, Japanese and Simplified Chinese
- Settings for display size, reduced motion, notifications, defaults for new sessions and more
- Spring-based motion modelled on SwiftUI, with a fade-only mode for Reduce motion

[0.2.0]: https://github.com/Tettu0530/plyfold/releases/tag/v0.2.0
[0.1.0]: https://github.com/Tettu0530/plyfold/releases/tag/v0.1.0
