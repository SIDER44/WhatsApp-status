const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

async function uploadToLitterbox(filePath, time = '72h') {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', time);
  form.append('fileToUpload', fs.createReadStream(filePath));

  const res = await axios.post(
    'https://litterbox.catbox.moe/resources/internals/api.php',
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
    }
  );

  if (typeof res.data !== 'string' || !res.data.startsWith('http')) {
    throw new Error('Litterbox upload failed: ' + res.data);
  }
  return res.data.trim();
}

async function uploadToCatbox(filePath) {
  const userhash = process.env.CATBOX_USERHASH;
  if (!userhash) throw new Error('CATBOX_USERHASH not set');

  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('userhash', userhash);
  form.append('fileToUpload', fs.createReadStream(filePath));

  const res = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000,
  });

  if (typeof res.data !== 'string' || !res.data.startsWith('http')) {
    throw new Error('Catbox upload failed: ' + res.data);
  }
  return res.data.trim();
}

async function uploadVideo(filePath) {
  if (process.env.CATBOX_USERHASH) {
    try {
      console.log('☁️ Uploading to Catbox (permanent)...');
      return await uploadToCatbox(filePath);
    } catch (e) {
      console.log('Catbox failed, falling back to Litterbox:', e.message);
    }
  }
  console.log('☁️ Uploading to Litterbox (72h)...');
  return await uploadToLitterbox(filePath, '72h');
}

module.exports = { uploadVideo };
