require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const {
  connectWhatsApp,
  requestPairing,
  getStatus,
  removeSession,
} = require('./whatsapp');
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

// Raise multer limits so large videos don't trip the server
const upload = multer({
  dest: tmpDir,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
  },
});

// ─── Status ────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

// ─── Pair ──────────────────────────────────────────────────
app.post('/api/pair', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });
  try {
    const result = await requestPairing(phoneNumber);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Unlink session ────────────────────────────────────────
app.delete('/api/sessions/:userId', async (req, res) => {
  await removeSession(req.params.userId);
  res.json({ ok: true });
});

// ─── Schedule post ─────────────────────────────────────────
app.post('/api/schedule', (req, res) => {
  upload.single('video')(req, res, async (err) => {
    // Multer errors (size limit, disk, etc.)
    if (err) {
      console.error('Upload middleware error:', err.message);
      return res.status(500).json({ error: 'Upload failed: ' + err.message });
    }

    try {
      if (!req.file) return res.status(400).json({ error: 'Video file required' });
      const { caption, scheduledAt, tzOffset } = req.body;
      if (!scheduledAt) return res.status(400).json({ error: 'Scheduled time required' });

      const offsetMin = parseInt(tzOffset, 10);
      const asIfUTC = new Date(scheduledAt + ':00Z').getTime();
      const when = isNaN(offsetMin)
        ? new Date(scheduledAt).getTime()
        : asIfUTC + (offsetMin * 60 * 1000);

      if (isNaN(when)) return res.status(400).json({ error: 'Invalid date format' });

      console.log(`📤 Uploading to Catbox (size: ${(req.file.size / 1024 / 1024).toFixed(1)} MB)...`);

      // Wrap Catbox upload with timeout so we can see where it's failing
      const url = await Promise.race([
        uploadVideo(req.file.path),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Catbox upload timed out after 4 minutes')), 240000)
        ),
      ]);

      fs.unlinkSync(req.file.path);

      const info = db.prepare(
        `INSERT INTO posts (source_url, caption, scheduled_at) VALUES (?, ?, ?)`
      ).run(url, caption || '', when);

      res.json({
        success: true,
        id: info.lastInsertRowid,
        url,
        scheduledAtUTC: new Date(when).toISOString(),
        scheduledAtNairobi: new Date(when).toLocaleString('en-KE', {
          timeZone: 'Africa/Nairobi',
          hour12: false,
        }),
      });
    } catch (err) {
      console.error('Schedule error:', err.message);
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      res.status(500).json({ error: err.message });
    }
  });
});

// ─── Queue list ────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  const rows = db.prepare(
    `SELECT id, source_url, caption, scheduled_at, status, error, posted_at
     FROM posts ORDER BY scheduled_at DESC LIMIT 50`
  ).all();

  const formatted = rows.map(r => ({
    ...r,
    scheduledNairobi: new Date(r.scheduled_at).toLocaleString('en-KE', {
      timeZone: 'Africa/Nairobi',
      hour12: false,
    }),
    postedNairobi: r.posted_at ? new Date(r.posted_at).toLocaleString('en-KE', {
      timeZone: 'Africa/Nairobi',
      hour12: false,
    }) : null,
  }));

  res.json(formatted);
});

// ─── Delete one post ───────────────────────────────────────
app.delete('/api/queue/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM posts WHERE id=?`).run(req.params.id);
  res.json({ deleted: info.changes > 0 });
});

// ─── POST NOW ──────────────────────────────────────────────
app.post('/api/post-now/:id', async (req, res) => {
  try {
    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    db.prepare(`UPDATE posts SET scheduled_at=? WHERE id=?`)
      .run(Date.now() - 1000, post.id);

    res.json({
      ok: true,
      message: `Post #${post.id} will fire within 60 seconds. Check Activity Log.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLEAR QUEUE ───────────────────────────────────────────
app.post('/api/clear-queue', (req, res) => {
  const { status } = req.body || {};
  let info;
  if (status) {
    info = db.prepare(`DELETE FROM posts WHERE status=?`).run(status);
  } else {
    info = db.prepare(`DELETE FROM posts`).run();
  }
  res.json({
    ok: true,
    deleted: info.changes,
    message: status
      ? `Deleted ${info.changes} post(s) with status "${status}"`
      : `Deleted all ${info.changes} post(s)`,
  });
});

// ─── UNDELETE / RESTORE ────────────────────────────────────
app.post('/api/undelete/:id', (req, res) => {
  try {
    const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const newTime = Date.now() + 60000;
    db.prepare(
      `UPDATE posts SET status='pending', error=NULL, scheduled_at=? WHERE id=?`
    ).run(newTime, post.id);

    res.json({
      ok: true,
      message: `Post #${post.id} restored. Will fire in ~60 seconds.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ACTIVITY LOG ──────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  try {
    const day = req.query.day;
    let startMs, endMs, dayLabel;
    const now = new Date();

    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const [y, m, d] = day.split('-').map(Number);
      startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - (3 * 60 * 60 * 1000);
      endMs = startMs + 24 * 60 * 60 * 1000;
      dayLabel = day;
    } else {
      const nairobiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
      const y = nairobiNow.getFullYear();
      const m = nairobiNow.getMonth();
      const d = nairobiNow.getDate();
      startMs = Date.UTC(y, m, d, 0, 0, 0) - (3 * 60 * 60 * 1000);
      endMs = startMs + 24 * 60 * 60 * 1000;
      dayLabel = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    const posts = db.prepare(`
      SELECT id, source_url, caption, scheduled_at, status, error, posted_at
      FROM posts
      WHERE (scheduled_at >= ? AND scheduled_at < ?)
         OR (posted_at IS NOT NULL AND posted_at >= ? AND posted_at < ?)
      ORDER BY COALESCE(posted_at, scheduled_at) ASC
    `).all(startMs, endMs, startMs, endMs);

    const entries = [];
    for (const p of posts) {
      entries.push({
        time: p.scheduled_at,
        timeNairobi: new Date(p.scheduled_at).toLocaleString('en-KE', {
          timeZone: 'Africa/Nairobi',
          hour12: false,
        }),
        type: 'scheduled',
        icon: '📅',
        postId: p.id,
        message: `Post #${p.id} scheduled`,
        url: p.source_url,
      });

      if (p.posted_at) {
        entries.push({
          time: p.posted_at,
          timeNairobi: new Date(p.posted_at).toLocaleString('en-KE', {
            timeZone: 'Africa/Nairobi',
            hour12: false,
          }),
          type: 'posted',
          icon: '✅',
          postId: p.id,
          message: `Post #${p.id} published to WhatsApp Status`,
          url: p.source_url,
        });
      }

      if (p.status === 'failed' && p.error) {
        entries.push({
          time: p.posted_at || p.scheduled_at,
          timeNairobi: new Date(p.posted_at || p.scheduled_at).toLocaleString('en-KE', {
            timeZone: 'Africa/Nairobi',
            hour12: false,
          }),
          type: 'failed',
          icon: '❌',
          postId: p.id,
          message: `Post #${p.id} failed: ${p.error}`,
          url: p.source_url,
        });
      }
    }

    entries.sort((a, b) => b.time - a.time);

    res.json({
      day: dayLabel,
      dayRange: {
        startUTC: new Date(startMs).toISOString(),
        endUTC: new Date(endMs).toISOString(),
      },
      count: entries.length,
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌐 Panel running on port ${PORT}`);
  connectWhatsApp().then(() => {
    console.log('🚀 Starting scheduler...');
    startScheduler();
  });
});
