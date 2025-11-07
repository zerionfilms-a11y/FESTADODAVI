/**
 * server.js — CabINE FOTOGRÁFICA (completo)
 *
 * Recursos:
 *  - Express + Socket.IO
 *  - Recebe fotos do celular (dataURLs) e faz upload para IMGBB (se configurado)
 *  - Recebe boomerang (ArrayBuffer / base64 / Buffer) via Socket.IO e tenta upload para IMGBB
 *  - Mantém sessões em memória (photos, boomerang, viewers, operator)
 *  - Emite 'photos_ready', 'boomerang_ready', 'visualizer_ready' para sessão assim que processado
 *  - Emite 'finalize_session' quando a sessão for finalizada (operator)
 *  - Rotas: /health, /sessions, /visualizador/:session, /upload-debug
 *
 * Dependências (instale previamente):
 *   npm i express socket.io multer axios fs-extra uuid qrcode cors
 *
 * Observações:
 *  - IMGBB não é ideal para vídeos (usado por compatibilidade); para produção use Cloudinary/S3.
 *  - Sessions são em memória (reinício limpa). Para persistência, adicione DB.
 *  - Ajuste BASE_URL/IMGBB_KEY via env vars.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// --- Configs (use env vars in produção) ---
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL && process.env.BASE_URL.startsWith('http')) ? process.env.BASE_URL : (process.env.BASE_URL ? `https://${process.env.BASE_URL}` : `http://localhost:${PORT}`);
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // configure sua chave IMGBB aqui ou via env
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads_temp');

// ensure dirs
fs.ensureDirSync(PUBLIC_DIR);
fs.ensureDirSync(UPLOADS_DIR);

// middlewares
app.use(cors());
app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true, limit: '120mb' }));
app.use(express.static(PUBLIC_DIR));

// simple request log
app.use((req, res, next) => {
  console.log(`[HTTP] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

/* ======================================================
  Util: uploadBase64ToImgbb
  - recebe base64 ou dataURL (data:*;base64,AAAA...)
  - retorna display_url ou null
====================================================== */
async function uploadBase64ToImgbb(base64OrDataUrl, name = 'cabine_asset') {
  if (!IMGBB_KEY) {
    console.warn('[IMGBB] IMGBB_KEY não configurada — pulando upload.');
    return null;
  }

  try {
    let raw = base64OrDataUrl;
    if (typeof raw !== 'string') return null;
    if (raw.startsWith('data:')) raw = raw.split(',')[1];

    const params = new URLSearchParams();
    params.append('key', IMGBB_KEY);
    params.append('image', raw);
    params.append('name', name);

    const res = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 40000,
      maxBodyLength: Infinity,
    });

    if (res.data && res.data.success && res.data.data) {
      // prefer display_url
      return res.data.data.display_url || res.data.data.url || null;
    } else {
      console.warn('[IMGBB] resposta inesperada', res.data && res.data.status);
      return null;
    }
  } catch (err) {
    console.error('[IMGBB] erro upload:', err.response ? err.response.data : err.message || err);
    return null;
  }
}

/* ======================================================
  Sessions em memória
  Estrutura:
  sessions = {
    sessionId: {
      createdAt,
      operatorSocketId,
      viewers: [],
      photos: [url, ...],
      boomerang: { url, uploadedAt } | null,
      lastRawPhotos: [dataURL,...]
    }
  }
====================================================== */
const sessions = {};

function ensureSession(sessionId) {
  const sid = sessionId || 'cabine-fixa';
  if (!sessions[sid]) {
    sessions[sid] = {
      createdAt: new Date().toISOString(),
      operatorSocketId: null,
      viewers: [],
      photos: [],
      boomerang: null,
      lastRawPhotos: [],
    };
  }
  return sessions[sid];
}

/* ======================================================
  Rotas HTTP úteis
====================================================== */

// health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: Object.keys(sessions).length });
});

// sessions list (admin)
app.get('/sessions', (req, res) => {
  const list = Object.keys(sessions).map((id) => {
    const s = sessions[id];
    return {
      session: id,
      createdAt: s.createdAt,
      photosCount: s.photos.length,
      hasBoomerang: !!s.boomerang,
      viewers: s.viewers.length,
      operator: s.operatorSocketId || null,
    };
  });
  res.json(list);
});

// visualizador simples (server-side) — ex: BASE_URL/visualizador/sessao123
app.get('/visualizador/:session', (req, res) => {
  const sid = req.params.session;
  const s = sessions[sid];
  if (!s) {
    return res.status(404).send(`<html><body><h2>Visualizador: sessão ${sid} não encontrada</h2></body></html>`);
  }

  let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visualizador - ${sid}</title></head><body style="background:#111;color:#fff;font-family:Arial;padding:12px">`;
  html += `<h2>Visualizador — Sessão ${sid}</h2>`;

  if (s.photos && s.photos.length) {
    html += `<h3>Fotos (${s.photos.length})</h3><div style="display:flex;gap:10px;flex-wrap:wrap">`;
    s.photos.forEach((url) => {
      html += `<div style="width:200px"><img src="${url}" style="width:100%;height:auto;border-radius:8px"/></div>`;
    });
    html += `</div>`;
  }

  if (s.boomerang && s.boomerang.url) {
    html += `<h3>Boomerang</h3>`;
    html += `<video controls playsinline loop style="width:100%;max-width:480px;border-radius:8px"><source src="${s.boomerang.url}"></video>`;
  }

  html += `<p style="opacity:0.6;margin-top:12px">Sessão criada em ${s.createdAt}</p>`;
  html += `</body></html>`;
  res.send(html);
});

// upload debug (manual file upload -> imgbb)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });
app.post('/upload-debug', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'no file' });
    const buffer = await fs.readFile(file.path);
    const base64 = buffer.toString('base64');
    const url = await uploadBase64ToImgbb(base64);
    return res.json({ ok: true, url, path: file.path });
  } catch (err) {
    console.error('upload-debug error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ======================================================
  Socket.IO
====================================================== */
io.on('connection', (socket) => {
  console.log('[SOCKET] conectou', socket.id);

  // join session
  socket.on('join_session', ({ session, role } = {}) => {
    const sid = session || 'cabine-fixa';
    socket.join(sid);
    const s = ensureSession(sid);

    if (role === 'operator') {
      s.operatorSocketId = socket.id;
      console.log(`[${sid}] operador conectado: ${socket.id}`);
    } else {
      if (!s.viewers.includes(socket.id)) s.viewers.push(socket.id);
      console.log(`[${sid}] viewer conectado: ${socket.id}`);
    }

    // send current session state
    socket.emit('session_state', {
      session: sid,
      photosCount: s.photos.length,
      hasBoomerang: !!s.boomerang,
      preview: { photos: s.photos, boomerang: s.boomerang?.url || null },
      baseUrl: BASE_URL,
    });
  });

  /* ------------------------------
     Photos from cell
     payload: { session, photos: [dataURL,...], viewerId? }
     ------------------------------ */
  socket.on('photos_from_cell', async (payload = {}) => {
    try {
      const sid = payload.session || 'cabine-fixa';
      const s = ensureSession(sid);
      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      console.log(`[${sid}] photos_from_cell received: ${photos.length} fotos (socket: ${socket.id})`);

      // store raw for debugging
      s.lastRawPhotos = photos.slice(0, 10);

      // try to upload each to IMGBB
      const uploadedUrls = [];
      for (let i = 0; i < photos.length; i++) {
        const data = photos[i];
        if (!data) continue;
        // small throttle for safety
        // eslint-disable-next-line no-await-in-loop
        const url = await uploadBase64ToImgbb(data, `cabine_${sid}_${Date.now()}_${i}`);
        if (url) uploadedUrls.push(url);
      }

      // if uploaded, replace session photos
      if (uploadedUrls.length > 0) {
        s.photos = uploadedUrls;
      } else {
        // if not uploaded, optionally save the dataURL as file and serve via /uploads (fallback)
        // we will save each dataURL into a file and provide a local URL (only if IMGBB failed)
        const fallbackUrls = [];
        for (let i = 0; i < Math.min(photos.length, 10); i++) {
          const p = photos[i];
          if (!p) continue;
          let base64 = p;
          if (p.startsWith('data:')) base64 = p.split(',')[1];
          const buf = Buffer.from(base64, 'base64');
          const filename = `${Date.now()}_${uuidv4()}_${i}.jpg`;
          const outPath = path.join(UPLOADS_DIR, filename);
          // eslint-disable-next-line no-await-in-loop
          await fs.writeFile(outPath, buf);
          fallbackUrls.push(`${BASE_URL}/uploads/${filename}`);
        }
        if (fallbackUrls.length) {
          // ensure /uploads route
          app.use('/uploads', express.static(UPLOADS_DIR));
          s.photos = fallbackUrls;
        }
      }

      // build visualizador URL and QR
      const visualizadorUrl = `${BASE_URL.replace(/\/$/, '')}/visualizador/${encodeURIComponent(sid)}`;
      const qrDataUrl = await QRCode.toDataURL(visualizadorUrl).catch(() => null);

      // emit to operator/index and viewers that photos are ready
      io.to(sid).emit('photos_ready', {
        session: sid,
        uploaded: s.photos,
        visualizadorUrl,
      });

      // NEW: emit visualizer_ready, with QR so cell can show instantly and lock until finalize
      io.to(sid).emit('visualizer_ready', {
        session: sid,
        visualizadorUrl,
        qrDataUrl,
      });

      console.log(`[${sid}] photos processed. emitted photos_ready + visualizer_ready`);
    } catch (err) {
      console.error('photos_from_cell error:', err);
      socket.emit('error_msg', { message: 'Erro no servidor processando fotos' });
    }
  });

  /* ------------------------------
     Boomerang from cell
     payload: { session, filename, data: ArrayBuffer|Buffer|{data:[]}|dataURL|string(base64) }
     ------------------------------ */
  socket.on('boomerang_ready', async (payload = {}) => {
    try {
      const sid = payload.session || 'cabine-fixa';
      const s = ensureSession(sid);
      console.log(`[${sid}] boomerang_ready received (socket: ${socket.id})`);

      // normalize to Buffer
      let buffer = null;
      if (payload.data) {
        // Buffer
        if (Buffer.isBuffer(payload.data)) buffer = payload.data;
        // typed array object: { data: [...] }
        else if (payload.data.data && Array.isArray(payload.data.data)) buffer = Buffer.from(payload.data.data);
        // ArrayBuffer
        else if (payload.data instanceof ArrayBuffer) buffer = Buffer.from(payload.data);
        // base64/dataURL string
        else if (typeof payload.data === 'string') {
          if (payload.data.startsWith('data:')) {
            const b64 = payload.data.split(',')[1];
            buffer = Buffer.from(b64, 'base64');
          } else {
            // treat as raw base64 maybe
            try {
              buffer = Buffer.from(payload.data, 'base64');
            } catch (e) {
              buffer = null;
            }
          }
        }
      }
      // alternative fields
      if (!buffer && payload.base64) {
        buffer = Buffer.from(payload.base64, 'base64');
      }
      if (!buffer && payload.raw) {
        if (typeof payload.raw === 'string' && payload.raw.startsWith('data:')) {
          buffer = Buffer.from(payload.raw.split(',')[1], 'base64');
        }
      }

      if (!buffer) {
        socket.emit('error_msg', { message: 'Boomerang sem dados válidos' });
        console.warn('[boomerang_ready] sem buffer válido no payload');
        return;
      }

      // write temp file
      const filename = payload.filename || `boomerang_${Date.now()}.webm`;
      const tmpName = `${uuidv4()}_${filename}`;
      const tmpPath = path.join(UPLOADS_DIR, tmpName);
      await fs.writeFile(tmpPath, buffer);

      // try to upload to IMGBB (not guaranteed for video) — we attempt
      let uploadedUrl = null;
      try {
        uploadedUrl = await uploadBase64ToImgbb(`data:video/webm;base64,${buffer.toString('base64')}`, `boomerang_${sid}_${Date.now()}`);
      } catch (e) {
        console.warn('Tentativa de upload video IMGBB falhou', e && e.message);
      }

      // fallback: expose via /uploads
      if (!uploadedUrl) {
        app.use('/uploads', express.static(UPLOADS_DIR));
        uploadedUrl = `${BASE_URL.replace(/\/$/, '')}/uploads/${tmpName}`;
        console.warn('[boomerang_ready] fallback: servindo boomerang via /uploads');
      }

      // update session
      s.boomerang = { url: uploadedUrl, uploadedAt: new Date().toISOString() };

      // build visualizador URL and QR
      const visualizadorUrl = `${BASE_URL.replace(/\/$/, '')}/visualizador/${encodeURIComponent(sid)}`;
      const qrDataUrl = await QRCode.toDataURL(visualizadorUrl).catch(() => null);

      // emit to session
      io.to(sid).emit('boomerang_ready', {
        session: sid,
        videoUrl: uploadedUrl,
        visualizadorUrl,
      });

      // NEW: visualizer_ready so cell can show QR and lock
      io.to(sid).emit('visualizer_ready', {
        session: sid,
        visualizadorUrl,
        qrDataUrl,
      });

      console.log(`[${sid}] boomerang processed: ${uploadedUrl}`);

      // schedule cleanup of tmp file (keep for short time)
      setTimeout(() => {
        fs.remove(tmpPath).catch(() => {});
      }, 60 * 1000);
    } catch (err) {
      console.error('boomerang_ready error:', err);
      socket.emit('error_msg', { message: 'Erro processando boomerang' });
    }
  });

  /* ------------------------------
     Operator: finalize/reset session
     payload: { session }
     When operator finalizes, we emit finalize_session to viewers
     ------------------------------ */
  socket.on('reset_session', ({ session } = {}) => {
    const sid = session || 'cabine-fixa';
    // delete session store (optional)
    delete sessions[sid];

    // emit finalize_session to viewers so they unblock and go to start screen
    io.to(sid).emit('finalize_session', { session: sid });
    // keep legacy event
    io.to(sid).emit('reset_session', { session: sid });

    console.log(`[${sid}] session reset/finalize triggered by ${socket.id}`);
  });

  socket.on('ping_server', (cb) => cb && cb({ ok: true, time: Date.now() }));

  socket.on('disconnect', () => {
    // remove from sessions viewer lists & operator id
    Object.entries(sessions).forEach(([sid, s]) => {
      if (s.operatorSocketId === socket.id) s.operatorSocketId = null;
      s.viewers = s.viewers.filter((id) => id !== socket.id);
    });
    console.log('[SOCKET] disconnect', socket.id);
  });
});

/* ======================================================
  Start server
====================================================== */
server.listen(PORT, () => {
  console.log(`\n=== CABINE SERVER ===`);
  console.log(`PORT: ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`IMGBB_KEY configured: ${!!IMGBB_KEY}`);
  console.log(`PUBLIC_DIR: ${PUBLIC_DIR}`);
  console.log(`UPLOADS_DIR (temp): ${UPLOADS_DIR}`);
  console.log(`=====================\n`);
});

/* ======================================================
  Recomendação final / checklist:
  - Coloque index.html, celular.html e visualizador.html dentro de ./public
  - Ajuste BASE_URL para o endereço público do servidor (HTTPS recomendado)
  - Configure IMGBB_KEY se quiser uploads para imgbb (opcional para imagens; vídeos podem falhar)
  - Considere trocar upload de vídeo para Cloudinary ou S3 para maior confiabilidade
  - Sessions estão em memória: para persistência use banco (Redis/Mongo/etc.)
====================================================== */
