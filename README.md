# pi-cc-subagent

Pi 用のサブエージェント拡張。**Claude Code 2.1.322 の Agent / SendMessage / TaskStop の仕様を、Pi の拡張 API に合わせて実装**しています。公式バイナリ由来の参照テキストを使いますが、Claude Code 本体の移植・同梱ではありません。実行に Claude Code の契約や環境は不要です。

Pi 1.5.1 の API を対象にしています。参照元・確認範囲は [docs/claude-code-reference.md](docs/claude-code-reference.md) を参照してください。

## 導入

```bash
# 一度だけ試す
pi -e ./src/index.ts

# パッケージとして利用する
pi install git:github.com/uta-a/pi-cc-subagent
# 下部一覧の縦表示・右寄せ統計を使う場合
pi install git:github.com/uta-a/pi-cc-statusline
```

起動中の Pi には `/reload` で反映します。更新は `pi update git:github.com/uta-a/pi-cc-subagent`。

以前の `cc_subagent` は廃止しました。`tasks` 配列・呼び出し単位の `profile`・任意のモデル ID を受け取る旧スキーマとの互換性はありません。新しいセッションで使ってください。ほかの拡張が同じツール名を登録している場合は、併用を避けてください。

## 使い方

```text
/cc-agent Explore 認証処理の入口を探して
/cc-agent Plan 認証処理のリファクタリング案を作って
/cc-agent general-purpose 指定した不具合を修正してテストして
```

このコマンドは親モデルに `Agent` の呼び出しを依頼します。直接ツールを使う例：

```json
{
  "description": "認証処理の調査",
  "prompt": "認証の入口を探し、関連する絶対パスと要点を報告してください。変更は不要です。",
  "subagent_type": "Explore",
  "name": "researcher"
}
```

### Agent

1回の呼び出しで1エージェントを起動します。並列にする場合は、**同じ親アシスタントメッセージで Agent を複数回呼びます**。Pi の既定の並列ツール実行を利用し、別々のツール行として表示します。

| 引数 | 動作 |
|---|---|
| `description`, `prompt` | 必須。短い説明と、自己完結した依頼 |
| `subagent_type` | 読み込んだ定義名。省略時は `general-purpose`。未知の名前は利用可能な種類を示してエラー |
| `model` | `sonnet` / `opus` / `haiku` / `fable` のみ |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max`。明示的に指定された effort がある場合だけ渡す |
| `run_in_background` | **既定は true**。`false` なら結果が出るまで待つ。ただし定義の `background: true` が優先 |
| `name` | 表示名兼 SendMessage / TaskStop の宛先。同名は最後に起動した子が優先 |

同時実行は**前景・背景・再開を合計20件**が既定です。writer 専用の上限はありません。枠が足りなければ即座に拒否し、待機キューや前景への自動切り替えは行いません。

背景起動は内部メタデータだけを返します。親は結果を推測せず、別の作業を続けるかユーザーに起動を伝えて待ちます。完了・失敗・停止ごとに、その実行につき1件の通知が届きます。再開後は新たに1件届きます。

前景完了は最終テキストと `agentId` / `<usage>` のトレーラーを返します。`Explore` / `Plan` はテキストのみ。空の完了応答には CC のプレースホルダーを返し、失敗はエラーと部分応答を返します。親への各結果・通知は最大100,000文字です。

### SendMessage と TaskStop

```json
{"to":"researcher","message":"セッション更新処理も確認してください。","summary":"追加の調査依頼"}
```

- 実行中なら、現在のツール実行ラウンドの後、次のモデル要求の前に user メッセージとして渡します。生成中の応答を割り込ませる機能ではありません。
- 完了・失敗・停止済みなら、同じ ID・同じ子の会話履歴から背景で再開します。同時実行枠は再開にも必要です。
- 停止を要求した直後で、まだ終了処理中の子への送信は拒否します。停止の通知が届いてから送り直してください。
- 名前のほか、起動結果に含まれる `a` + 16桁の小文字16進 ID でも宛先を指定できます。表示用の重複名サフィックスではなく、本来の名前か ID を使ってください。
- `to: "*"` のブロードキャスト、別セッションへの送信は不可。
- **子には SendMessage 自体を公開しません**。CC の `to: "main"` による子から親へのメッセージ送信は未対応です。

停止は `TaskStop({"task_id":"researcher"})`。`shell_id` は非推奨の別名です。`/cc-agents-stop` は背景の子をすべて停止、`/cc-agents-stop researcher` は該当の子だけ停止します。コマンドでは一覧の重複名サフィックスも使えます。停止は abort 要求であり、モデル／ツールの終了処理が戻るまで枠・ファイルロックを保持します。終了時に `killed` 通知が1件届きます。

前景の子は親のキャンセルを引き継ぎます。背景の子は親のターン終了・Esc では止まりません。セッション終了・切り替え・再読み込みではすべて中断し、遅れて返った結果の通知は抑止します。**会話履歴はメモリ内のみ**で、セッション終了時に破棄します。Pi の履歴に残る表示用スナップショットから、子を再開することはできません。

## エージェント定義

| 組み込み | 用途・ツール |
|---|---|
| `general-purpose` | 複雑な調査・複数工程の実装。親のツールを利用 |
| `Explore` | ファイル・シンボルを素早く探す用途。`edit` / `write` なし、**bash は利用可能** |
| `Plan` | コードを探索し実装計画を返す用途。Explore と同じ制限 |

全種類で `Agent` / `SendMessage` / `TaskStop` と、名前に `ask_user` を含む対話ツールを除外します。子からの再委任はできません。ツールは `ctx.tools` から選び、実行は `ctx.executeTool()` を通すため、Pi の引数検証・親の権限フック・ファイル変更キューが適用されます。

Explore / Plan の read-only は**プロンプトと親の権限設定に依存**します。bash や他拡張ツールの副作用を検査するサンドボックスではありません。

### カスタム定義

`~/.claude/agents/*.md` と `<cwd>/.claude/agents/*.md` を読みます。優先順位は **プロジェクト > ユーザー > 組み込み**。session_start と Agent 呼び出し前に変更を確認し、不正ファイルはスキップしてロードごとにまとめて警告します。

```markdown
---
name: reviewer
description: 変更内容とテストを調査する
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
model: sonnet
effort: high
maxTurns: 10
background: true
omitClaudeMd: true
---
変更の問題点と根拠を簡潔に報告してください。ファイルは変更しないでください。
```

`name` と `description` は必須。本文が子のシステムプロンプトです。`description` のリテラル `\n` は改行に変換します。ツールはカンマ区切り文字列、インライン配列、YAML リストに対応。引用文字列・真偽値・整数を扱う小さなパーサーで、完全な YAML（複数行スカラー・アンカー等）は非対応です。

CC のコア名は `Read→read`, `Grep→grep`, `Glob→find`, `Bash→bash`, `Edit/MultiEdit→edit`, `Write→write`, `LS→ls` に対応付けます。`NotebookEdit` は除外。他の名前は Pi のツール名と大文字小文字を無視して照合し、未知の名前は無視します。WebFetch / WebSearch を任意の fetch / search ツールに自動変換することはありません。

`effort` の整数は警告して無視します。`maxTurns` は正の整数で、ツールを要求したまま上限に達すると、そのツール群を実行せず、継続案内付きの部分結果を completed として返します。SendMessage で続けられ、再開ごとにターン枠を数え直します。CC の permissionMode / hooks / skills / memory / isolation 等の定義フィールドは実装していません。

## 子のプロンプト・モデル

子には定義のプロンプト、CC の authority note と Notes、cwd・git 有無・platform・shell・OS・モデル名を渡します。**通常は親のシステムプロンプト全体を含めません**。親の会話履歴もコピーしません。

`before_agent_start.systemPromptOptions.contextFiles` で Pi が取得したコンテキストを最初の user メッセージに `# claudeMd` として渡します。プロジェクト／ユーザー用のラベルと絶対パス付きで、パスと本文の合計32 KiBまで、先頭からファイル単位で採用し、省略を明記します。Explore / Plan および `omitClaudeMd: true` には渡しません。`# currentDate` は常に含めます。CC の CLAUDE.md 探索処理を追加するのではなく、**Pi が読み込んだコンテキスト**を使う適応です。

提供元が短い子プロンプトを拒否する場合があります。初回要求が出力ゼロのエラーになった場合だけ、親のシステムプロンプトを前置して1回再試行します。`pi-claude-bridge` の `prompt-capture` 拒否を想定した互換処理です。この場合は親プロンプトを省く効果はなくなります。後続ターンのエラーや部分出力がある失敗では再試行しません。

モデル選択は `Agent.model` > 定義の `model` > `ccSubagent.defaultModel` > 親。定義・設定では `inherit`、エイリアス、完全な `provider/id` または正確なモデル ID を指定できます。エイリアスは利用可能一覧の ID に系列名が含まれるものから、親 provider、`anthropic`、その他の順、同 provider 内は数値を考慮した ID 降順で選びます。解決不能・曖昧な正確 ID はエラーにし、黙って代替しません。

effort は引数 > 定義の文字列 > `pi.getThinkingLevel()`。Pi の同名レベルへ渡し、非推論モデルは off。provider 固有の変換は Pi に任せます。再開では元のモデル・effort を維持します。

## 設定

Pi の有効な `settings.json` の `ccSubagent` を各呼び出しで読みます。不正な型・値は既定値へ戻します。

```json
{
  "ccSubagent": {
    "maxConcurrent": 20,
    "budgets": "off",
    "autoModel": false,
    "resultFiles": false,
    "fileLocks": true
  }
}
```

`defaultModel` は省略時に親を継承。`"defaultModel": "sonnet"` のように固定できます。

- **budgets**：既定は off。追加のターン／ツール／出力予算・read 行数制限・重複省略・子ツール結果の追加切り詰めは行わず、要求の `maxTokens` も指定しません。Pi の各ツールと provider 本来の上限は残ります。
- `"auto"` / `"quick"` / `"balanced"` / `"deep"` は以前の予算制御を再有効化します。auto は種類・キーワードで profile を選択。read は既定200行・最大500行、同じ read / grep / find / ls を省略し、その子が bash / write / edit を行うと記録をクリアします。予算到達時はツール禁止・最大1,024トークンの報告を1回要求し、failed として部分結果を返します。中断時は報告要求を追加しません。
- **autoModel**：true の場合、引数・定義にモデル指定がなければ以前の choosePolicy によるモデル振り分けを使います。scoped models を尊重し、追加の分類 API は呼びません。最安保証ではありません。
- **resultFiles**：true の場合だけ、8 KiB超の最終出力を `os.tmpdir()/pi-cc-subagent/` に保存し、約2 KiBの先頭とパスを返します。ディレクトリ0700・ファイル0600。保存失敗は上限付きインライン出力へ戻し、セッション終了時に作成ファイルを削除します。強制終了時の削除は保証しません。
- **fileLocks**：既定 ON の **Pi 独自の安全策**。書き込み可能な背景の子の write / edit パスを終了までロックし、別の背景の子と親の write / edit を競合時に拒否します。背景 writer がいる間、親の実行中／成功した編集も予約・保持し、最後の writer 終了で解除します。失敗した親の一時予約は解除します。親のツールが内部で呼ぶ入れ子の write / edit も親の編集として扱います。

| 予算 profile | モデルターン | ツール回数 | 1応答 / 累計出力トークン | ツール結果 |
|---|---:|---:|---:|---:|
| quick | 6 | 12 | 2,048 / 4,096 | 4 KiB |
| balanced | 12 | 24 | 4,096 / 12,000 | 8 KiB |
| deep | 20 | 48 | 8,192 / 24,000 | 12 KiB |

ファイルロックは先頭の `@` を除いた絶対パスの字句比較です。**bash・外部プロセス・ユーザー編集・別名リンク・前景の子は保護しません**。完全な排他制御やサンドボックスではありません。並行作業では編集対象を分けてください。

## 表示・操作

既存の `renderRuns`、下部一覧、読み取り専用ライブプレビューを継続利用します。

- 履歴内は `● Explore(説明)`、直近3件の活動、完了後は `Done (… tool uses · … tokens · …)`。`Ctrl+O` で Prompt / Response を展開。
- 背景起動は固定の起動済み表示。完了通知はモデル向けには system-reminder 内の XML ですが、TUI では XML ではなく通常のエージェント行として描画します。
- 下部一覧は main と実行中の子を最大8件＋残件数表示。ラベルは name、未指定なら定義名。表示名は制御文字を空白に置換し24文字まで、重複名は番号で区別します。宛先名自体は変更しません。
- 入力が空のときの **↑↓**（Shift併用も可）でチャット → main → 子を選択。Enter で子の詳細、main では元の会話に戻ります。端では折り返しません。入力中や権限ダイアログの操作は奪いません。
- 詳細内は ↑↓ で対象切り替え、PgUp / PgDn でスクロール、Enter / Esc で閉じます。閉じても子は停止しません。
- `/cc-agents` で詳細、`/cc-agents-stop` で停止。`/cc-subagent-demo` と `/cc-subagent-status-demo` は API 呼び出しなしの架空データ表示です。後者は10秒で消え、`off` で即時消去できます。

`ctx.ui.setStatus()` を使い、既存フッターを置き換えません。縦配置・幅に応じた右寄せは `pi-cc-statusline` 側の対応が必要です。Pi 標準フッターでは改行が横表示になり、拡張ステータスを描かない独自フッターでは一覧が見えません。

行のトークン数と通知の `subagent_tokens` は最後の要求の input + output + cache 合計。詳細には累積使用量も保持します。前景使用量は親へ返し、背景使用量は親合計に加算せず通知の details に残します。表示履歴は80件・各1 KiB、UI 最終応答は約48 KiBまでですが、再開用の子トランスクリプトはこれとは別に保持します。

## CC との残る差異・検証範囲

- Pi の別々のツール行は統合できないため、並列 Agent は1呼び出し1行。既存の並列ツリーはデモでのみ使用します。
- 通知は Pi の custom message を followUp / triggerTurn で配送します。CC の内部 user-role 通知処理・スケジューラーそのものではありません。
- チーム・worktree / remote 分離・子から親への SendMessage・永続トランスクリプト・ネイティブな会話表示切り替えは非対応。権限は Pi に依存し、read-only の強制サンドボックスはありません。
- fileLocks、任意の Pi provider へのモデル解決、互換再試行、任意設定の予算／結果ファイルは Pi 用の適応です。
- 子ツールは背景起動の親ツールが返った後も `ctx.executeTool()` を使います。Pi 1.5.1 の nested-call 管理に依存し、終了済みの親ツール結果に履歴・使用量を追記できません。返却後の nested-call レコードの保持など、Pi 内部の将来変更では再確認が必要です。
- 初回プロンプト・コンテキストを含む履歴から再開します。ツールの実行可否は親の現在の公開状態・権限にも依存します。子履歴の自動コンパクションはありません。長い実行は provider のコンテキスト上限に達する場合があります。

自動テストはモックによるツール契約・実行枠・通知・キュー／再開・定義・モデル／effort・設定と既存 UI 操作を対象にしています。

実モデル（RPC モード、親は `claude-bridge/claude-haiku-5-5`）では次を確認しました：

- Explore の背景起動と完了通知、親による要約
- SendMessage による完了済みの子の再開と、再度の通知
- カスタム定義（`.claude/agents/counter.md`）の前景実行と、`agentId` / `<usage>` トレーラー
- TaskStop による停止と `killed` 通知
- `openai-codex` モデルを指定したカスタム定義で、子に AGENTS.md が `# claudeMd` として渡り、CC の Notes が入ること（親プロンプトなしで約800トークン）

claude-bridge の子では、前述の再試行により親プロンプトが含まれました。**実ターミナル上の表示は未確認**です。完全な CC 互換やピクセル一致は主張しません。

## 開発・検証

```bash
npm run typecheck
npm test
npm run preview
npm run preview -- --expanded
npm pack --dry-run
git diff --check
```
