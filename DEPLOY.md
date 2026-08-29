# akta.jp に載せる手順（ターミナル不要・全部ブラウザで完結）

コーダーへの依頼は不要です。使うのは「GitHubの画面」と「WordPressの管理画面」だけ。
所要時間の目安は30〜40分。途中で止めても、翌日その続きから再開できます。

---

## STEP 1 — GitHubにファイルを置く（10分）

1. https://github.com/ でアカウントを作る（akta名義の共用アカウントがあればそれで）
2. 右上「＋」→ **New repository**
   - Repository name: `akta-idwr`
   - **Public** を選ぶ（重要。Privateだと次のPagesが使えません）
   - 「Add a README file」は**チェックしない**
   - Create repository
3. 出てきた画面の **uploading an existing file** をクリック
4. 配布フォルダの中身を**フォルダごとまとめてドラッグ＆ドロップ**
   （`.github` フォルダも一緒に。これが自動更新の本体です）
5. 下の緑ボタン **Commit changes**

> つまずいたら：`.github` が見えない場合はMacの隠しフォルダ表示（`command + shift + .`）をオン。

---

## STEP 2 — データを一度取ってくる（5分・ボタンを押すだけ）

1. リポジトリ上部の **Actions** タブ
2. 「I understand my workflows, go ahead and enable them」が出たら押す
3. 左の **Update IDWR data** → 右の **Run workflow**
4. `years` の欄に **`2024 2025 2026`** と入力 → **Run workflow**
5. 2〜4分待つ。緑のチェックが付いたら成功
6. **Code** タブに戻ると `data.json` が増えている（クリックして中身が入っていれば完了）

これで過去3年分が入ります。**以降は毎週火曜に自動で更新**されるので、二度と触りません。

---

## STEP 3 — データを公開する（3分）

1. **Settings** タブ → 左メニュー **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** / **/(root)** → **Save**
4. 1〜2分後にページ上部にURLが出る（例：`https://akta-tokyo.github.io/akta-idwr/`）
5. そのURLの末尾に `data.json` を足してブラウザで開く
   → 数字がずらっと出れば成功。**このURLを控える**

---

## STEP 4 — 貼るコードのURLを書き換える（3分）

1. **Code** タブ → `akta-idwr-embed.html` をクリック
2. 右上の **鉛筆アイコン**（Edit this file）
3. 上から数行目の
   ```
   data-src="https://YOUR-USER.github.io/akta-idwr/data.json"
   ```
   を、STEP 3で控えたURLに書き換える
4. **Commit changes**

---

## STEP 5 — WordPressに貼る（5分）

1. `akta-idwr-embed.html` の画面で **Raw** ボタン → 全選択（`command + A`）→ コピー
2. akta.jp の管理画面 → **固定ページ → 新規追加**
3. タイトル：「東京の感染症 いま、どれくらい？」など
4. 本文のブロック追加（＋）→ **カスタムHTML** を選ぶ
5. コピーしたものを**そのまま貼り付け**
6. ブロック右上の **プレビュー** タブで表示を確認
7. 問題なければ **公開**

以上です。以後、毎週火曜の夜に数字が自動で入れ替わります。WordPress側は何もしません。

---

## STEP 5がうまくいかないとき（保険）

WordPressのセキュリティ設定やテーマによっては、カスタムHTMLブロック内の `<script>` が
削除されることがあります。**カードが出ず「読み込み中…」のまま**なら、これです。

その場合は**同梱の `index.html` 方式**に切り替えます（こちらも実装は不要）。

1. STEP 3のURL（`https://.../akta-idwr/`）をブラウザで開く → ダッシュボードが単体で表示される
2. WordPressのカスタムHTMLブロックに、代わりに以下だけを貼る

```html
<iframe src="https://YOUR-USER.github.io/akta-idwr/"
        title="東京の感染症 週ごとの報告数"
        style="width:100%;border:0;height:1200px" loading="lazy"></iframe>
<script>
addEventListener('message', function (e) {
  if (e.data && e.data.aktaIdwrHeight) {
    var f = document.querySelector('iframe[src*="akta-idwr"]');
    if (f) f.style.height = (e.data.aktaIdwrHeight + 20) + 'px';
  }
});
</script>
```

この `<script>` も消される環境なら、`height:1200px` を固定のまま使って構いません
（スマホでは `height:2400px` 程度が目安）。表示は問題なく成立します。

---

## つまずきポイント早見表

| 症状 | 原因 | 対処 |
|---|---|---|
| 「読み込み中…」のまま | `<script>` が削られている | 上記のiframe方式に切替 |
| 「データを読み込めませんでした」 | `data-src` のURLが違う／Pagesが未公開 | STEP 3のURLをブラウザで直接開いて確認 |
| 「デモデータを表示しています」のバッジが出る | `data.sample.json` を読んでいる | `data-src` が `data.json` を指しているか確認 |
| カードが1枚も出ない | STEP 2が未実行 | Actions → Run workflow を実行 |
| レイアウトが崩れる | テーマのCSSと衝突 | iframe方式に切替（完全に隔離されます） |

---

## 本当にコーダーが必要になる場面

このベータには**ありません**。必要になるのは、この先の話です。

- akta.jpのサーバー内に直接置きたい（GitHubを経由したくない）場合
- 東京都の週報から**保健所別・年齢別**を取りに行くフェーズ2
- ショートコード化して複数ページに置きたい場合

いずれも「まずこのベータを公開して、毎週黙って更新される」ことを確認してからで十分です。
