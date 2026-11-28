# Roadmap

Where Plyfold is heading on the way to 1.0. Plans change; the [changelog](CHANGELOG.md) records what actually shipped. Ideas and feedback are welcome in the issues.

## Focus

Plyfold is for **running one task on several agents, keys and models, having another agent check the work, and taking the best result**. Work goes first to what serves that:

- Running a task more than once, side by side, and comparing the results
- Having another agent review the work before you take it
- The keys, providers and models to compare (profiles, custom providers, limits)

Plyfold stays a desktop app for your own machine. Reaching it from a phone or the web, and growing into a general control panel for agents, are not on the way to 1.0.

## What 1.0 means

- **Stable data**: the shapes of `config.toml`, `settings.json` and the database are a promise. When one has to change, Plyfold migrates your data itself
- **Tried on every system**: macOS, Windows and Linux have each been tried on real machines, not only built in CI
- **Updates itself**: a new version can be installed from inside the app
- **Reviewed for safety**: how keys are stored, what agents are allowed to do, and what is sent to custom providers have been looked over again

## 0.4 — Easier to live with

- Switching a session to a mode that acts without asking (bypass permissions) also allows the permission request it is waiting on
- The development build keeps its data apart from the installed app, so running both never mixes sessions
- Updates from inside the app
- A setup script per repository that runs in every new worktree (installing dependencies, copying `.env` files)
- Permission rules per repository ("always allow", "always ask") that answer for any agent
- Windows and Linux tried on real machines

## 0.5 — Run in parallel, compare

- Send one prompt to several agents or keys, each in its own worktree side by side, then compare their diffs, time, tokens and cost and take the best
- A port per session for dev servers, with the preview opening on it
- A queue of tasks that runs a set number at a time
- Moving on to another key of the same kind when one hits a rate limit or runs out of credit

## 0.6 — Agents working together

- A second agent reviews each turn's diff read-only and lists what it finds
- Handing a session over to another agent, with a summary and the diff, in the same worktree
- MCP servers set up once in Plyfold and passed to every agent
- Agents from the ACP Registry that ship as binaries (downloaded, checked against their checksum and unpacked for you)

## 0.7 — Compare and check, deeper

- A comparison verdict: after a Compare run, a reviewer agent reads every diff and says which one to take and why
- A record of past comparisons: which run was taken, and each one's time, tokens and cost
- Running the same task again with another key or model from a finished session, to compare after the fact
- Sending a review finding back to the session as an instruction with one click
- Review rules per repository (what the reviewer should look for, and which profile reviews by default)

## 0.8 — Browser and everyday use (shipped)

- A browser pane that is a real browser (any site, Artifacts included, sign-ins kept) on macOS and Windows
- A terminal button beside the browser button, opening in the session's folder or in `~`
- A search field for profiles on the new session screen
- Long conversations stay responsive, and panes keep the keyboard focus where you expect it

## 0.9 — Verify and keys

- Verification commands per comparison, run in each candidate's worktree after the run, with status, duration and output shown as evidence next to the usual metrics
- Usage and cost per profile over time (today, this week, this month) on the profiles screen
- Spending limits per profile (cost or tokens per day): a session stops starting turns on a profile past its limit, and moves on to its fallback if it has one
- Spreading queued tasks over several API key or provider profiles of the same agent
- The remaining rate limit or credit of a key, where the provider tells it, shown before it runs out
- Fallback chains that are easy to see and edit (A → B → C) on the profiles screen

## 0.10 — Settling

- The data formats fixed for 1.0, with migrations
- Accessibility, performance and documentation passes
- A decision on signing and notarizing the builds
- Only fixes in the last stretch before 1.0

## Later

Not needed for 1.0:

- A breakdown of what fills the context window
- Checkpoints: going back to before a turn
- Staging and committing from inside the app
- Prompting from the browser pane (sending a page or selection to a session)
- A browser pane on Linux (it still shows pages in a frame, so some sites refuse to load)
- Searching every session at once
- Starting a session from a GitHub issue
- Lighter everyday conversations that call a provider's API directly with an API key profile
- The menu bar, and answering a permission request from a notification

## Not planned

- Remote access, a web client or phone apps
