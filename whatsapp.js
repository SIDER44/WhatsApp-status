const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const logger = pino({ level: 'silent' });

// ─── Multi-session store ──────────────────────────────────────────
const sessions = new Map(); // userId -> { sock, status, pairingCode, pairingCodeAt, ... }

let _waVersion = null;
async function getWAWebVersion() {
  if (_waVersion) return _waVersion;
  try {
    const { version } = await fetchLatestWaWebVersion({});
    _waVersion = version;
    console.log('[wa] using WA Web version:', version.join('.'));
  } catch (e) {
    console.error('[wa] fetchLatestWaWebVersion failed:', e.message);
    const { version } = await fetchLatestBaileysVersion();
    _waVersion = version;
  }
  return _waVersion;
}

function getStatus() {
  const list = [...sessions.entries()].map(([id, s]) => ({
    userId: id,
    phoneNumber: s.phoneNumber,
    status: s.status,
    pairingCode: s.pairingCode,
    pairingCodeAt: s.pairingCodeAt,
    connectedAt: s.connectedAt,
  }));
  return {
    total: list.length,
    connected: list.filter(s => s.status === 'connected').length,
    sessions: list,
  };
}

async function createSession(userId, phoneNumber) {
  // Clean up old session for this userId
  if (sessions.has(userId)) {
    const old = sessions.get(userId);
    old._pairingActive = false;
    try { old.sock?.end?.(); } catch {}
    sessions.delete(userId);
  }

  const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  const authDir = path.join(dataDir, 'wa-auth', userId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await getWAWebVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 15000,
    retryRequestDelayMs: 2000,
    emitOwnEvents: false,
    fireInitQueries: true,
  });

  const session = {
    sock,
    userId,
    phoneNumber,
    status: 'connecting',
    pairingCode: null,
    pairingCodeAt: null,
    connectedAt: null,
    _pairingActive: true,
    _reconnectCount: 0,
    _reconnectScheduled: false,
  };
  sessions.set(userId, session);

  // ─── Pairing code retry loop (THE CRITICAL FIX) ─────────────────
  if (!sock.authState.creds.registered && phoneNumber) {
    (async () => {
      const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
      const delays = [2500, 5000, 8000, 12000, 15000];

      for (let attempt = 1; attempt <= delays.length; attempt++) {
        await new Promise(r => setTimeout(r, delays[attempt - 1]));

        if (!session._pairingActive || sessions.get(userId) !== session) return;
        if (session.status === 'connected' || session.pairingCode) return;
        if (sock.ws?.isClosed) return;

        try {
          const code = await sock.requestPairingCode(cleanNum);
          if (!session._pairingActive || sessions.get(userId) !== session) return;

          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          session.pairingCode = formatted;
          session.pairingCodeAt = Date.now();
          console.log(`[pair] [${userId}] attempt ${attempt} → ${formatted}`);
          return;
        } catch (e) {
          console.error(`[pair] [${userId}] attempt ${attempt}/${delays.length}:`, e.message);
        }
      }
      console.error(`[pair] [${userId}] all attempts exhausted`);
    })();
  }

  // ─── Connection lifecycle ──────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      session.status = 'connected';
      session.connectedAt = Date.now();
      session.pairingCode = null;
      session.pairingCodeAt = null;
      session._reconnectCount = 0;

      try {
        const myJid = sock.user?.id || '';
        const myNumber = myJid.replace(/:\d+@/, '@').split('@')[0].replace(/[^0-9]/g, '');
        if (myNumber) session.phoneNumber = myNumber;
      } catch {}

      console.log(`[session] connected [${userId}] → +${session.phoneNumber}`);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode : 500;
      const wasRegistered = !!sock.authState.creds.registered;
      const pairingSocket = !wasRegistered && !!phoneNumber;
      const loggedOut = statusCode === DisconnectReason.loggedOut ||
                        (statusCode === 401 && wasRegistered);
      const forbidden = statusCode === 403 || statusCode === DisconnectReason.forbidden;

      session._pairingActive = false;
      session.status = loggedOut ? 'logged_out' : 'reconnecting';

      if (loggedOut) {
        console.log(`[session] logged out [${userId}]`);
        await removeSession(userId);
        return;
      }

      if (forbidden) {
        session.status = 'forbidden';
        console.error(`[session] forbidden [${userId}] (403)`);
        return;
      }

      // Clean auth on 401 during pairing — CRITICAL FIX
      if (statusCode === 401 && pairingSocket) {
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(authDir, { recursive: true });
        console.log(`[session] pairing socket rejected [${userId}] (401) — starting fresh`);
      }

      if (session._reconnectScheduled || sessions.get(userId) !== session) return;
      session._reconnectScheduled = true;
      const backoff = pairingSocket ? 2500 : Math.min(20000, 5000 * Math.pow(1.5, session._reconnectCount));
      session._reconnectCount++;

      setTimeout(async () => {
        if (sessions.get(userId) !== session) return;
        session._reconnectScheduled = false;
        try {
          await createSession(userId, phoneNumber);
        } catch (e) {
          console.error(`[session] recreate failed [${userId}]:`, e.message);
        }
      }, backoff);
    }
  });

  return session;
}

async function requestPairing(phoneNumber) {
  if (!phoneNumber) throw new Error('Phone number required');
  const clean = phoneNumber.replace(/[^0-9]/g, '');
  if (clean.length < 7) throw new Error('Invalid phone number');

  const userId = `u_${clean}`;

  // Reuse existing session if connected
  const existing = sessions.get(userId);
  if (existing?.status === 'connected') {
    return { code: null, connected: true, message: 'Already connected' };
  }

  // Reuse fresh code if under 55s old
  const PAIR_TTL = 55000;
  if (existing?.pairingCode) {
    const age = Date.now() - (existing.pairingCodeAt || 0);
    if (age < PAIR_TTL) {
      return { code: existing.pairingCode, connected: false };
    }
  }

  // Create fresh session
  const session = await createSession(userId, clean);

  // Wait up to 90s for pairing code (polling)
  const MAX_WAIT = 90000;
  const POLL = 500;
  let waited = 0;

  while (!session.pairingCode && session.status !== 'connected' && waited < MAX_WAIT) {
    await new Promise(r => setTimeout(r, POLL));
    waited += POLL;
  }

  if (session.status === 'connected') {
    return { code: null, connected: true, message: 'Connected successfully' };
  }

  if (!session.pairingCode) {
    throw new Error('Could not generate pairing code. Check the logs or try again in 30s.');
  }

  return { code: session.pairingCode, connected: false };
}

async function removeSession(userId) {
  const session = sessions.get(userId);
  if (!session) return;
  session._pairingActive = false;
  try { session.sock?.end?.(); } catch {}
  sessions.delete(userId);
  const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  const authDir = path.join(dataDir, 'wa-auth', userId);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
}

// ─── Connect all existing sessions on startup ─────────────────────
async function connectWhatsApp() {
  const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  const authRoot = path.join(dataDir, 'wa-auth');
  if (!fs.existsSync(authRoot)) fs.mkdirSync(authRoot, { recursive: true });

  const existing = fs.readdirSync(authRoot).filter(f => {
    const stat = fs.statSync(path.join(authRoot, f));
    return stat.isDirectory() && f.startsWith('u_');
  });

  console.log(`[startup] restoring ${existing.length} session(s)...`);

  // Stagger restore
  let delay = 0;
  for (const userId of existing) {
    setTimeout(async () => {
      try {
        await createSession(userId, null);
        console.log(`[startup] restored ${userId}`);
      } catch (e) {
        console.error(`[startup] failed to restore ${userId}:`, e.message);
      }
    }, delay);
    delay += 500;
  }
}

function getSock() {
  // For scheduler — return first connected session
  for (const s of sessions.values()) {
    if (s.status === 'connected') return s.sock;
  }
  return null;
}

module.exports = {
  connectWhatsApp,
  requestPairing,
  getStatus,
  getSock,
  sessions,
  removeSession,
};
