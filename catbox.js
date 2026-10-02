const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const mediaDir = path.join(dataDir, 'media');

if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
  console.log(`📁 Created media folder: ${mediaDir}`);
}

async function uploadVideo(filePath) {
  const ext = path.extname(filePath) || '.mp4';
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${id}${ext}`;
  const dest = path.join(mediaDir, filename);

  fs.renameSync(filePath, dest);

  console.log(`💾 Video saved locally: ${filename}`);
  return `local:${filename}`;
}

module.exports = { uploadVideo };
