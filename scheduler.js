const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { getSock } = require('./whatsapp');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';

async function downloadVideo(url) {
  const tmpDir = path.join(dataDir, 'temp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const filePath = path.join(tmpDir, `vid_${Date.now()}.mp4`);
  const writer = fs.createWriteStream(filePath);

  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 180000,
    maxContentLength: Infinity,
  });

  res.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return filePath;
}

async function postStatus(sock, post) {
  const localPath = await downloadVideo(post.source_url);
  const stat = fs.statSync(localPath);

  if (stat.size > 200 * 1024 * 1024) {
    fs.unlinkSync(localPath);
    throw new Error('Video too large (over 200MB)');
  }

  const buffer = fs.readFileSync(localPath);

  // Build a real contact list for statusJidList as per docs [citation:5][citation:14]
  let statusJidList = [];
  try {
    const contacts = await sock.getContacts();
    statusJidList = contacts
      .filter(c => c.id && c.id.endsWith('@s.whatsapp.net'))
      .map(c => c.id);

    console.log(`📤 Sending status to ${statusJidList.length} contact(s)...`);
  } catch (err) {
    console.error('Failed to fetch contacts:', err.message);
    statusJidList = [sock.user.id];
  }

  // Use the sendStatus method from the working Estella fork
  // Signature: sendStatus(jid, statusJid, content)
  await sock.sendStatus(
    sock.user.id,          // your own JID as sender
    'status@broadcast',    // the status broadcast JID
    {
      video: buffer,
      caption: post.caption || undefined,
      mimetype: 'video/mp4',
      statusJidList: statusJidList,
    }
  );

  fs.unlinkSync(localPath);
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const now = Date.now();
    const sock = getSock();
    if (!sock || !sock.user) return;

    const due = db
      .prepare(
        `SELECT * FROM posts WHERE status='pending' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC LIMIT 1`
      )
      .all(now);

    for (const post of due) {
      try {
        await postStatus(sock, post);
        db.prepare(
          `UPDATE posts SET status='posted', posted_at=? WHERE id=?`
        ).run(now, post.id);
        console.log(`✅ Post #${post.id} published`);
      } catch (err) {
        db.prepare(
          `UPDATE posts SET status='failed', error=? WHERE id=?`
        ).run(err.message, post.id);
        console.log(`❌ Post #${post.id} failed: ${err.message}`);
      }
    }
  });

  cron.schedule('0 * * * *', () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    db.prepare(
      `UPDATE posts SET status='deleted'
       WHERE status='posted' AND posted_at <= ?`
    ).run(cutoff);
  });
}

module.exports = { startScheduler };
