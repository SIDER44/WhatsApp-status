const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'queue.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT,
  caption TEXT,
  scheduled_at INTEGER,
  status TEXT DEFAULT 'pending',
  posted_at INTEGER,
  error TEXT
);
`);

module.exports = db;
