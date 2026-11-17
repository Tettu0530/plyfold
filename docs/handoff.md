# 引き継ぎ（2026-11-16 時点）

次のセッションは、まずこれと `DESIGN.md`、`.claude/skills/no-ai-slop-ui/SKILL.md` を読むこと。

## Plyfold とは

コーディングエージェントの CLI（Claude Code はアダプター経由、Codex、OpenCode、Gemini CLI）を ACP のクライアントとして動かす、OSS の GUI ハーネス。自前のエージェントのループは持たない。

- 前提: 1 つの CLI で複数のキーを分けて使う（プロファイル）
- macOS 専用。Tauri v2 + React + TypeScript。見た目は shadcn/ui（Tailwind v4、Radix）、ニュートラルなダークのトークン
- ネイティブのガラスは使わない。ただし動きは Apple（Liquid Glass）を再現する
- リポジトリ: `~/projects/plyfold`、枝 `main`（push はしていない）

## 作業の決まり（ユーザーから）

- 報告・コマンドの説明文・コミットメッセージはすべて日本語。「・」でつながない
- 用語: 停止、カスタムプロバイダー、初期プロンプト、ベース URL、置換、テスト。キーの割り当てなどは文字ではなくアイコン（`Keys` コンポーネント）
- dev サーバー（`npm run tauri dev`、`apps/desktop`）は Claude がバックグラウンドで起動・管理する。ログは各自のジョブの tmp に出す
- 区切りのよいところでコミットしてよい
- UI のデザインは Design のキャンバス（Artifact `https://claude.ai/artifact/M2QL8eMV7QMdxRxYrYhMYx`、ソースは `.design/project/*.dc.html`、git 管理外）でコメントを受ける。公開する前に、新しい版を読んで突き合わせる
- 中継のキー（サードパーティのプロキシ）には、他人に見られて困る情報を送らない。プロバイダー名は公開の文書に書かない
- AffectUI は MIT の無料部品だけ。Pro は使わない

## 構成

- `crates/plyfold-acp`: ACP（v1）の JSON-RPC stdio トランスポート、順序の保証（応答ごとに配信済み通知の数）、秘密の伏せ字、模擬エージェント `plyfold-mock-agent`
- `crates/plyfold-profile`: エージェントとプロファイルの定義、キーチェーン（サービス名 `plyfold`）、`edit.rs`（画面からの編集、toml_edit で config.toml を書き換え）
- `crates/plyfold-store`: SQLite のセッションとイベントの記録
- `crates/plyfold-worktree`: セッションごとの worktree、差分、`ops.rs`（状態・コミット・取り込み・PR・破棄・エディタで開く）
- `crates/plyfold-core`: Engine（起動・開き直し・プロンプト・権限・設定項目・無応答の検出）、`check.rs`（接続テスト）
- `crates/plyfold-probe`、`crates/plyfold-cli`: 検証用の CLI
- `apps/desktop/src-tauri`: Tauri のコマンド。設定は `~/Library/Application Support/plyfold/`（config.toml、settings.json、plyfold.db、worktrees/）
- `apps/desktop/src`: 画面
  - `state/store.ts`（zustand）、`state/transcript.ts`、`state/infoCache.ts`（プロファイルごとの前回の model / effort / mode）
  - `components/pane/*`（ペイン、下書きのペイン、入力欄、会話、権限確認）、`Sidebar`、`SessionMenu`（右クリック）、`SearchCard`（⌘K）、`DiffView`、`ProfilesView`、`SettingsView`、`Notifications`、`SplitFlap`、`MotionLab`
  - `components/liquid/*`: 分離アニメーション（下記）
- `tools/liquid-probe`: Liquid Glass の測定と、動きのコマ送りの確認

## できていること

- ACP の能力の一覧、複数キーのプロファイルの分離、ベンチマーク（中継は 3〜10 倍遅いが、易しい課題では品質は同じ）
- ペイン（1・2・4 枚）、サイドバー（リポジトリごと、右クリックで名前の変更・停止・削除、見ていない印）
- 新しいセッション = ペインの中の空の下書き（モーダルではない）。真ん中にプロファイルの一覧（直近 30 日のターン数、入力と出力のトークン、費用。最近使ったものが上、↑↓ で選べる）。入力欄の上は、左にリポジトリと worktree、右に model・effort・mode（前回の値を出す）
  - 一覧はペインの真ん中。狭いペインでは、入力欄の上の段は折り返して model・effort・mode が 2 段目に回り、一覧の行はトークンを隠す（コンテナクエリ）
  - リポジトリの選択（`RepoPicker.tsx`）: 最近のリポジトリ（セッションから）と、フォルダの補完（コマンド `complete_dirs`、`src-tauri/src/dirs.rs`。git のリポジトリを先に、隠しフォルダは `.` を打ったときだけ）。↑↓ で選ぶ、Tab で中へ進む、⏎ で決める
  - mode は日本語の名前で出す（`icons.tsx` の `modeLabel`。デフォルト、編集を許可、プラン、自動、権限スキップ、読み取りのみ、書き込み可、フルアクセス、ビルド）
  - 使用状況は記録から数える（`crates/plyfold-core/src/usage.rs`、コマンド `usage_summary`）。費用は usage_update の通算の差を足す。消したセッションは数えない
- 入力欄の model / effort / mode とコンテキストの使用量、Shift+Tab で mode。mode はパタパタ（反転フラップ）で替わる
- 差分の画面（統合・左右、コミット、元の枝へ --no-ff で取り込み、gh で PR、破棄、エディタで開く）
- プロファイルの画面（公式 API / 既存のログイン / カスタムプロバイダー、キーは末尾 4 文字だけ見せる、接続テストで応答モデルと設定のモデルを比べる）
- 設定の画面（作業場所、無応答の時間、エディタ、取り込んだ後の片付け、保存場所、動きの見本）
- 検索（⌘K）、通知（ベルの欄と macOS の通知）
- エージェントの発言は Markdown で描く（`components/pane/Markdown.tsx`、react-markdown + remark-gfm）。コードの塊は言語の名前とコピー、表、チェックリスト。リンクは既定のブラウザで開く（コマンド `open_url`、http / https / mailto だけ）。外の画像は読み込まず、リンクにする。HTML は描かない
- 入力欄のキー（`lib/keys.ts`）: 日本語入力の確定の Enter で送らない（WebKit では確定の keydown が compositionend の後に来て isComposing が false。keyCode 229 と、compositionend から 80ms 以内も見る）。送るキーは設定で Enter か ⌘Enter（`send_key`）
- ターンの途中に送った指示はキューに積み（入力欄の上に並ぶ）、正常に終わったら先頭から送る。中断やエラーなら待たせたまま（「先頭を送る」で送れる）。途中で文が空なら送るボタンは停止、esc でも中断
- コマンドは実行中に経過時間、終わったらかかった時間。ターンの行の右端に答え終えた時刻
- エージェントが付けたタイトル（session_info_update）でセッション名を書き換える。手で変えたら替えない（記録の title_locked）
- ペインの見出しに、計画（済み/全部）、バックグラウンドのシェル（Claude の run_in_background。後から同じ ID を指した TaskOutput や KillShell で状態を追う）、触ったファイル（押すと Finder で見せる）のボタン。いつも出し、中身がなければ数を出さない（`PaneTools.tsx`、`state/paneData.ts`）
- 生成中は会話の最後に、きらめく文字（`.shimmer`、index.css）で今していることを出す（考えています、実行しています、書いています、計画しています）。経過時間と tok/s を並べる
- 自分の発言にコピー・編集して送る・もう一度送る、エージェントの発言にコピー（マウスを乗せると出る）。ACP は履歴を巻き戻せないので、編集ともう一度送るは新しいターンとして送る（添えた画像とファイルも送り直す）。ターンの途中は押せない
- 会話のツールの呼び出しは、行を押すとコマンド・説明・結果を開く（長いものは最初の行だけ、残りは押して出す）。終了コードが 0 でなければ赤で出す。ファイルの差分は行の差分（LCS、前後 3 行、`lib/lineDiff.ts`）で、見出しで畳める。描き方は差分の画面と共有（`components/PatchLines.tsx`）
  - 取り出し方（`state/transcript.ts` の `mergeTool`）: Claude は rawInput.command / description と rawOutput、Codex は rawInput.command（`/bin/zsh -lc '…'` を外す）と `_meta.terminal_output_delta`・`terminal_exit`、OpenCode は content の文字
  - 同じ id の tool_call が 2 度来たら重ねる（React のキーの重複の警告はこれが原因だった）
- 起動時のクラッシュ（同期のコマンドから tokio::spawn）、開き直しの失敗（-32002 で新しいセッションへ）は直した

## 動きの規格（重要。詳しくはスキルの 4. 動き）

- ばね: 標準 0.35 秒 / bounce 0.3（Apple のばねの換算）
- 分離アニメーション: `liquidOpen` / `liquidClose` / `liquidCloseFrom`（stage.tsx）、小さなメニューは `useLiquidMenu`、全面の画面は `cover: true` と `useLiquidClip`
- 融合は Liquid Glass と同じく、距離場（SDF）の 2 次の smin（`sdf.ts`、GPU は `liquid-gl.ts` の WebGL2 のキャンバス 1 枚）
  - すきまが k/2 以下でつながる（GlassEffectContainer の spacing の実測と一致）。k = 出発点の太さ × 1.2 + 16（40〜72px）
  - 重なっているあいだは k を弱める（smin はぴったり重なると k/4 ふくらむ）。広がりが 45〜90% のあいだに k を 0 へ
  - 位置のばねは出だしを柔らかく（PeelSpring）、首があるあいだは粘りで少し引き留め、切れたらばねで放す
  - 動いているあいだの体は液体の実体だけ（本物の面の地・枠線・影は消し、中身を実体の形で切り抜く）
  - Radix の既定のフェードはインラインの `animation: none` で止める（クラスでは打ち消せない）
- 手で首や尾を描く方式は「なんか違う」と言われて捨てた
- 確かめ方: `tools/liquid-probe/sdf-film.mjs`（式だけを CPU で）、`tools/liquid-probe/app-frames.sh`（dev サーバーの画面をヘッドレスの Chrome で開き、仮想時間を 1/60 秒ずつ進めて撮る）。アプリの時計は performance.now に揃えてある。たまに止まるので `perl -e 'alarm 80; exec @ARGV'` で時間を区切る

## 確かめていないこと

- 通知の欄の分離の動きを画面で見ていない（右クリックメニューはヘッドレスの Chrome でコマ送りを確かめた。下記）
- model / effort / コンテキストのメニューの「本物の面と実体の隙間」「元のフェードの一瞬の表示」の修正は、ブラウザではセッションが無く再現できず、画面で見ていない
- 確認は Chrome（ヘッドレス）。Tauri は WebKit なので、見た目の最終確認はアプリで
- model / effort のメニューの「枠と実体のずれ」（開き終わりで、跳ね返りの分だけ実体が枠より大きい。上辺が目立つ）: メニューは開いた後も実体を枠として描き続けるようにした（`hold`）。入れ替えがないので、ずれない。`PROBE` 環境変数で、コマごとに `globalThis.__plyfoldLiveEdges`（開発中だけ）の実体の形を数値で出せる

## メニューの重なり順（`rise`）

- メニュー（`useLiquidMenu`）は、実体が出だしだけ出発点の裏から出て、開き具合 0.2〜0.5 で出発点の上に乗る（右クリックで行の下に潜ったままだった問題を直した）
- 上に乗る量 `over` を GPU のシェーダーに渡し、出発点の中に実体だけの形（影・塗り・枠線）を重ねる。重ね始めたら出発点を z-[57] から下げる
- 全面の画面（cover）も、出発点を下げたあとは over = 1（出発点の中を塗らないままだと、実体に穴が開く）
- ブラウザでセッションのある画面を撮るには、Vite が配っている store のモジュール（URL に `?t=` が付くことがある）を `performance.getEntriesByType("resource")` で探して import し、`useStore.setState({ sessions })` で偽のセッションを入れる（`PRE` に書く）
- `app-frames.sh` は時間切れ（perl の alarm）でも Chrome と node を片付ける。それでも残ったら PID を見て kill する（`pkill -f remote-debugging-port=9334` は、その文字列を含む自分のシェルも消す）
- 仮想時間を進めた後の撮影は、ときどき返事が来ずに止まる（簡単なページでも起きる）。落ち着いた画面を 1 枚見るだけなら `LAST=1`（仮想時間を使わず、実時間で `SETTLE` ms 待って撮る）。並べる列の数は `COLS`
- 会話のある画面: `fromHistory` に probe-runs の transcript.jsonl を EventRecord の形にして渡し、`useStore.setState({ sessions, panes, paneCount })`

## 次の候補（ユーザーに提案済み、未着手）

1. （済み）会話の表示を詳しく
2. （済み）起動したときにペインの並べ方と選んでいたセッションを戻す。localStorage の `plyfold.layout`（下書きと消えたセッションは空のペインにする）。アプリでは確かめていない
3. （済み）入力欄での画像や添付。入力欄は 1 行から中身に合わせて伸びる（最大 200px）。左の + のメニュー（ファイルを添える、画像を添える。dialog のプラグインで macOS のファイルの選択を開き、パスで渡す）。画像は貼り付け（⌘V）、ファイルはペインに落とす（Tauri の onDragDropEvent、`lib/drop.ts`。落とした位置のペインの入力欄に添える）。送る前に並べて × で外せる。文字なしでも送れる
   - エンジン（`crates/plyfold-core/src/attach.rs`）: 画像は image の塊。エージェントが画像に対応していなければ `<state_dir>/attachments/` に書き出して resource_link。ファイルは resource_link（file:// の URI、% で書く）。画像のファイルで 8MB 以下なら image の塊
   - 記録（イベントのログ）に画像の base64 がそのまま入る。大きくなるなら伏せるか別に置くことを考える
   - アプリでの落とす操作と、実際のエージェントへの送信は確かめていない（ブラウザでは貼り付けの見た目だけ見た）。
4. アプリとしての配布（.app、署名、アイコン）

## その他

- このセッションで `~/.claude/hooks/japanese-guard.py`（応答が英語なら日本語で書き直させる Stop hook）を入れた
- 古いコミットメッセージは英語のまま（書き換えていない）
