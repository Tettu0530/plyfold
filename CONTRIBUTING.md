# Contributing to Plyfold

Thanks for taking the time to help. This guide covers setting up the project, the checks a change has to pass, and the conventions the code follows.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Before you start

- For bugs, open an issue with the bug report template first, unless the fix is small and obvious.
- For new features or larger changes, open a feature request and discuss it before writing code. Plyfold has a few fixed directions (see [DESIGN.md](DESIGN.md)): macOS first (Windows is supported too), an ACP client rather than its own agent loop, multiple keys per CLI as a core feature, and a custom UI rather than native Liquid Glass. Changes that go against these are unlikely to be merged.

## Development setup

You need macOS, the Xcode Command Line Tools, Rust (latest stable, via [rustup](https://rustup.rs)), Node.js 22.12 or later, and git.

```sh
git clone https://github.com/Tettu0530/plyfold.git
cd plyfold/apps/desktop
npm install
npm run tauri dev
```

`npm run tauri dev` starts Vite on port 1420 and launches the app. Changes to the frontend reload in place; changes to Rust rebuild and restart the app.

### Working without spending tokens

`plyfold-mock-agent` is a fake ACP agent for tests and UI work. Build it once and the app picks it up from the workspace `target/` directory as the `mock` agent:

```sh
cargo build -p plyfold-acp --bin plyfold-mock-agent
```

You can also point `PLYFOLD_MOCK_AGENT` at the binary.

### Your own data

The app reads and writes `~/Library/Application Support/plyfold/` and the Keychain service `plyfold`, the same as a regular install. The development CLI takes `--state-dir` if you want to keep test sessions apart:

```sh
cargo run -p plyfold-cli -- --state-dir /tmp/plyfold-dev sessions
```

## Repository layout

```
apps/desktop/
  src/                 React + TypeScript UI
    components/        Views, panes, motion.ts, liquid/ (separation animations)
    i18n/              UI dictionaries: ja/, en/, zh/
    state/             Zustand store and transcript building
    lib/               Tauri API bindings and helpers
  src-tauri/           Tauri commands, app settings
crates/
  plyfold-acp          ACP client and plyfold-mock-agent
  plyfold-profile      Profiles, Keychain, built-in agent definitions
  plyfold-store        Sessions and event log (SQLite)
  plyfold-worktree     Worktrees, diffs, commit / merge / PR / discard
  plyfold-core         Engine; the only crate the UI talks to
  plyfold-i18n         tr! macro for engine messages
  plyfold-cli          Development CLI
  plyfold-probe        ACP checks and benchmarks
docs/                  Design notes, i18n rules, probe findings
```

The UI talks only to `plyfold-core` (through the Tauri commands in `apps/desktop/src-tauri`). Keep agent, git and storage logic in the crates, not in the frontend.

## Checks

Run these before opening a pull request. CI runs the same checks (Rust on macOS, the frontend on Linux) and fails on any warning.

From the repository root:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

From `apps/desktop`:

```sh
npm run format
npm run lint
npx tsc --noEmit -p .
npm test
```

CI also checks the dependencies: `cargo deny check` (known vulnerabilities, licenses and sources, configured in `deny.toml`) and `npm audit` for what ships with the app. A new Rust dependency with a license that isn't in `deny.toml` needs a look before it is added there.

Add tests with your change where it makes sense. Rust unit tests live next to the code; engine tests that use the mock agent are in `crates/plyfold-core/tests/`. Frontend tests are `*.test.ts` files next to the code they test.

Tests must not need network access, real API keys or the real Keychain. Use `MemoryStore` instead of `KeychainStore`, the mock agent instead of a real CLI, and temporary directories for state and repositories.

## Conventions

### Language

- Code, comments, commit messages and documentation are in English.
- Text the user sees goes through the i18n dictionaries, never as a literal in a component.

### UI text

Read [docs/i18n.md](docs/i18n.md) before changing any visible text.

- Dictionaries are in `apps/desktop/src/i18n/<lang>/<namespace>.ts`. Every key needs a Japanese (`ja`), English (`en`) and Simplified Chinese (`zh`) entry. The `ja` file defines the keys, and `en` and `zh` are type-checked against it, so a missing or extra key fails `tsc`.
- Inside components use `const t = useT()`; outside components use `t()` from `@/i18n`.
- Don't build sentences out of fragments. One sentence is one key, with `{placeholders}` and ICU plurals.
- English UI text uses sentence case and short imperative buttons ("New session", "Create PR"). docs/i18n.md has the glossary and the style rules for each language.
- If you can't write one of the translations, say so in the pull request and someone can help.

### Engine messages

Errors and notices from the Rust crates that reach the UI use `plyfold_i18n::tr!` with all three languages in Japanese, English, Chinese order:

```rust
plyfold_i18n::tr!("セッション {id} がありません", "Session {id} not found", "会话 {id} 不存在")
```

It also works inside `#[error(...)]` for `thiserror`. Developer-only output (logs, panics, the development CLI) can be plain English.

### UI design and motion

- Follow [.claude/skills/no-ai-slop-ui/SKILL.md](.claude/skills/no-ai-slop-ui/SKILL.md): shadcn/ui tokens only, color only for status and diffs, lucide icons, no emoji, no gradients or glow, numbers in tabular figures. It ends with a checklist; go through it before submitting UI changes.
- Status is never shown by color alone. Pair it with its icon and a word.
- Animations use the springs in [apps/desktop/src/components/motion.ts](apps/desktop/src/components/motion.ts) and the separation components in [apps/desktop/src/components/liquid/](apps/desktop/src/components/liquid/). Don't add ad hoc spring values or easing curves. Everything has to respect Reduce motion.
- The Motion lab (Settings, Motion) is the place to try animation changes.

### Rust

- Format with `cargo fmt` (settings in `rustfmt.toml`: 160 columns). Formatting-only commits are listed in `.git-blame-ignore-revs`.
- Secrets must never reach logs, the event log or error messages. Anything that writes ACP traffic goes through the redactor, and anything that shows a key shows only its tail.
- Keys are passed to agents only as environment variables at launch, never as command-line arguments.

### TypeScript and React

- Keep state in the Zustand store (`src/state/`). Keep Tauri calls in `src/lib/api.ts`.
- Use the `@/` import alias for `src/`.
- Format with Prettier (`npm run format`, 160 columns) and keep ESLint clean (`npm run lint`).

## Commit messages

- English, with a short subject line in the imperative mood: "Add split view to Changes", not "Added split view" or "Adds split view".
- Keep the subject under about 72 characters, with no trailing period.
- Add a body when the reason for the change isn't obvious from the diff.
- One logical change per commit where practical.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests where they make sense.
3. Run the checks above.
4. Open a pull request against `main` and fill in the template. Link the issue it addresses.
5. For UI changes, include a screenshot or a short screen recording. If the change affects layout, show it with more than one pane open.
6. Keep pull requests focused. Unrelated refactors and formatting changes make review harder; send them separately.

A maintainer will review the pull request. Expect questions and requested changes; that is normal. Once CI passes and the review is approved, a maintainer merges it.

## Reporting bugs

Open an issue with the bug report template and include:

- What you did, what you expected, and what happened
- Your macOS version and the Plyfold commit you built
- Which agent and adapter version, and which kind of profile (existing login, official API or custom provider)
- Relevant output from the terminal running `npm run tauri dev`

Never paste API keys, tokens or the contents of the Keychain. Check logs and screenshots for secrets before you post them.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
