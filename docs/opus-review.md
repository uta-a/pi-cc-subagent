# Opus レビュー記録

## 実施方法

最初に `pi-subagents` の reviewer を Opus 4.6 で起動しましたが、インストール済み拡張の `runner-peer-preload.mjs` が欠けており、モデル実行前に失敗しました。ユーザーの許可を得て非対話 CLI に変更しました。

`omp models find opus --no-extensions` にはモデル登録がなかったため、Claude Code の非対話モードを使用しました。

```text
claude -p --model opus --effort high --safe-mode --tools "" \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --no-session-persistence --output-format json
```

`src/status.ts`、`src/index.ts`、`src/state.ts`、`src/runner.ts`、`src/render.ts`、`test/status.test.ts` の全文と、既存のステータスラインが拡張ステータスを2行目に表示する仕様を入力に渡しました。ツールなしの読み取り専用レビューです。

実際の応答メタデータのモデルは **`claude-opus-5-5`**、`is_error: false`、`terminal_reason: completed`。レビューは正常に完了しました。

## レビュー結論

> blocking な指摘はありません。

並行呼び出しの合成、終了・中断・shutdown時の解除、shutdown後の遅延callback抑止、非TUIでの抑止、自分のstatus keyだけを書き換える点は問題ないとの評価でした。

## 指摘と対応

| 重要度 | 指摘 | 対応 |
|---|---|---|
| Medium | 先の子が終了すると `explore-2` が `explore` に変わり、別の子の識別名を引き継ぐ | `WeakMap<Run, string>` に登録時のラベルを固定。並行呼び出しをまたいで採番し、全グループ終了後に採番をリセット。回帰テスト追加 |
| Low | providerのtool call idが重複するとグループが上書きされる可能性。demoとのkey衝突 | 実行ごとに `Symbol(id)` を発行し、demoにも専用Symbolを使用。同一IDの並行実行テスト追加 |
| Low | 本物の実行中にdemoが混ざる。不正引数でもdemoを消す | `ctx.isIdle()` と実行中controllerで開始を拒否。引数検査を先に実施。回帰テスト追加 |
| Low | signalを無視する子がいるとshutdown後もinterval/onUpdateが残る | shutdownでintervalをすべて解除。インスタンスの `disposed` で遅延onUpdateも抑止。実行中shutdownテスト追加 |
| Low・任意 | abort要求後、子の終了処理が戻るまではラベルが残る | 実際に停止完了するまで表示する仕様を維持しREADMEに明記 |
| Nit | shutdownでdemoTimer参照を空にしていない | `undefined` に戻す |
| テスト | `index.ts` 配線の終了・並行・demo・shutdownを追加検証すべき | `test/extension.test.ts` を追加。モデルとホストをstub化して統合経路を検証 |

指摘反映後、26件のテストと型チェックが成功。既存 `pi-cc-statusline` と併用した通常画面・全画面での下部表示と消去も PTY で確認しています。

## 操作実装の並列調査・実装

後続依頼で、非対話 CLI を2プロセス並列起動しました。

- **Opus 5.5**（応答の `modelUsage: claude-opus-5-5`）：公式2.1.63 の `cSq` / `e16` / `jb` / `qr8` / `Vkz` と、作業中のnavigation/status実装を読み取り専用レビュー。
- **Sonnet 5.5**（応答の `modelUsage: claude-sonnet-5-5`）：本体とは別の一時作業コピーでnavigation/statusテストを実装。本体への書き込みは許可せず、親が内容を確認・調整して統合。

Opus の指摘に基づき、次を修正しました。

1. グローバルな生入力リスナーをやめ、既存editorのhandleInputをラップ。権限確認や別の選択画面にフォーカスがあるときはキーを奪わない。
2. 選択を始める前の↑は履歴に渡す。入力が非空になったら選択を解除。
3. 全子終了時と詳細パネルを閉じたときは選択状態をリセット。
4. 詳細表示の外部テキストからCSI/OSCや制御文字を除去。子の出力で端末制御できないようにする。
5. パネルのcloseを冪等にし、shutdownでeditorフックと再描画timerを解除。
6. CCではネイティブトランスクリプト切替、こちらは読み取り専用パネルであることをREADMEに明記。Escでabortしない等の意図的差異も明記。

Sonnetのテスト案を新しいeditorラップ方式へ合わせて統合し、本体42件とステータスライン25件のテストが成功。通常画面・全画面の両方で、インストール済み全拡張と併用して ↓→Enter→↑→Enter の実操作を確認しました。

Opusがレビューしたのは修正前のドラフトです。上記指摘反映後の追加Opus再レビューは実施していません。
