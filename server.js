// server.js (corrigido: fallback para uuid via crypto.randomUUID)
// Mantive todo o comportamento anterior; só adicionei fallback seguro para uuid
// Requisitos: node >= 14 (Node 18+/25 tem fetch & crypto.randomUUID nativos)

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs-extra'); // mantido (se não existir no ambiente, será erro — geralmente está no package.json)
const FormData = require('form-data');
// tentar require('uuid') com fallback para crypto.randomUUID
let uuidv4;
try {
  // prefer explicit require if installed
  uuidv4 = require('uuid').v4;
} catch (e) {
  // fallback: use crypto.randomUUID if available (Node 14.17+/18+), else use a timestamp+random
  const crypto = require('crypto');
  if (crypto && typeof crypto.randomUUID === 'function') {
    uuidv4 = () => crypto.randomUUID();
  } else {
    uuidv4 = () => {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    };
  }
}

const { Server } = require('socket.io');

// Safe fetch: use globalThis.fetch when available (Node 18+ / 25), otherwise dynamic import node-fetch.
// This avoids crashing when node-fetch is not installed on environments that already provide fetch.
const fetch = (globalThis && globalThis.fetch)
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["*"],
    methods: ["GET","POST"]
  }
});

// CONFIGURAÇÃO
const PORT = process.env.PORT || 3000;
const FIXED_SESSION = process.env.FIXED_SESSION || 'cabine-fixa';
const TMP_DIR = path.join(__dirname, 'tmp');
fs.ensureDirSync(TMP_DIR);

// IMGBB KEY (opcional)
const IMGBB_KEY = process.env.IMGBB_KEY || null;

// Body parsers
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------
// In-memory session store
// ------------------------
/*
 sessions[sessionId] = {
   operators: Set(socketId),
   viewers: Set(socketId),
   viewerMeta: { socketId: {...} },
   lastFrame: 'data:image/jpeg;base64,...',      // cached last low-res frame
   lastFrameTs: 0,                               // timestamp last frame was accepted
   viewerSessions: { viewerId: { urls: [], createdAt } } // viewer visualizador metadata
 }
*/
const sessions = {};

function ensureSession(sid) {
  if (!sessions[sid]) {
    sessions[sid] = {
      operators: new Set(),
      viewers: new Set(),
      viewerMeta: {},
      lastFrame: null,
      lastFrameTs: 0,
      viewerSessions: {}
    };
  }
  return sessions[sid];
}

// Rate limit per session for frames (ms between accepted frames)
const MIN_FRAME_INTERVAL_MS = 1000 / 60; // target up to 60 FPS (rough throttle)

// ------------------------
// Socket.IO handlers
// ------------------------
io.on('connection', (socket) => {
  console.log('[SOCKET] conectado:', socket.id);

  // Join a session (operator or viewer)
  socket.on('join_session', ({ session, role }) => {
    const sid = session || FIXED_SESSION;
    ensureSession(sid);
    socket.data.session = sid;
    socket.data.role = role || 'viewer';

    if (socket.data.role === 'operator') {
      sessions[sid].operators.add(socket.id);
      socket.join(`${sid}:operators`);
      console.log(`[SESSION ${sid}] Operador entrou: ${socket.id}`);
      // send cached frame to new operator (optional)
      if (sessions[sid].lastFrame) {
        socket.emit('stream_frame', { session: sid, frame: sessions[sid].lastFrame });
      }
    } else {
      sessions[sid].viewers.add(socket.id);
      socket.join(`${sid}:viewers`);
      sessions[sid].viewerMeta[socket.id] = { connectedAt: Date.now() };
      console.log(`[SESSION ${sid}] Viewer entrou: ${socket.id}`);
      // notify operators
      io.in(`${sid}:operators`).emit('peer_joined', { id: socket.id, role: 'viewer', session: sid });
      // if we have cached frame, send immediately; else notify pending
      if (sessions[sid].lastFrame) {
        socket.emit('stream_frame', { session: sid, frame: sessions[sid].lastFrame });
      } else {
        socket.emit('stream_pending', { session: sid });
      }
    }

    // emit counts to both groups
    io.in(`${sid}:operators`).emit('viewer_count', {
      viewers: sessions[sid].viewers.size,
      operators: sessions[sid].operators.size
    });
    io.in(`${sid}:viewers`).emit('viewer_count', {
      viewers: sessions[sid].viewers.size,
      operators: sessions[sid].operators.size
    });
  });

  // Viewer requests stream (server notifies operators and returns cached frame if any)
  socket.on('request_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(`${sid}:operators`).emit('want_stream', { session: sid, viewerId: socket.id });
    const last = sessions[sid].lastFrame;
    if (last) {
      socket.emit('stream_frame', { session: sid, frame: last });
    } else {
      socket.emit('stream_pending', { session: sid });
    }
  });

  // Operator sends a preview frame (low-res) to broadcast to viewers
  // We will cache last frame and broadcast to viewers with throttling
  socket.on('stream_frame', ({ session, frame }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);

    const now = Date.now();
    const elapsed = now - (sessions[sid].lastFrameTs || 0);
    // Accept frame if enough time passed (throttle)
    if (elapsed >= MIN_FRAME_INTERVAL_MS) {
      sessions[sid].lastFrame = frame;
      sessions[sid].lastFrameTs = now;
      // Broadcast to viewers in that session
      io.in(`${sid}:viewers`).emit('stream_frame', { session: sid, frame });
    } else {
      // Too frequent: ignore or optionally update cache without broadcast
      sessions[sid].lastFrame = frame; // keep cache up to date
      // don't broadcast to avoid flooding
    }
  });

  // Operator can explicitly stop streaming for a session
  socket.on('stop_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // Notify viewers that stream stopped (clients can show message)
    io.in(`${sid}:viewers`).emit('stream_stopped', { session: sid });
    console.log(`[SESSION ${sid}] stream stopped by operator ${socket.id}`);
  });

  // Viewer asks operator(s) to take a high-res photo (operator captures and replies with photo_ready)
  socket.on('take_photo', ({ session, index, viewerId }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // forward to operators; operator will emit photo_ready
    io.in(`${sid}:operators`).emit('take_photo', { session: sid, index, viewerId });
  });

  // Operator sends captured photo (high-res) back to a specific viewer, or broadcast if no viewerId
  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    if (viewerId) {
      io.to(viewerId).emit('photo_ready', { index, photo });
    } else {
      io.in(`${sid}:viewers`).emit('photo_ready', { index, photo });
    }
  });

  // Viewer submits final photos (array of data URLs) -> forwarded to operators for montage/upload
  socket.on('photos_submit', async ({ session, viewerId, photos }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    console.log(`[SESSION ${sid}] photos_submit from ${viewerId} (${photos.length})`);
    io.in(`${sid}:operators`).emit('photos_submit', { viewerId, photos, session: sid });
    // Acknowledge viewer immediately
    io.to(viewerId).emit('photos_received', { status: 'ok' });

    // Optionally upload to IMGBB and/or create viewer session (if logic desired server-side)
    // Here we don't auto-upload unless create_viewer_session is called by operator or if IMGBB_KEY env var is used elsewhere.
  });

  // Operator may call server to create viewer session and upload to IMGBB
  socket.on('create_viewer_session', async ({ photos = [], storiesMontage = null, session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    const viewerId = uuidv4();
    sessions[sid].viewerSessions[viewerId] = { createdAt: Date.now(), urls: [], storiesUrl: null };

    try {
      // If IMGBB_KEY set and photos provided, upload them
      if (IMGBB_KEY && Array.isArray(photos) && photos.length) {
        const uploaded = [];
        for (let i = 0; i < photos.length; i++) {
          const data = photos[i].replace(/^data:image\/\w+;base64,/, '');
          const form = new FormData();
          form.append('key', IMGBB_KEY);
          form.append('image', data);
          // optional name
          form.append('name', `viewer_${viewerId}_${i}`);
          const res = await fetch('https://api.imgbb.com/1/upload', {
            method: 'POST',
            body: form
          });
          const json = await res.json();
          if (json && json.success && json.data && json.data.url) {
            uploaded.push(json.data.url);
          }
        }
        sessions[sid].viewerSessions[viewerId].urls = uploaded;
      }

      // Upload storiesMontage if provided
      if (IMGBB_KEY && storiesMontage) {
        const form = new FormData();
        form.append('key', IMGBB_KEY);
        form.append('image', storiesMontage.replace(/^data:image\/\w+;base64,/, ''));
        const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
        const j = await r.json();
        if (j && j.success && j.data && j.data.url) {
          sessions[sid].viewerSessions[viewerId].storiesUrl = j.data.url;
        }
      }
    } catch (err) {
      console.error('Erro upload imgbb:', err && err.message ? err.message : err);
    }

    // Emit event to operators and viewers (operators may want to show QR)
    io.in(`${sid}:operators`).emit('viewer_session_created', { viewerId, session: sid });
    // We don't know which viewer requested; if create_viewer_session included viewerId param we might emit to that viewer too.
    console.log(`[SESSION ${sid}] viewer_session_created: ${viewerId}`);
  });

  // reset session (operator)
  socket.on('reset_session', ({ session } = {}) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    sessions[sid].lastFrame = null;
    sessions[sid].lastFrameTs = 0;
    // notify participants
    io.in(`${sid}:operators`).emit('reset_session', { session: sid });
    io.in(`${sid}:viewers`).emit('reset_session', { session: sid });
    console.log(`[SESSION ${sid}] reset by ${socket.id}`);
  });

  socket.on('disconnect', () => {
    const sid = socket.data.session || FIXED_SESSION;
    if (sessions[sid]) {
      sessions[sid].operators.delete(socket.id);
      sessions[sid].viewers.delete(socket.id);
      delete sessions[sid].viewerMeta[socket.id];
      io.in(`${sid}:operators`).emit('peer_left', { id: socket.id, role: socket.data.role, session: sid });
      io.in(`${sid}:viewers`).emit('peer_left', { id: socket.id, role: socket.data.role, session: sid });
      io.in(`${sid}:operators`).emit('viewer_count', {
        viewers: sessions[sid].viewers.size,
        operators: sessions[sid].operators.size
      });
      io.in(`${sid}:viewers`).emit('viewer_count', {
        viewers: sessions[sid].viewers.size,
        operators: sessions[sid].operators.size
      });
    }
    console.log('[SOCKET] desconectado', socket.id);
  });

});

// ------------------------
// HTTP endpoints (preserve originals + utilities)
// ------------------------

// Health check
app.get('/health', (req, res) => {
  const info = {};
  for (const sid in sessions) {
    info[sid] = {
      operators: sessions[sid].operators.size,
      viewers: sessions[sid].viewers.size,
      hasFrame: !!sessions[sid].lastFrame
    };
  }
  res.json({ ok: true, sessions: info });
});

// upload to imgbb endpoint (same as original)
app.post('/upload-imgbb', async (req, res) => {
  try {
    const { image, key } = req.body;
    if (!image) return res.status(400).json({ ok:false, error:'no image' });
    const form = new FormData();
    form.append('key', key || IMGBB_KEY || '');
    form.append('image', image);
    const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const j = await r.json();
    res.json(j);
  } catch (err) {
    console.error('imgbb upload error', err);
    res.status(500).json({ ok:false, error: err.message || String(err) });
  }
});

// montagem placeholder (keep original behavior)
app.post('/montagem', async (req, res) => {
  try {
    const { photos } = req.body;
    if (!Array.isArray(photos)) return res.status(400).json({ ok:false, error: 'no photos' });
    // save photos to tmp for debugging/processing
    const outFiles = [];
    for (let i = 0; i < photos.length; i++) {
      const data = photos[i].replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(data, 'base64');
      const fn = path.join(TMP_DIR, `photo_${Date.now()}_${i}.jpg`);
      await fs.writeFile(fn, buf);
      outFiles.push(fn);
    }
    res.json({ ok:true, files: outFiles });
  } catch (err) {
    console.error('montagem error', err);
    res.status(500).json({ ok:false, error: err.message || String(err) });
  }
});

// fallback root (serve index in public)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------
// Start server
// ------------------------
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} — sessão fixa: ${FIXED_SESSION}`);
  if (!IMGBB_KEY) console.log('⚠️ IMGBB_KEY não configurada — upload IMGBB desabilitado até configurar a variável de ambiente.');
});
