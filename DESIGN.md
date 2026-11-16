# Plyfold 設計メモ

## 決まったこと

- **macOS 専用**で始める
- **UI は完全に独自に作る**（Tauri + 独自 UI）。ネイティブの Liquid Glass は使わない。WebView の中で全面的に使うことはできず、中途半端になるため
- **エージェントのループは自作しない**。ACP クライアントとして作り、既存の CLI（Claude Code、Codex、OpenCode、Gemini CLI）を裏で動かす
- **1 つの CLI に複数の API キーを登録できることが前提条件**
  - 「プロファイル = CLI × 認証情報 × 設定ディレクトリ」として扱う
  - キーはキーチェーンに保存し、起動するときに環境変数で渡す。親プロセスのキー系の環境変数は引き継がない
  - 独自の接続先（プロキシ、ゲートウェイ）も、特定の事業者を組み込まず「接続先 URL ＋ キー」の汎用の機能として扱う
- **セッション（記録）とペイン（表示）を分ける**
  - セッション：Plyfold が持つ記録の単位（ACP の送受信のログ、worktree、プロファイル）
  - ペイン：動いているセッションを見るだけ。閉じても記録は残る
- **セッションごとに git worktree を切る**。差分は ACP の diff に頼らず git から作る

## 構成

```
crates/
  plyfold-acp       ACP クライアント。自前の JSON-RPC 輸送 + 公式スキーマ（agent-client-protocol-schema 1.18, v1）
                    plyfold-mock-agent（テストと UI 開発用の模擬エージェント。トークンを使わない）
  plyfold-profile   プロファイルの解決、キーチェーン、組み込みのエージェント定義
  plyfold-store     セッションとイベントログ（SQLite）
  plyfold-worktree  セッションごとの worktree と、未追跡ファイルを含む差分
  plyfold-core      エンジン。上の 4 つを束ね、状態の変化を EngineEvent で配信する（UI はこれだけを触る）
  plyfold-cli       開発用 CLI（plyfold start / resume / sessions / log / diff / rm / keys）
  plyfold-probe     ACP の検証とベンチマーク用（docs/probe-findings.md）
```

状態は `~/Library/Application Support/plyfold/` に置く（`config.toml`、`plyfold.db`、`worktrees/`、`profiles/`）。

## 検証から決まったこと（docs/probe-findings.md）

| 分かったこと | 設計での扱い |
|---|---|
| diff を返すのは Claude だけ | 差分は worktree と git から作る |
| 「拒否」の意味がエージェントごとに違う（ターンが続く / 終わる） | UI で「拒否して続ける」と「止める」を分けて見せる |
| 認証状態の表示が当てにならない（キーでも「subscription」と出る） | プロファイル名と接続先は Plyfold 側で持って表示する |
| 作業を終わらせずに止まるエージェントがいる | ターン中に一定時間なにも届かなければ `Stalled` にして知らせる |
| 応答（ターンの終わり）が通知を追い越しうる | 輸送に「区切り」を入れ、ターンのすべての通知を配信してからターンの終わりを知らせる |
| エラーが普通の発言として返ることがある | 未解決。発言の中のエラーを見分ける方法を考える |
| 未知の session/update が来うる | 生の JSON を必ず残し、型に変換できたときだけ型として扱う |
| ゲートウェイからのお知らせが発言に混ざる | 未解決。モデルの出力と見分ける方法はまだない |

## エンジンの約束ごと

- `start_session` → worktree の作成 → プロファイルの解決 → エージェントの起動 → session/new →（default_mode があれば）set_mode
- `reopen_session` は、エージェントが session/load に対応していれば文脈ごと戻す。対応していなければ新しいセッションを作り、文脈が失われたことを Notice で知らせる
- アプリを起動し直すと、前回動いていたセッションは `Closed` になる（記録と worktree は残る）
- 中断するときは、返事待ちの権限確認を「キャンセル」で返してから session/cancel を送る（ACP の決まり）
- ACP の送受信はすべて、キーを伏せ字にしてからイベントログに残す

## まだ決めていないこと

- Claude Code、OpenCode、Codex から取り入れる操作感（ユーザーに確認中）
- （決定）差分は、ペインの差分の数から開く全面の画面で見る。ファイルの一覧と、統合 / 左右の表示
- （決定）worktree の後片付けは差分の画面から: コミット → 元のリポジトリで今チェックアウトしている枝へ --no-ff で取り込む（ぶつかったら取り消して元に戻す）／ origin に push して gh で PR ／ 基準のコミットまで破棄。どれもターンの途中はできない
- worktree 自体を消すのはセッションを消すとき（取り込んだ後に自動で消すかは未定）
