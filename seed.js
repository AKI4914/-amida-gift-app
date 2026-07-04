/**
 * ギフトコード在庫の登録スクリプト
 * 使い方: node seed.js codes.csv
 * codes.csv の形式(ヘッダーなし): tier,code
 *   A,XXXX-XXXX-XXXX
 *   B,YYYY-YYYY-YYYY
 *   C,ZZZZ-ZZZZ-ZZZZ
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const file = process.argv[2];
if (!file) {
  console.error('使い方: node seed.js codes.csv');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'app.db'));
const insert = db.prepare(`INSERT OR IGNORE INTO gift_stock (tier, code) VALUES (?, ?)`);

const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
let count = 0;
const tx = db.transaction((rows) => {
  for (const row of rows) {
    const [tier, code] = row.split(',').map((s) => s.trim());
    if (!tier || !code) continue;
    insert.run(tier.toUpperCase(), code);
    count++;
  }
});
tx(lines);

console.log(`${count} 件のギフトコードを登録しました`);
