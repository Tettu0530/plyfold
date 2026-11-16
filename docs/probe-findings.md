# ACP 検証結果（2026-11-16）

`plyfold-probe` で調べた結果。ACP の Rust SDK は `agent-client-protocol` 5.3.0（スキーマ 1.18.0、プロトコル v1）。

## initialize と session/new の時点の対応状況

| 項目 | claude | codex | gemini | opencode |
|---|---|---|---|---|
| アダプタ | @agentclientprotocol/claude-agent-acp 0.107.0 | @agentclientprotocol/codex-acp 2.6.0 | gemini-cli 0.68.0（`--experimental-acp`） | opencode 2.3.0（`opencode acp`） |
| session/load | ○ | ○ | ○ | ○ |
| セッション機能 | list, resume, fork, close, delete, title, status, options, systemPrompt, additionalDirectories | list, resume, fork, close, delete, title, subagents, systemPrompt, additionalDirectories | なし | list, resume, fork, close, delete, additionalDirectories |
| プロンプト | image, embeddedContext | image, embeddedContext | image, audio, embeddedContext | image, embeddedContext |
| MCP | http, sse | http | http, sse | http |
| 認証方法 | なし（`auth/status_update` 通知で状態を送る） | api-key, chat-gpt | oauth-personal, gemini-api-key, vertex-ai, gateway | opencode-login |
| モード | default, acceptEdits, plan, auto, bypassPermissions | read-only, workspace-write, agent, agent-full-access | - | - |
| 設定項目 | mode, model, effort, fast, ultracode, agent | mode, collaboration_mode, model, reasoning_effort, fast-mode | - | model, effort, mode |

## プロンプトを実際に送った結果

| 確認したこと | claude | codex | opencode |
|---|---|---|---|
| ファイル編集の差分 | ○ `tool_call` の content に `type: diff` | 未確認（下記の設定の問題で止まった） | × content に入るのはテキストだけで、diff はない |
| 権限確認 | ○ `allow_once` / `allow_always` / `reject_once`（`--mode default` で許可されていないコマンドを実行したとき） | 未確認 | 出なかった（既定ですべて許可） |
| 中断 | ○ `stopReason: cancelled`、cancel から 31 ms | 未確認 | 未確認 |
| 開き直し | ○ `session/load` で履歴の通知が 9 件再送された | 未確認 | 未確認 |
| ファイルの読み書き | エージェントが自分で書く（`fs/*` は来なかった） | - | 同じ |

## 分かったこと（設計への影響）

1. **5 つの基本機能は 4 つとも揃っている**。session/load（Gemini 以外は fork と list も）が全部にあるので、セッション中心の設計で進められる。ただし Plyfold 側でもイベントログを持つ方針は変えない（Gemini は list がない）
2. **差分は Plyfold が自分で作る必要がある**。OpenCode は diff を返さないので、worktree と git diff で作るのが確実。ACP の diff は「あれば使う」くらいの扱いにする
3. **既定プロファイルは既存の設定をそのまま使う**
   - 権限：`~/.claude` の allow 設定が効いて、権限確認が出ないことがある
   - Codex：既存の設定がカスタムプロバイダを指していて、そのキーの環境変数がないため止まった
   - エラーは RPC エラーではなく、**普通のメッセージと `end_turn`** で返ってきた。UI はこれをエラーとして見分けられない
   - → プロファイルを分ける（isolate）方式が、複数のキーにも再現性にも必要
4. **認証状態は ACP で取れる**。Claude と Codex は `auth/status_update` と `_auth/status_update` の通知で、アカウント名やプランを送ってくる。プロファイルの画面に使える
5. **API キーの渡し方は CLI ごとに違う**。Codex と Gemini は `api-key` 系の認証方法を持っている（`_meta.api-key.provider` 付き）。Claude には認証方法がなく、環境変数で渡すことになりそう（要確認）

## プロファイルを分けた検証（サードパーティのプロキシのキー）

プロファイル専用の `CLAUDE_CONFIG_DIR` / `CODEX_HOME` と、キーチェーンのキーで起動した。1 つのキーを、Claude Code（Anthropic 形式）と Codex（Responses API）の両方で使った。

| 確認したこと | claude（プロキシ経由） | codex（プロキシ経由） |
|---|---|---|
| 起動とセッション作成 | ○ | ○ |
| 権限確認 | ○（`--mode default`） | ○（`--mode read-only`）。選択肢は `allow_once` / `accept_execpolicy_amendment`（kind は allow_always） / `cancel`（kind は reject_once） |
| 拒否したとき | ツールが失敗し、ターンは続く（`end_turn`） | **ターンごと終わる**（`stopReason: cancelled`） |
| 差分 | ○ `type: diff` | × ファイルもシェル（`printf > file`）で書くので、diff は来ない |
| 3 つを同時に実行 | ○ 普段のログイン、プロキシ経由の Claude、プロキシ経由の Codex で、認証が混ざらなかった | |
| キーの値 | transcript と stderr に出ていない（伏せ字が効いている） | |

### 分かったこと

6. **プロファイルを分ける方式は動く**。設定ディレクトリと環境変数を分けるだけで、普段の設定に触れずに、複数の認証を同時に使えた
7. **差分を返すのは Claude だけ**。Codex と OpenCode は diff を返さない。Plyfold が worktree と git diff で差分を作る方針で確定してよい
8. **「拒否」の意味がエージェントごとに違う**（ターンが続くか、終わるか）。UI では「拒否して続ける」と「止める」を分けて見せる必要がある
9. **認証状態の表示は当てにならない**。キー（`ANTHROPIC_AUTH_TOKEN`）で動かしても、アダプタは `"Claude subscription" / "OAuth token"` と表示した。プロファイル名や接続先は Plyfold 側で持って表示する
10. **応答の中に Claude Code からのお知らせが混ざる**。ゲートウェイについての警告文が `agent_message_chunk` として、モデルの答えの後ろに付いてきた。モデルの出力と見分ける方法は今のところない
11. **プロキシの先のモデルは、ACP のメタデータで確かめられる**。`usage_update` の `_meta._claude/model` に、API が返した実際のモデル名が入る。表示用の設定値（`currentValue: opus`）やモデルの自己申告は、当てにならない

12. **独自の接続先は、直接 API を呼べば中身を確かめられる**。応答の `model` と `id` の形、使ったトークン数、応答ヘッダー（中継しているゲートウェイの名前）を見る。今回のプロキシについて分かったこと:
    - どちらの形式で呼んでも、応答のモデル名は同じ独自の名前で、要求したモデル名ではなかった
    - Anthropic 形式の応答なのに、`id` が OpenAI の Responses API の形（`resp_…`）だった
    - 数語のプロンプトに、数千トークン分の入力が計上された（見えない指示が足されている）
    - 応答ヘッダーから、複数の中継ゲートウェイを通っていることが分かった。その中には、サブスクのアカウントを API に変換するものも含まれていた
    - → Plyfold では、独自の接続先を使うプロファイルに「実際に応答したモデル名」を表示する。接続を確かめる機能（このような直接の確認）を設定画面に用意する案もある

## 次に確認すること

- [x] isolate したプロファイルで、キーだけで動くか → プロキシのキーで確認済み
- [x] `parallel` で、別々の認証を使うセッションを同時に動かせるか → 確認済み
- [x] Codex をプロファイルを分けて動かし、差分と権限確認を確かめる → 確認済み（中断は未確認）
- [ ] Codex の中断（cancel）
- [ ] OpenCode の中断と開き直し
- [ ] Gemini：API キーで認証してから run（`--auth gemini-api-key`）
- [ ] OpenCode の設定を分ける環境変数（`XDG_DATA_HOME` で足りるか）

## ベンチマーク（`plyfold-probe bench`、2026-11-16）

本物の経路と、サードパーティのプロキシを通した経路を、同じ条件で比べた。各経路で、乱数で作った 4 種類の問題を 2 回ずつ解かせた。

| 項目 | Claude 本物 | Claude プロキシ | GPT 本物（ChatGPT のログイン） | GPT プロキシ |
|---|---|---|---|---|
| 設定上のモデル | opus / medium | opus | gpt-6-luna / medium | gpt-6-luna / medium |
| API が返したモデル名 | claude-opus-5-5 | 独自の名前 | 取れない | 取れない |
| トークン差（同じ文章） | 4372 | 3758 | 1083 | 1025 |
| 正答 | 8/8 | 6/8（2 問は時間切れ） | 0/8 | 8/8 |
| 全体の時間（中央値） | 22.8s | 48.0s | 2.8s | 35.8s |

- **同じモデル名でも、ふるまいがまったく違った**：本物の gpt-6-luna は約 3 秒で答え、全問不正解。プロキシの gpt-6-luna は約 36 秒かけて全問正解。モデル名どおりのモデルではない
- **トークン数による指紋は決め手にならない**：使ったトークン数を返すのはプロキシ自身なので、中継のゲートウェイが自分で見積もった値かもしれない
- 本物の ChatGPT のログインでは `gpt-6.1-sol` を使えなかった（not supported）。プロキシはこの名前を受け付ける

## コーディングのベンチマーク（`plyfold-probe codebench`、2026-11-16）

Rust の小さな課題 4 つ（式の評価、O(1) の LRU、既存コードのバグ修正、INI のパーサー）で比べた。採点は、見せたテストと隠しテストで行う。

| 経路 | 正解 | 合計時間 | ツール呼び出し |
|---|---|---|---|
| Claude 本物 | 4/4 | 148s | 3〜3 回 |
| Claude プロキシ | 4/4 | 438s | 9〜14 回 |
| GPT 本物（gpt-6-luna） | 4/4 | 152s | 4〜6 回 |
| GPT プロキシ | 4/4 | 1488s（1 課題は 900 秒の制限で打ち切り。コードは完成していた） | 5〜9 回 |

- この難しさの課題では、正解の数に差は出なかった。差は**速さと手数**（プロキシは 3〜10 倍遅い）と、**終わり方**（完成後も作業を終わらせないことがある）に出た
- 本物の gpt-6-luna は、ツールなしの暗算では 0/8 だったが、コードを実行できるこの形式では全問正解した。ツールなしで頭の中だけで解かせる問題は、エージェントとしての実力を表さない
- テストや Cargo.toml を書き換えた経路はなかった
