require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { connectWhatsApp, requestPairing, getStatus } = require('./whatsapp');
const { uploadVideo } = require('./catbox');
const { startScheduler } = require('./scheduler');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const tmpDir = path.join(dataDir, 'temp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir });

app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

app.post('/api/pair', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required' });
  }
  try {
    const code = await requestPairing(phoneNumber);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Video file required' });
    }
    const { caption, scheduledAt } = req.body;
    if (!scheduledAt) {
      return res.status(400).json({ error: 'Scheduled time required' });
    }

    const url = await uploadVideo(req.file.path);
    fs.unlinkSync(req.file.path);

    const when = new Date(scheduledAt).getTime();
    if (isNaN(when)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const info = db
      .prepare(
        `INSERT INTO posts (source_url, caption, scheduled_at)
         VALUES (?, ?, ?)`
      )
      .run(url, caption || '', when);

    res.json({
      success: true,
      id: info.lastInsertRowid,
      url,
      scheduledAt: new Date(when).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/queue', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, source_url, caption, scheduled_at, status, error
       FROM posts ORDER BY scheduled_at DESC LIMIT 50`
    )
    .all();
  res.json(rows);
});

app.delete('/api/queue/:id', (req, res) => {
  const info = db
    .prepare(`DELETE FROM posts WHERE id=? AND status='pending'`)
    .run(req.params.id);
  res.json({ deleted: info.changes > 0 });
});

app.listen(PORT, () => {
  console.log(`🌐 Panel running on port ${PORT}`);

  connectWhatsApp(() => {
    console.log('🚀 Starting scheduler...');
    startScheduler();
  });
});
