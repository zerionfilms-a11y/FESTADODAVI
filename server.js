// server.js — completo (compatível Node 18+/25). Mantive toda a lógica original e adicionei
// stream_frame caching, request_stream etc. Fallbacks para fetch/uuid quando libs faltarem.
//
// Substitua o arquivo existente pelo conteúdo abaixo.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const FormData = require('form-data');
const { Server } = require('socket.io');

// fallback uuid: tenta require('uuid') senão usa crypto.randomUUID() ou timestamp-based
let uuidv4;
try {
  uuidv4 = require('uuid').v4;
} catch (e) {
  const crypto = require('crypto');
  if (crypto && typeof crypto.randomUUID === 'function') {
    uuidv4 = () => crypto.randomUUID();
  } else {
    uuidv4 = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
  }
}

// fallback fetch: use global fetch when disponível, senão dynamic import node-fetch
const fetch = (globalThis && globalThis.fetch)
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ["*"], methods: ["GET","POST"] }
});

// CONFIG
const PORT = process.env.PORT || 3000;
const FIXED_SESSION = process.env.FIXED_SESSION || 'cabine-fixa';
const TMP_DIR = path.join(__dirname, 'tmp');
fs.ensureDirSync(TMP_DIR);
const IMGBB_KEY = process.env.IMGBB_KEY || null;

// body parsers
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/*
 sessions structure:
 sessions[sessionId] = {
   operators: Set(socketId),
   viewers: Set(socketId),
   viewerMeta: { socketId: {...} },
   lastFrame: 'data:image/jpeg;base64,...',
   lastFrameTs: <ms>,
   viewerSessions: { viewerId: { urls:[], storiesUrl:..., createdAt } }
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

// throttle config: ms min between broadcasts (allow up to 60 FPS)
const MIN_FRAME_INTERVAL_MS = 1000 / 60;

// ----------------- SOCKET.IO -----------------
io.on('connection', (socket) => {
  console.log('[SOCKET] connected', socket.id);

  socket.on('join_session', ({ session, role }) => {
    const sid = session || FIXED_SESSION;
    ensureSession(sid);
    socket.data.session = sid;
    socket.data.role = role || 'viewer';

    if (socket.data.role === 'operator') {
      sessions[sid].operators.add(socket.id);
      socket.join(`${sid}:operators`);
      console.log(`[${sid}] operator joined: ${socket.id}`);
      // send cached frame to operator (optional)
      if (sessions[sid].lastFrame) socket.emit('stream_frame', { session: sid, frame: sessions[sid].lastFrame });
    } else {
      sessions[sid].viewers.add(socket.id);
      socket.join(`${sid}:viewers`);
      sessions[sid].viewerMeta[socket.id] = { connectedAt: Date.now() };
      console.log(`[${sid}] viewer joined: ${socket.id}`);
      io.in(`${sid}:operators`).emit('peer_joined', { id: socket.id, role: 'viewer', session: sid });
      // send lastFrame if exist
      if (sessions[sid].lastFrame) socket.emit('stream_frame', { session: sid, frame: sessions[sid].lastFrame });
      else socket.emit('stream_pending', { session: sid });
    }

    // counts
    io.in(`${sid}:operators`).emit('viewer_count', {
      viewers: sessions[sid].viewers.size,
      operators: sessions[sid].operators.size
    });
    io.in(`${sid}:viewers`).emit('viewer_count', {
      viewers: sessions[sid].viewers.size,
      operators: sessions[sid].operators.size
    });
  });

  socket.on('request_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // notify operators to start sending frames
    io.in(`${sid}:operators`).emit('want_stream', { session: sid, viewerId: socket.id });
    const last = sessions[sid].lastFrame;
    if (last) socket.emit('stream_frame', { session: sid, frame: last });
    else socket.emit('stream_pending', { session: sid });
  });

  // operator sends preview frames (low-res)
  socket.on('stream_frame', ({ session, frame }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    const now = Date.now();
    const elapsed = now - (sessions[sid].lastFrameTs || 0);
    if (elapsed >= MIN_FRAME_INTERVAL_MS) {
      sessions[sid].lastFrame = frame;
      sessions[sid].lastFrameTs = now;
      io.in(`${sid}:viewers`).emit('stream_frame', { session: sid, frame });
    } else {
      // if too frequent, update cache but don't broadcast to avoid flood
      sessions[sid].lastFrame = frame;
    }
  });

  socket.on('stop_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(`${sid}:viewers`).emit('stream_stopped', { session: sid });
    console.log(`[${sid}] stop_stream by ${socket.id}`);
  });

  // viewer asks operator to take photo (operator will capture)
  socket.on('take_photo', ({ session, index, viewerId }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(`${sid}:operators`).emit('take_photo', { session: sid, index, viewerId });
  });

  socket.on('photo_ready', ({ session, index, viewerId, photo, mirror }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    if (viewerId) {
      io.to(viewerId).emit('photo_ready', { index, photo, mirror });
    } else {
      io.in(`${sid}:viewers`).emit('photo_ready', { index, photo, mirror });
    }
  });

  // viewer submits final photos
  socket.on('photos_submit', ({ session, viewerId, photos }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    console.log(`[${sid}] photos_submit from ${viewerId} (${photos.length})`);
    io.in(`${sid}:operators`).emit('photos_submit', { viewerId, photos, session: sid });
    // ack viewer
    io.to(viewerId).emit('photos_received', { status: 'ok' });
  });

  // operator requests server to create viewer session + upload to imgbb
  socket.on('create_viewer_session', async ({ photos = [], storiesMontage = null, session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    const viewerId = uuidv4();
    sessions[sid].viewerSessions[viewerId] = { createdAt: Date.now(), urls: [], storiesUrl: null };
    try {
      if (IMGBB_KEY && Array.isArray(photos) && photos.length) {
        const uploaded = [];
        for (let i = 0; i < photos.length; i++) {
          const data = photos[i].replace(/^data:image\/\w+;base64,/, '');
          const form = new FormData();
          form.append('key', IMGBB_KEY);
          form.append('image', data);
          form.append('name', `viewer_${viewerId}_${i}`);
          const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
          const json = await res.json();
          if (json && json.success && json.data && json.data.url) uploaded.push(json.data.url);
        }
        sessions[sid].viewerSessions[viewerId].urls = uploaded;
      }

      if (IMGBB_KEY && storiesMontage) {
        const form = new FormData();
        form.append('key', IMGBB_KEY);
        form.append('image', storiesMontage.replace(/^data:image\/\w+;base64,/, ''));
        const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
        const j = await r.json();
        if (j && j.success && j.data && j.data.url) sessions[sid].viewerSessions[viewerId].storiesUrl = j.data.url;
      }
    } catch (err) {
      console.error('Erro upload imgbb:', err && err.message ? err.message : err);
    }

    io.in(`${sid}:operators`).emit('viewer_session_created', { viewerId, session: sid });
    console.log(`[${sid}] viewer_session_created ${viewerId}`);
  });

  socket.on('reset_session', ({ session } = {}) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    sessions[sid].lastFrame = null;
    sessions[sid].lastFrameTs = 0;
    io.in(`${sid}:operators`).emit('reset_session', { session: sid });
    io.in(`${sid}:viewers`).emit('reset_session', { session: sid });
    console.log(`[${sid}] reset by ${socket.id}`);
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
    console.log('[SOCKET] disconnected', socket.id);
  });
});

// ----------------- HTTP endpoints -----------------
app.get('/health', (req, res) => {
  const info = {};
  for (const sid in sessions) {
    info[sid] = {
      operators: sessions[sid].operators.size,
      viewers: sessions[sid].viewers.size,
      hasFrame: !!sessions[sid].lastFrame
    };
  }
  res.json({ ok:true, sessions: info });
});

app.post('/upload-imgbb', async (req, res) => {
  try {
    const { image, key } = req.body;
    if (!image) return res.status(400).json({ ok:false, error:'no image' });
    const form = new FormData();
    form.append('key', key || IMGBB_KEY || '');
    form.append('image', image);
    const r = await fetch('https://api.imgbb.com/1/upload', { method:'POST', body: form });
    const j = await r.json();
    res.json(j);
  } catch (err) {
    console.error('imgbb upload error', err);
    res.status(500).json({ ok:false, error: err.message || String(err) });
  }
});

app.post('/montagem', async (req, res) => {
  try {
    const { photos } = req.body;
    if (!Array.isArray(photos)) return res.status(400).json({ ok:false, error:'no photos' });
    const outFiles = [];
    for (let i=0;i<photos.length;i++){
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} — sessão fixa: ${FIXED_SESSION}`);
  if (!IMGBB_KEY) console.log('⚠️ IMGBB_KEY não configurada — upload IMGBB desabilitado.');
});
