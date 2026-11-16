# plyfold-probe

各 CLI の ACP 対応状況を調べる検証用 CLI。SDK を使わず、生の JSON-RPC を話して、送受信したメッセージをすべて記録する。

```sh
cargo build
alias probe=./target/debug/plyfold-probe   # リポジトリのルートで実行（probe.toml を読む）

probe list                         # 設定済みのエージェントとプロファイル
probe caps claude                  # initialize と session/new の結果（トークンは使わない）
probe matrix                       # 全エージェントの caps → probe-runs/matrix.md

probe run claude --prompt "..."                      # 権限確認はターミナルで選ぶ
probe run claude --mode default --permission reject --prompt "..."
probe run claude --cancel-after 4 --prompt "..."     # 中断の確認（Ctrl-C でも送る）
probe run claude --session <id> --prompt "..."       # session/load / resume で開き直す

# 複数のキー
probe keys set claude-key-a ANTHROPIC_API_KEY        # 対話入力でキーチェーンに登録
probe caps claude-key-a
probe parallel claude-key-a claude-key-b --prompt "hi と答えて"
```

- 記録先：`probe-runs/<時刻>-<対象>-<種類>/`
  - `transcript.jsonl`：全メッセージ。キーの値は `***` に置き換える
  - `stderr.log`
  - `summary.json` / `caps.json`
- 既定の作業ディレクトリは `probe-runs/workspace`。fs の読み書きはこの中だけ許可する
- プロファイルの設定ディレクトリは `~/Library/Application Support/plyfold-probe/profiles/<name>/`
- エージェント名をそのまま指定すると、既存のログインと設定（`~/.claude`、`~/.codex` など）を引き継ぐ。権限設定もそのまま効くので、確認が出ないことがある
- `probe.local.toml` が `probe.toml` と同じ場所にあれば、上書きで足す（git に入れない。プロキシ事業者の設定などはここに書く）
- プロファイルの書き方
  - `keys = { VAR = "keychain:<名前>/<変数名>" }`：1 つのキーを複数のプロファイルで使う
  - `files`：isolate したディレクトリに置くファイル（Codex の `config.toml` など）
  - `env` の値に書いた `{profile_dir}` は、プロファイルのディレクトリに置き換わる
