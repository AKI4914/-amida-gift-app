/**
 * 阿弥陀経なぞり × Amazonギフト自動付与システム
 * -------------------------------------------------
 * 構成:
 *  - LIFFアプリ(public/index.html)がユーザーの「なぞり進捗」を計測
 *  - チェックポイント到達時に idToken 付きで /api/checkpoint を叩く
 *  - サーバー側で idToken を検証 → userId を確定
 *  - DB上で「そのユーザー×そのtierが未達成」なら
 *      1) 未使用のギフトコードを1件ロックして取得
 *      2) LINE Messaging API のプッシュメッセージで送付
 *      3) 進捗テーブルに完了記録(以後は二重付与されない)
 */

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const line = require('@line/bot-sdk');
const path = require('path');
const https = require('https');

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  LIFF_CHANNEL_ID, // LIFFが紐づくチャネルID(idToken検証に使用)
  PORT = 3000,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !LIFF_CHANNEL_ID) {
  console.warn('[警告] .env の LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / LIFF_CHANNEL_ID を設定してください');
}

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ---------------------------------------------------------
// DB初期化
// ---------------------------------------------------------
const db = new Database(path.join(__dirname, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gift_stock (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tier       TEXT NOT NULL,          -- 'A' | 'B' | 'C'
  code       TEXT NOT NULL UNIQUE,   -- Amazonギフトコード
  used       INTEGER NOT NULL DEFAULT 0,
  used_by    TEXT,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS progress (
  line_user_id TEXT NOT NULL,
  tier         TEXT NOT NULL,
  code_sent    TEXT,
  completed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (line_user_id, tier)
);
`);

// tier(商品)定義。金額はここを変えるだけで反映される
const TIERS = {
  A: { label: 'Amazonギフト 3,000円分', amount: 3000 },
  B: { label: 'Amazonギフト 5,000円分', amount: 5000 },
  C: { label: 'Amazonギフト 10,000円分', amount: 10000 },
};

// ---------------------------------------------------------
// Expressアプリ
// ---------------------------------------------------------
const app = express();
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- LINE Webhook(友だち追加時などにuserIdを記録) ---
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  const events = req.body.events || [];
  events.forEach((ev) => {
    if (ev.source && ev.source.userId) {
      db.prepare(
        `INSERT OR IGNORE INTO users (line_user_id) VALUES (?)`
      ).run(ev.source.userId);
    }
  });
  res.sendStatus(200);
});

// checkpoint API 以降は JSON ボディを使うのでここで初めて有効化
app.use(express.json());

// --- idTokenを検証してuserIdを取得 ---
function verifyIdToken(idToken) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      id_token: idToken,
      client_id: LIFF_CHANNEL_ID,
    }).toString();

    const req = https.request(
      {
        hostname: 'api.line.me',
        path: '/oauth2/v2.1/verify',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.sub) resolve(json.sub); // sub = userId
            else reject(new Error('idToken検証失敗: ' + body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// --- ギフトコードを1件ロックして取り出す(トランザクションで二重付与を防止) ---
const grantGift = db.transaction((userId, tier) => {
  // 1) すでに達成済みならそのまま返す(冪等性の担保)
  const already = db
    .prepare(`SELECT * FROM progress WHERE line_user_id = ? AND tier = ?`)
    .get(userId, tier);
  if (already) {
    return { alreadyGranted: true, code: already.code_sent };
  }

  // 2) 未使用の在庫を1件だけ確保
  const stock = db
    .prepare(`SELECT * FROM gift_stock WHERE tier = ? AND used = 0 LIMIT 1`)
    .get(tier);
  if (!stock) {
    throw new Error('OUT_OF_STOCK');
  }

  db.prepare(`UPDATE gift_stock SET used = 1, used_by = ?, used_at = datetime('now') WHERE id = ?`)
    .run(userId, stock.id);

  db.prepare(
    `INSERT INTO progress (line_user_id, tier, code_sent) VALUES (?, ?, ?)`
  ).run(userId, tier, stock.code);

  return { alreadyGranted: false, code: stock.code };
});

// --- チェックポイント到達API(LIFFフロントから呼ばれる) ---
app.post('/api/checkpoint', async (req, res) => {
  try {
    const { idToken, tier } = req.body;
    if (!idToken || !TIERS[tier]) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const userId = await verifyIdToken(idToken);
    db.prepare(`INSERT OR IGNORE INTO users (line_user_id) VALUES (?)`).run(userId);

    const result = grantGift(userId, tier);

    if (!result.alreadyGranted) {
      // LINEプッシュメッセージでギフトコードを送付
      await lineClient.pushMessage(userId, {
        type: 'text',
        text:
          `🙏 読誦お疲れ様でした。\n` +
          `${TIERS[tier].label} のコードをお届けします。\n\n` +
          `コード: ${result.code}\n\n` +
          `Amazonの公式サイトでチャージ残高に登録してご利用ください。`,
      });
    }

    res.json({ ok: true, alreadyGranted: result.alreadyGranted });
  } catch (e) {
    if (e.message === 'OUT_OF_STOCK') {
      console.error('在庫切れ:', req.body.tier);
      return res.status(409).json({ error: 'out_of_stock' });
    }
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- 在庫確認用の簡易API(運営が残数を見る用) ---
app.get('/api/stock', (req, res) => {
  const rows = db
    .prepare(`SELECT tier, COUNT(*) as remaining FROM gift_stock WHERE used = 0 GROUP BY tier`)
    .all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
