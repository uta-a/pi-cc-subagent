# Claude Code 表示コードの参照記録

## 一次資料

- 公式 npm パッケージ：`@anthropic-ai/claude-code@2.1.19`
- 取得元：<https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.19.tgz>
- 読んだファイル：`package/cli.js`（公式の minify 済み JavaScript）
- `cli.js` SHA-256：`3d3870923b4d20ba50c866cc2b23ce2c75ec2b64161e06f06835d74a42dc85f0`

スクリーンショットや第三者による流出コードではなく、公式配布物のコードを直接確認しました。配布物は作業用の `/tmp/pi-cc-reference` に取得しており、本パッケージには同梱していません。minify 済みのため、以下の関数名はバージョン固有です。

## 確認した箇所

| 関数・定数 | 確認内容 | 本実装 |
|---|---|---|
| `gU7`, `uv6` | タスクの短い description と agent type、汎用種別は `Task` | `src/render.ts` |
| `v6` | 子の行頭に半角2スペース + `⎿` + スペース + NBSP | `src/render.ts` |
| `xWA`, `N62=3` | 通常時は直近3件、隠れた件数、展開キーのヒント | `src/render.ts` |
| `xWA`, `E62=9`, `k62=7` | 画面高が不足すると `In progress…` 表示 | `src/render.ts`（単一実行は16行未満） |
| `mU7` | `Done (… tool use(s) · … tokens · …)`、通常は結果本文を隠す | `summary`, `stats` |
| `UmA`, `Bv6` | 展開時の `Prompt:` / `Response:`、本文2スペース字下げ | `renderRuns` |
| `pU7` | `Running N <type> agents…` / `N <type> agents finished` | `renderRuns` |
| `BU7` | `├─`, `└─`, `│`、左3スペース、各子の最新アクティビティ | `renderRuns` |
| `M3` | 英語 compact notation、1000以上は小数1桁、小文字化 | `formatTokens` |
| `Dw` | 秒・分・時・日の実行時間表示 | `formatDuration` |
| `KE6`, `R62` | 最後のモデル応答のトークン合計を表示 | `src/runner.ts` |

これらの表示仕様から独立した TypeScript レンダラーを作成しています。元の React/Ink コンポーネントをコピーして組み込んだものではありません。

## 下部エージェント表示の追加調査（2.1.63）

- 公式 npm パッケージ：`@anthropic-ai/claude-code@2.1.63`
- 取得元：<https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.63.tgz>
- 読んだファイル：`package/cli.js`
- SHA-256：`12809142119cce671afbd9d422b524778de786752aeef2ba1f70879b5d4dce0d`
- 作業用取得先：`/tmp/pi-cc-reference-2.1.63`（配布物は同梱しない）

| 関数 | 確認内容 | Pi での対応 |
|---|---|---|
| `ckz` | ステータスライン `WCq` と、その下の `DCq` を縦配置 | 既存フッターの拡張ステータス行を使用 |
| `qr8` | タスク一覧から下部表示用のエージェントを選び、幅に合わせて名前を表示 | 実行中のみ、最大8バッジと残件数 |
| `Vkz` | `@名前` を種別色・idle・選択状態で描画 | Pi テーマ色の `● explore` / `● worker` / `● plan` |
| `Mkz`, `Pkz` | チームメンバーの名前・色・idleを取り出し、名前順に並べる | ローカル子タスクの役割をラベルに変換し、登録順で表示 |
| `ZCq`, `dkz` | ローカルエージェントの経過時間・最新動作等の下部一覧 | 統計・動作の詳細は既存の履歴内ツール行に集約 |

**忠実なコピーではない部分：** 2.1.63 のチーム下部ラベルは `@名前` であり、ユーザー例の `● explore` / `● worker` そのものではありません。依頼のドット表示に変更し、チームでなくこの拡張が起動した子を対象にしています。選択用矢印やクリック・管理ショートカットは表示しません。フッターを差し替えず `ctx.ui.setStatus("cc-subagent", text)` を使用します。`pi-cc-statusline` は `footerData.getExtensionStatuses()` をメイン行の下に描画するため、既存のステータスラインを保ったまま下部に表示できます。

2.1.19 の `yM1` / `L4K` も確認しましたが、この版はチームメンバーを縦の枝線で描く実装です。画像に合わせた現在の表示は白太字の `● main`、灰色の `○ Explore タスク名` と右寄せ統計です。2.1.63 の `@名前` pill をそのまま移植したものではありません。

## 操作コードの確認と Pi への適応

Opus 5.5 に公式 2.1.63 の下記コードを渡し、挙動をレビューしました。

- `cSq`：`none` / `selecting-agent` / `viewing-agent` の状態管理。確認したハンドラでは Shift+↓ で選択、Enter で子の表示へ。main の Enter は leader に復帰。
- `e16`：`viewingAgentTaskId` を設定して子のトランスクリプト表示へ移る。
- `jb`：表示対象・選択状態を解除して leader に戻る。
- 実行中の子を表示中の Esc は子のabortを試みる。完了した子の表示は維持される。
- この版の main／子選択は主に `in_process_teammate` 対象であり、Task の `local_agent` と同一のUIではない。

**本実装の違い：** `src/navigation.ts` は Pi の既存editorをラップし、editorにフォーカスがあるときだけキーを処理します。入力が空のときの ↓ から選択、選択中の↑↓で移動、Enterでライブ詳細パネルを表示します。入力文章・履歴・別ダイアログの入力を妨げないようにしています。パネル内でも↑↓で対象を切り替えられます。mainへ移動した時点でパネルを閉じ、mainでEnterを押してもパネルは開きません。Enter／Escもパネルを閉じるだけで、子をabortしません。

Pi の会話トランスクリプト差し替えではありません。子の現在の動作・活動・生成中テキスト・最終結果を読み取り専用で表示する独立実装です。mainではプレビューを閉じ、通常のPiの会話へ戻ります。未実装のkillや管理操作まで「CCと同等」とはしていません。

## 意図的な差異

- 文字色は Claude の固定パレットではなく Pi のテーマに追従。
- `●` は Pi のセマンティックカラーで状態を区別。Claude の専用スピナー処理は使用しない。
- 子のツール表示名は Pi のツールから対応付け（`read` → `Read` 等）。Claude 固有の各ツール結果のレンダラーは再実装しない。
- 子のツール呼び出し件数は実際の呼び出し数。進捗メッセージ数を数える Claude の内部表現とは異なる。
- 表示履歴は上限200件。上限後の「more」件数は保持中の項目内の件数。
- 並列ツリーは単一 `tasks` 呼び出し内。Pi の別々のツール行を統合する内部 API には依存しない。
- 中断は `Interrupted`、エラーは `Error: …`。Claude 固有の「What should Claude do instead?」は表示しない。
- 非常に小さい秒数、境界での期間丸めは実用的な Pi 側の処理を使用。
- 展開時の応答は Markdown レンダリングではなく折り返し付きテキスト。

## 再確認

別の一時ディレクトリで：

```bash
npm pack @anthropic-ai/claude-code@2.1.19
# tar -xzf <取得した tgz>
# cli.js の上記関数名や "Done ("、"Initializing…" を検索
```

下部表示の参照コードは `npm pack @anthropic-ai/claude-code@2.1.63` で取得し、`qr8`、`Vkz`、`ckz` を検索できます。

Pi 側は `npm test`、`npm run preview`、`/cc-subagent-demo`、`/cc-subagent-status-demo` で比較できます。最新版 Claude Code との表示一致を確認した記録ではありません。
