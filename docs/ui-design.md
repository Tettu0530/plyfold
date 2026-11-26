# UI design (draft)

The UI was first drawn as mockups outside the repository; this document records the decisions they led to. macOS only, Tauri + React + TypeScript. We do not use the native Liquid Glass.
Visual and motion rules follow `.claude/skills/no-ai-slop-ui/SKILL.md`.

## Visual foundation

- The shadcn/ui (Tailwind v4, Radix) dark theme (neutral). Color is used only for state and diffs
- Typefaces are Geist / Geist Mono. Numbers are monospaced
- For agent-specific components we use only AffectUI's free (MIT) ones (Tool Call Card, Code Block).
  Permission requests (Approval Card, Permission Request), the input (Run Controls) and usage (Usage Meter) are Pro, so we build our own
- Component kits aimed at landing pages (Ruixen, Pin UI, etc.) are not used in the app

## Motion (liquid glass)

- Springs with moderate bounce (0.35 s or less). Selection indicators glide with Motion's `layoutId`
- Merging and separating apply an SVG goo filter to background shapes only (never to text). At most one or two places per screen
- Where it is used: splitting and merging panes, the permission-request droplet (drops from the status dot and spreads out, then is absorbed once answered), menus growing out of chips, toggle indicators
- With macOS "Reduce motion" enabled, these become a 150ms fade
- The glass texture (background blur) is only for floating layers (popovers, dialogs, permission requests)

## Screen skeleton

```
┌ Header: repository, ⌘K search, pane layout (1 / 2 / 4) ───────────────────────────────────────────────────┐
├ Sidebar ───────────────────┬ Pane ────────────────────────────────────────────────────┬ Pane ─────────────┤
│ Sessions (by repository)   │ Header: status, title, profile, branch, diff             │                   │
│  ● title, status, +/−      │ Conversation (message / thought / tool / diff / plan)    │ Permission card   │
│ Profiles (⌘,)              │ Input + setting toggles + usage                          │                   │
└────────────────────────────┴──────────────────────────────────────────────────────────┴───────────────────┘
```

- **Sessions come first; panes are views**. Closing a pane keeps the session, which can be reopened from the sidebar (arranging panes Herdr-style does not conflict with organizing history)
- Each sidebar row shows its status (working, awaiting permission, unresponsive, idle, stopped, error) as both a colored dot and text

## Input (the best of Claude Code and OpenCode)

- **From Claude Code**: switch model / effort / mode on the spot with chips under the input. ⇧⇥ cycles through modes. Effort levels are shown as bars
  - Differences in naming between agents (`effort` / `reasoning_effort`) are absorbed by the ACP category (the engine's `set_by_category`)
  - Modes are also distinguished by color (bypassPermissions is reddish)
- **From OpenCode**: to the right of the input, show context usage (bar + used / limit), the previous turn's ↑input ↓output, tok/s and cost, in monospaced numbers
  - While streaming, show "elapsed time" and "~estimated tok/s"; after the turn, the measured tok/s
- When the configured model differs from the model name returned by the API, show a warning in the pane header

## Permission requests

- Shown as a card inside the pane (and also in the sidebar and as a notification). Buttons: "Allow once", "Always allow", "Reject", "Stop"
- "Reject" means different things per agent (in Codex it also ends the turn). When it differs, the card says so in one line
- ⏎ for "Allow once", ⌘. for "Stop"

## Diffs

- Built from git (so they work even when the agent returns no diff). New untracked files are included
- A bottom strip for what to do with the worktree's work (open in editor, commit, PR, merge into main, discard)

## New session

- The first prompt, the profile (CLI × key), the repository, and whether to use a worktree
- Config option choices are not known until the agent starts, so "the values last used with this profile" are shown as defaults

## Profiles

- Multiple profiles per agent (auth: CLI sign-in / official API key / custom provider (base URL + key))
- Keys live in the Keychain. Only the last 4 characters are shown
- A toggle for "use a dedicated config directory", with an explanation of what it means
- Connection check: configured model, responding model, time to first token, amount of added input

## Keyboard

⌘N new session, ⌘K search, ⌘1–4 move between panes, ⇧⇥ cycle modes, ⌘. stop, ⏎ allow permission once, ⌘, profiles

## Open questions

- Pane layout: fixed slots (1 / 2 / 4) or free-form splitting
- Whether prompts entered mid-turn are queued for the next turn (the Claude adapter has `promptQueueing`)
- The concrete flow for worktree cleanup (merge, PR, discard)
