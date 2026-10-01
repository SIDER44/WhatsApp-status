const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let sock = null;
let status = {
  connected: false,
  registered: false,
  user: null,
  pairingCode: null,
};

function getStatus() {
  return status;
}

async function connectWhatsApp(onReady) {
  const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  const authDir = path.join(dataDir, 'wa-auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      status.connected = true;
      status.registered = true;
      status.user = sock.user?.id?.split(':')[0] || 'unknown';
      console.log('✅ WhatsApp connected as', status.user);
      if (onReady) onReady(sock);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      status.connected = false;
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete wa-auth and re-pair.');
        status.registered = false;
      } else {
        console.log('🔄 Reconnecting...');
        setTimeout(() => connectWhatsApp(onReady), 3000);
      }
    }
  });

  return sock;
}

async function requestPairing(phoneNumber) {
  if (!sock) throw new Error('WhatsApp not initialized yet');
  if (sock.authState.creds.registered) throw new Error('Already registered');
  if (!phoneNumber) throw new Error('Phone number required');

  const clean = phoneNumber.replace(/\D/g, '');
  const code = await sock.requestPairingCode(clean);
  status.pairingCode = code;
  return code;
}

module.exports = {
  connectWhatsApp,
  requestPairing,
  getStatus,
  getSock: () => sock,
};
