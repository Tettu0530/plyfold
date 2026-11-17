## What and why

<!-- What does this change, and why? Link the issue it addresses, e.g. "Fixes #123". -->

## How it was tested

<!-- Tests added or updated, and what you tried by hand (agent, profile kind, number of panes). -->

## Screenshots

<!-- For UI or animation changes: before and after, or a short recording. Show more than one pane if the layout changes. Delete this section otherwise. -->

## Checklist

- [ ] `cargo test --workspace` passes
- [ ] `npx tsc --noEmit -p .` and `npx vitest run` pass in `apps/desktop`
- [ ] Code, comments and the commit messages are in English, with an imperative subject line
- [ ] New or changed UI text is in the i18n dictionaries with `ja`, `en` and `zh` entries ([docs/i18n.md](https://github.com/Tettu0530/plyfold/blob/main/docs/i18n.md)), and engine messages use `plyfold_i18n::tr!`
- [ ] UI changes follow [the UI rules](https://github.com/Tettu0530/plyfold/blob/main/.claude/skills/no-ai-slop-ui/SKILL.md) and use the springs in `motion.ts` and the `liquid/` components
- [ ] No API keys, tokens or personal paths in the code, logs or screenshots
