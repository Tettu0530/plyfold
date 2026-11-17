# Security Policy

## Supported versions

Plyfold has no releases yet. Security fixes go to the `main` branch only. If you build from source, update to the latest `main` to get them.

| Version | Supported |
|---|---|
| `main` | Yes |
| Anything older | No |

## Reporting a vulnerability

Please do not report security issues in public issues, pull requests or discussions.

Report them privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting). This opens a private security advisory that only you and the maintainers can see.

Include as much of the following as you can:

- What the issue is and what an attacker could do with it
- Steps to reproduce, or a proof of concept
- The commit you built, your macOS version, and the agent and adapter version involved
- Whether it depends on a particular kind of profile (existing login, official API, custom provider)

Do not include real API keys or tokens. Use placeholder values.

We will acknowledge the report, keep you informed while we look into it, and credit you in the advisory when the fix is published, unless you prefer not to be named. Plyfold is a small project, so please allow some time for a response.

## Scope

Plyfold launches coding-agent CLIs on your machine and passes them your credentials. These are the areas where a report is most useful.

### API keys

- Keys are stored in the macOS Keychain under the service `plyfold`, never in `config.toml`, `settings.json` or the database.
- Keys reach an agent only as environment variables when it is launched, never as command-line arguments.
- A profile that sets its own keys or config directory removes the agent's key variables (for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) from the inherited environment, so keys from your shell are not passed to it.
- The UI shows only the last four characters of a key.

A key that ends up in a file, a log, the UI, a command line or another profile's environment is in scope.

### Event log

Every ACP message is written to the event log in `~/Library/Application Support/plyfold/plyfold.db`. Before it is written, the key values Plyfold passed to the agent are replaced with `***`. Values shorter than eight characters are not masked.

The redaction covers only the keys Plyfold itself manages. Secrets the agent reads from your files or your environment, or that you type into a prompt, are stored as they appear in the ACP traffic. A key managed by Plyfold that is stored unmasked is in scope; secrets from other sources are not.

### Agents and worktrees

Agents run as you, with your user account's permissions. Each session runs in its own git worktree, but that is a way to keep changes apart, not a sandbox: an agent can read and write anything your account can, and run commands. Plyfold forwards the agent's permission requests to you, but what an agent does without asking is up to the agent CLI and its settings.

In scope:

- Plyfold running an agent, a command or git with input it should not trust, in a way that lets someone else run code on your machine
- Plyfold approving a permission request you did not approve
- Merge, push, discard or worktree cleanup touching files outside the session's worktree or the target repository in ways they should not

Out of scope:

- Vulnerabilities in the agent CLIs or ACP adapters themselves (Claude Code, Codex, OpenCode, Gemini CLI). Report those to their maintainers.
- What an agent does with permissions you granted it
- Issues that require an attacker who already has access to your user account or your Keychain
