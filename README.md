# 阿弥陀経なぞり × Amazonギフト自動付与システム

## 全体の流れ
1. ユーザーがLINE公式アカウントからLIFFアプリを開く
2. 経文をタップして「次へ」進めながら読経音源を聴く
3. あらかじめ設定したチェックポイント(商品A/B/Cの位置)に到達すると
   サーバーが自動でユーザーを識別し、未使用のAmazonギフトコードを1件確保
4. LINEのプッシュメッセージでギフトコードがトークに自動送信される
5. 同じユーザーが同じチェックポイントを再度通過しても、DB上で
   「達成済み」と判定されるため二重付与されない

---

## 手順1: LINE Developersでの準備

1. https://developers.line.biz/console/ で **プロバイダー** を作成
2. **Messaging APIチャネル** を作成 → ここで
   - `Channel access token`(長期)を発行
   - `Channel secret` を控える
3. 同じチャネルに **LIFF** を追加(Add LIFF app)
   - サイズ: Full を推奨(なぞりUIが画面いっぱいになるため)
   - エンドポイントURL: デプロイ後のURL(例: `https://your-domain.com/public/index.html`)
   - 発行された `LIFF ID` を `public/index.html` の `YOUR_LIFF_ID` に反映
4. Webhook URLに `https://your-domain.com/webhook` を設定し、Webhookを有効化

---

## 手順2: サーバーのセットアップ

```bash
cd amida-gift-app
npm install
cp .env.example .env
# .envを編集してLINEの認証情報を記入
```

## 手順3: ギフトコード在庫の登録

Amazonビジネス等で購入したギフトコードをCSVにまとめます(例 `codes.csv`):

```
A,XXXX-XXXX-XXXX
A,XXXX-XXXX-XXXX
B,YYYY-YYYY-YYYY
C,ZZZZ-ZZZZ-ZZZZ
```

```bash
node seed.js codes.csv
```

在庫の残数確認:
```bash
curl http://localhost:3000/api/stock
```

## 手順4: 音源の設置

`public/sutra-audio.mp3` に読経音源を配置してください(著作権・使用許諾済みの音源を使用)。

## 手順5: 起動

```bash
npm start
```

ローカル確認時はngrok等でHTTPS化してLIFFのエンドポイントURLに設定してください。
本番運用では Render / Railway / Vercel(Node実行環境) / AWS 等にデプロイします。

---

## 経文とチェックポイントのカスタマイズ

`public/index.html` 内の `SEGMENTS` 配列を編集します。

```js
{ text: "経文の一部", checkpoint: "A" } // このセグメントを読み終えたら商品Aを付与
```

`checkpoint` に `"A"` `"B"` `"C"` を設定した箇所を通過した瞬間に、
サーバー側で該当商品の付与ロジックが走ります。
商品の金額やラベルは `server.js` の `TIERS` オブジェクトで変更できます。

```js
const TIERS = {
  A: { label: 'Amazonギフト 3,000円分', amount: 3000 },
  B: { label: 'Amazonギフト 5,000円分', amount: 5000 },
  C: { label: 'Amazonギフト 10,000円分', amount: 10000 },
};
```

---

## セキュリティ・不正防止のポイント

- **idToken検証**: フロントから送られる `idToken` を毎回LINEサーバーに問い合わせて検証しているため、
  ユーザーIDの偽装はできません。
- **DBのUNIQUE制約**: `progress` テーブルは `(line_user_id, tier)` が主キーのため、
  同一ユーザー・同一チェックポイントの二重付与はDBレベルで防止されます。
- **在庫ロック**: `better-sqlite3` の同期トランザクションでギフトコード取得〜使用済みフラグ更新を
  アトミックに行っているため、同時アクセスでも同じコードが2人に渡ることはありません。

---

## 法務上の注意(重要)

- 何らかの購入・申込を条件にギフト券を付与する場合、**景品表示法**の景品類の上限規制に
  抵触しないか確認が必要です(取引価額に応じた上限額あり)。単なる無料キャンペーンでも、
  内容によっては規制対象となる場合があります。
- Amazonギフト券の大量購入・第三者への再配布についてはAmazonの利用規約も確認してください。
- 上記は一般的な情報であり法的助言ではありません。実施前に弁護士等の専門家にご確認ください。

---

## ディレクトリ構成

```
amida-gift-app/
├── server.js          # バックエンドAPI(進捗判定・ギフト付与・LINE連携)
├── seed.js            # ギフトコード在庫登録スクリプト
├── package.json
├── .env.example
├── app.db             # SQLite DB(初回起動時に自動作成)
└── public/
    └── index.html      # LIFFフロントエンド(なぞりUI)
```
