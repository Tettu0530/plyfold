# plyfold-probe

A verification CLI that checks each CLI's ACP support. It speaks raw JSON-RPC without the SDK and records every message sent and received.

```sh
cargo build
alias probe=./target/debug/plyfold-probe   # run from the repository root (reads probe.toml)

probe list                         # configured agents and profiles
probe caps claude                  # results of initialize and session/new (uses no tokens)
probe matrix                       # caps for every agent → probe-runs/matrix.md

probe run claude --prompt "..."                      # answer permission requests in the terminal
probe run claude --mode default --permission reject --prompt "..."
probe run claude --cancel-after 4 --prompt "..."     # test cancel (Ctrl-C also sends it)
probe run claude --session <id> --prompt "..."       # reopen with session/load / resume

# Multiple keys
probe keys set claude-key-a ANTHROPIC_API_KEY        # store a key in the Keychain (interactive prompt)
probe caps claude-key-a
probe parallel claude-key-a claude-key-b --prompt "Reply with hi"
```

- Output goes to `probe-runs/<time>-<target>-<kind>/`
  - `transcript.jsonl`: every message. Key values are replaced with `***`
  - `stderr.log`
  - `summary.json` / `caps.json`
- The default working directory is `probe-runs/workspace`. fs reads and writes are allowed only inside it
- Profile config directories are `~/Library/Application Support/plyfold-probe/profiles/<name>/`
- Passing a bare agent name inherits the existing login and configuration (`~/.claude`, `~/.codex`, etc.). Permission settings apply as well, so permission requests may not appear
- If `probe.local.toml` sits next to `probe.toml`, it is merged on top (keep it out of git; put local settings such as custom endpoints there)
- Writing profiles
  - `keys = { VAR = "keychain:<name>/<VAR>" }`: share one key across multiple profiles
  - `files`: files to place in the isolated directory (e.g. Codex's `config.toml`)
  - `{profile_dir}` in an `env` value is replaced with the profile's directory
