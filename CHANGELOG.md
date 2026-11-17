# Changelog

All notable changes to Plyfold are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org). While the version starts with 0, any release may change `config.toml`, `settings.json` or the database.

## [Unreleased]

### Sessions

- Open a conversation the CLI already has, from the new-session screen, in its own worktree. Gemini CLI has no conversation list
- Side chat (⌘J, or the button in the pane header): ask about a session without adding to its conversation, even while it works. It is a read-only fork in the same workspace; edits and commands are declined, answers can be added to the main input, and closing it clears it. Gemini CLI cannot fork

### Git

- Git and the changes are one view, opened from the pane header (⌘⇧D): the branch, its base and upstream, fetch, push and pull, the pull request and the commits sit above the changed files. The separate Git menu is gone
- A session working in the repository itself also shows its uncommitted changes (against HEAD). Commit, merge and discard stay with worktree sessions

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

[0.1.0]: https://github.com/Tettu0530/plyfold/releases/tag/v0.1.0
