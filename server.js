/**
 * server.js — CABINE FOTOGRÁFICA (COMPLETO, atualizado para viewer sessions)
 *
 * - Serve public/ estático
 * - Socket.IO para comunicação operador / celular / visualizador
 * - Gera viewer sessions (viewerId) para links únicos do visualizador: /visualizador/:viewerId
 * - Endpoint /api/viewer/:viewerId para visualizador buscar fotos/montagem
 * - Upload para IMGBB quando IMGBB_KEY configurada; fallback grava em /uploads e serve via /uploads
 *
 * Atenção: mantenha IMGBB_KEY em env se quiser upload para imgbb.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling'],
});

const BASE_URL = process.env.BASE_URL || 'https://festadodavi-production-0591.up.railway.app';
const IMGBB_KEY = process.env.IMGBB_KEY || ''; // configure em env se desejar
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(PUBLIC_DIR);

app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true, limit: '120mb' }));

// serve public
app.use(express.static(PUBLIC_DIR));

// expos /uploads como fallback público (arquivos temporários)
app.use('/uploads', express.static(UPLOADS_DIR));

// simples logger
app.use((req,res,next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// util: upload base64 to imgbb
async function uploadBase64ToImgbb(base64OrDataUrl, name = 'cabine_asset') {
  if (!IMGBB_KEY) {
    console.warn('IMGBB_KEY não configurada — pulando upload para imgbb');
    return null;
  }
  try {
    let raw = base64OrDataUrl;
    if (raw.startsWith('data:')) raw = raw.split(',')[1];
    const params = new URLSearchParams();
    params.append('key', IMGBB_KEY);
    params.append('image', raw);
    params.append('name', name);
    const res = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxBodyLength: Infinity,
      timeout: 30000,
    });
    if (res.data && res.data.success && res.data.data) {
      return res.data.data.display_url || res.data.data.url || null;
    }
    console.warn('IMGBB resposta inesperada', res.data);
    return null;
  } catch (err) {
    console.error('Erro upload IMGBB:', err.response ? err.response.data : err.message || err);
    return null;
  }
}

/**
 * sessions = {
 *   sessionId: {
 *     createdAt,
 *     operatorSocketId,
 *     viewers: [ socketId ],
 *     photos: [url...],
 *     boomerang: { url, uploadedAt } | null,
 *     lastRawPhotos: [dataURL...],
 *     viewerSessions: { viewerId: { createdAt, photos, storiesMontageUrl, printUrl, rawStoriesDataUrl?, rawPrintDataUrl? } }
 *   }
 * }
 */
const sessions = {};

function ensureSession(sessionId) {
  if (!sessionId) sessionId = 'cabine-fixa';
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      createdAt: new Date().toISOString(),
      operatorSocketId: null,
      viewers: [],
      photos: [],
      boomerang: null,
      lastRawPhotos: [],
      viewerSessions: {}, // viewerId => data
    };
  }
  return sessions[sessionId];
}

// health
app.get('/health', (req,res) => {
  res.json({ ok:true, uptime: process.uptime(), sessions: Object.keys(sessions).length });
});

// serve visualizador html file for viewerId (static file) — visualizador.html must be in public
app.get('/visualizador/:viewerId', (req,res) => {
  const viewerId = req.params.viewerId;
  // If the file exists, serve it; visualizador.html will call /api/viewer/:viewerId
  const filePath = path.join(PUBLIC_DIR, 'visualizador.html');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('<h2>visualizador.html não encontrado no public</h2>');
  }
  return res.sendFile(filePath);
});

// API for visualizador front-end to fetch viewer payload
app.get('/api/viewer/:viewerId', (req,res) => {
  const viewerId = req.params.viewerId;
  // find viewer in all sessions
  let found=null;
  Object.keys(sessions).forEach(sid => {
    const s = sessions[sid];
    if (s && s.viewerSessions && s.viewerSessions[viewerId]) {
      found = { sessionId: sid, data: s.viewerSessions[viewerId] };
    }
  });
  if (!found) return res.status(404).json({ ok:false, error: 'viewer_not_found' });
  const payload = {
    ok: true,
    viewerId,
    session: found.sessionId,
    photos: found.data.photos || [],
    storiesMontage: found.data.storiesMontageUrl || null,
    print: found.data.printUrl || null,
    createdAt: found.data.createdAt || null,
  };
  return res.json(payload);
});

// optional upload debug route
const uploadMiddleware = multer({ dest: UPLOADS_DIR });
app.post('/upload-debug', uploadMiddleware.single('file'), async (req,res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file' });
    const buffer = await fs.readFile(file.path);
    const base64 = buffer.toString('base64');
    const url = await uploadBase64ToImgbb(base64);
    return res.json({ ok:true, url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, err: String(err) });
  }
});

// Socket handlers
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join_session', ({ session, role }) => {
    const sid = session || 'cabine-fixa';
    socket.join(sid);
    const s = ensureSession(sid);
    if (role === 'operator') {
      s.operatorSocketId = socket.id;
      console.log(`[${sid}] operator joined: ${socket.id}`);
    } else {
      if (!s.viewers.includes(socket.id)) s.viewers.push(socket.id);
      console.log(`[${sid}] viewer joined: ${socket.id}`);
    }
    // send basic state
    socket.emit('session_state', {
      session: sid,
      photosCount: s.photos.length,
      hasBoomerang: !!s.boomerang,
      preview: { photos: s.photos, boomerang: s.boomerang && s.boomerang.url ? s.boomerang.url : null },
      baseUrl: BASE_URL,
    });
  });

  // photos_from_cell: raw dataURLs array
  socket.on('photos_from_cell', async (payload, ack) => {
    try {
      const session = payload.session || 'cabine-fixa';
      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      console.log(`[${session}] photos_from_cell received. Count: ${photos.length}`);
      const s = ensureSession(session);
      s.lastRawPhotos = photos.slice(0,10);

      // Try to upload each to IMGBB (if IMGBB_KEY set). If not available, store fallback in uploads.
      const uploaded = [];
      for (let i=0;i<photos.length;i++){
        const p = photos[i];
        let url = null;
        if (IMGBB_KEY) {
          url = await uploadBase64ToImgbb(p, `cabine_${session}_${Date.now()}_${i}`);
        }
        if (!url) {
          // store locally
          const buf = Buffer.from(p.split(',')[1], 'base64');
          const filename = `${uuidv4()}_photo_${i}.jpg`;
          const filePath = path.join(UPLOADS_DIR, filename);
          await fs.writeFile(filePath, buf);
          url = `${BASE_URL}/uploads/${filename}`;
        }
        uploaded.push(url);
      }

      if (uploaded.length) {
        s.photos = uploaded;
      }

      const visualizadorUrl = `${BASE_URL}/visualizador/session/${encodeURIComponent(session)}`; // session-level visualizador (legacy)
      // notify all in the session
      io.to(session).emit('photos_ready', { session, uploaded, visualizadorUrl });
      // ack if provided
      if (ack && typeof ack === 'function') ack({ ok:true, uploaded, visualizadorUrl });
      console.log(`[${session}] photos processed and emitted (uploaded: ${uploaded.length})`);
    } catch (err) {
      console.error('Error photos_from_cell:', err);
      if (ack && typeof ack === 'function') ack({ ok:false, error: String(err) });
      socket.emit('error_msg', { message: 'Erro ao processar fotos' });
    }
  });

  // boomerang_ready: accept data or url
  socket.on('boomerang_ready', async (payload, ack) => {
    try {
      const session = (payload && payload.session) ? payload.session : 'cabine-fixa';
      console.log(`[${session}] boomerang_ready received (socket: ${socket.id})`);
      let buffer = null;
      if (payload.data) {
        if (Buffer.isBuffer(payload.data)) buffer = payload.data;
        else if (payload.data instanceof ArrayBuffer) buffer = Buffer.from(payload.data);
        else if (payload.data.data && Array.isArray(payload.data.data)) buffer = Buffer.from(payload.data.data);
        else if (typeof payload.data === 'string' && payload.data.startsWith('data:')) {
          const b64 = payload.data.split(',')[1];
          buffer = Buffer.from(b64, 'base64');
        } else if (typeof payload.data === 'string') {
          try { buffer = Buffer.from(payload.data, 'base64'); } catch(e){ buffer=null; }
        }
      }
      if (!buffer && payload.base64) buffer = Buffer.from(payload.base64, 'base64');
      if (!buffer && payload.raw && typeof payload.raw === 'string' && payload.raw.indexOf('base64')>-1) {
        buffer = Buffer.from(payload.raw.split(',')[1], 'base64');
      }

      let uploadedUrl = null;
      let tempPath = null;
      if (buffer) {
        const fileName = payload.filename || `boomerang_${Date.now()}.webm`;
        tempPath = path.join(UPLOADS_DIR, `${uuidv4()}_${fileName}`);
        await fs.writeFile(tempPath, buffer);
        // try upload to IMGBB (video may fail)
        if (IMGBB_KEY) {
          try {
            const b64 = buffer.toString('base64');
            uploadedUrl = await uploadBase64ToImgbb(`data:video/webm;base64,${b64}`, `boomerang_${session}_${Date.now()}`);
          } catch(e){ uploadedUrl = null; }
        }
        if (!uploadedUrl) {
          uploadedUrl = `${BASE_URL}/uploads/${path.basename(tempPath)}`;
        }
      } else if (payload.videoUrl || payload.url) {
        uploadedUrl = payload.videoUrl || payload.url;
      }

      const s = ensureSession(session);
      s.boomerang = { url: uploadedUrl, uploadedAt: new Date().toISOString() };

      const visualizadorUrl = `${BASE_URL}/visualizador/session/${encodeURIComponent(session)}`;

      io.to(session).emit('boomerang_ready', { session, videoUrl: uploadedUrl, visualizadorUrl });
      if (ack && typeof ack === 'function') ack({ ok:true, url: uploadedUrl, visualizadorUrl });

      console.log(`[${session}] Boomerang processed: ${uploadedUrl}`);

      // cleanup temp file later
      if (tempPath) {
        setTimeout(()=>{ fs.remove(tempPath).catch(()=>{}); }, 30*1000);
      }
    } catch (err) {
      console.error('Erro boomerang_ready:', err);
      if (ack && typeof ack === 'function') ack({ ok:false, error: String(err) });
      socket.emit('error_msg', { message: 'Erro ao processar boomerang' });
    }
  });

  /**
   * create_viewer_session
   * payload: { session, photos: [dataURL or url...], storiesMontage: dataURL?, print: dataURL? }
   * callback ack: (resp) => {}
   *
   * Server will:
   *  - generate viewerId
   *  - store the payload under sessions[session].viewerSessions[viewerId]
   *  - if storiesMontage/print are dataURLs, try upload to IMGBB (if configured) or save to /uploads
   *  - reply to operator via callback { ok:true, viewerId, visualizadorUrl }
   *  - emit 'viewer_session_created' to operator UI
   */
  socket.on('create_viewer_session', async (payload, cb) => {
    try {
      const session = (payload && payload.session) ? payload.session : 'cabine-fixa';
      const s = ensureSession(session);
      const viewerId = uuidv4();
      const entry = { createdAt: new Date().toISOString(), photos: [], storiesMontageUrl: null, printUrl: null };

      // photos: can be urls or dataURLs
      if (Array.isArray(payload.photos) && payload.photos.length) {
        // if they're dataURLs, try to upload each to IMGBB if IMGBB_KEY set, otherwise store in uploads
        const photos = [];
        for (let i=0;i<payload.photos.length;i++){
          const p = payload.photos[i];
          let url = null;
          if (typeof p === 'string' && p.startsWith('data:')) {
            if (IMGBB_KEY) {
              url = await uploadBase64ToImgbb(p, `viewer_${viewerId}_photo_${i}`);
            }
            if (!url) {
              const buf = Buffer.from(p.split(',')[1], 'base64');
              const filename = `${uuidv4()}_viewer_${viewerId}_photo_${i}.jpg`;
              const filePath = path.join(UPLOADS_DIR, filename);
              await fs.writeFile(filePath, buf);
              url = `${BASE_URL}/uploads/${filename}`;
            }
          } else if (typeof p === 'string') {
            url = p;
          }
          if (url) photos.push(url);
        }
        entry.photos = photos;
      }

      // storiesMontage (dataURL likely) => upload or save
      if (payload.storiesMontage) {
        const sdata = payload.storiesMontage;
        let url = null;
        if (typeof sdata === 'string' && sdata.startsWith('data:')) {
          if (IMGBB_KEY) {
            url = await uploadBase64ToImgbb(sdata, `viewer_${viewerId}_stories`);
          }
          if (!url) {
            const buf = Buffer.from(sdata.split(',')[1], 'base64');
            const filename = `${uuidv4()}_viewer_${viewerId}_stories.jpg`;
            const filePath = path.join(UPLOADS_DIR, filename);
            await fs.writeFile(filePath, buf);
            url = `${BASE_URL}/uploads/${filename}`;
          }
        } else if (typeof sdata === 'string') {
          url = sdata;
        }
        entry.storiesMontageUrl = url;
      }

      // print
      if (payload.print) {
        const pdata = payload.print;
        let url = null;
        if (typeof pdata === 'string' && pdata.startsWith('data:')) {
          if (IMGBB_KEY) {
            url = await uploadBase64ToImgbb(pdata, `viewer_${viewerId}_print`);
          }
          if (!url) {
            const buf = Buffer.from(pdata.split(',')[1], 'base64');
            const filename = `${uuidv4()}_viewer_${viewerId}_print.jpg`;
            const filePath = path.join(UPLOADS_DIR, filename);
            await fs.writeFile(filePath, buf);
            url = `${BASE_URL}/uploads/${filename}`;
          }
        } else if (typeof pdata === 'string') {
          url = pdata;
        }
        entry.printUrl = url;
      }

      // store
      s.viewerSessions[viewerId] = entry;

      const visualizadorUrl = `${BASE_URL}/visualizador/${viewerId}`;

      // inform operator and return ack
      io.to(session).emit('viewer_session_created', { viewerId, visualizadorUrl });
      if (cb && typeof cb === 'function') cb({ ok:true, viewerId, visualizadorUrl });

      console.log(`[${session}] viewer session created: ${viewerId} (visualizador: ${visualizadorUrl})`);
    } catch (err) {
      console.error('Erro create_viewer_session:', err);
      if (cb && typeof cb === 'function') cb({ ok:false, error: String(err) });
    }
  });

  // reset session
  socket.on('reset_session', ({ session }) => {
    const sid = session || 'cabine-fixa';
    delete sessions[sid];
    io.to(sid).emit('reset_session', { session: sid });
    console.log(`Sessão ${sid} resetada por socket ${socket.id}`);
  });

  socket.on('ping_server', (cb) => {
    if (cb && typeof cb === 'function') cb({ ok:true, time: Date.now() });
  });

  socket.on('disconnect', () => {
    try {
      Object.keys(sessions).forEach((sid) => {
        const s = sessions[sid];
        if (!s) return;
        if (s.operatorSocketId === socket.id) s.operatorSocketId = null;
        const idx = s.viewers.indexOf(socket.id);
        if (idx >= 0) s.viewers.splice(idx, 1);
      });
    } catch (e) {}
    console.log('Socket disconnected:', socket.id);
  });
});

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} — BASE_URL=${BASE_URL}`);
  console.log(`Uploads temporários em ${UPLOADS_DIR}`);
});
