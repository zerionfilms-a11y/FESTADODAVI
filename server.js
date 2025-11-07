/**
 * server.js — CABINE FOTOGRÁFICA (COMPLETO)
 *
 * - Recebe fotos (dataURLs) do celular e faz upload para IMGBB
 * - Recebe boomerang (ArrayBuffer/binary) via socket e faz upload para IMGBB (fallback serve /uploads)
 * - Gera QR code (dataURL) do visualizador e emite 'visualizer_ready' para viewers (celular) e operadores (index)
 * - Rota /visualizador/:session para preview simples
 *
 * Dependências necessárias:
 *   npm install express socket.io multer axios fs-extra uuid qrcode cors
 *
 * Configs via env:
 *   IMGBB_KEY (opcional) - se não houver, uploads para IMGBB serão pulados (fallback para /uploads)
 *   BASE_URL (opcional) - URL pública do servidor (com https://). Ex: "https://festadodavi.onrender.com"
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

// ---------------- Config ----------------
const BASE_URL = (process.env.BASE_URL && process.env.BASE_URL.startsWith('http')) ? process.env.BASE_URL : (process.env.BASE_URL ? `https://${process.env.BASE_URL}` : 'https://festadodavi-production-0591.up.railway.app');
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // substitua pela sua chave
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// cria pastas
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(PUBLIC_DIR);

// middlewares
app.use(cors());
app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true, limit: '120mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// multer para upload debug/multipart
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const uploadMiddleware = multer({ storage });

// middleware simples de log
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---------------- Util: upload para IMGBB ----------------
async function uploadBase64ToImgbb(base64OrDataUrl, name = 'cabine_asset') {
  if (!IMGBB_KEY || IMGBB_KEY.includes('PUT_YOUR')) {
    console.warn('IMGBB_KEY não configurada. uploadBase64ToImgbb retornará null.');
    return null;
  }

  try {
    let rawBase64 = base64OrDataUrl;
    if (rawBase64.startsWith('data:')) {
      rawBase64 = rawBase64.split(',')[1];
    }

    const params = new URLSearchParams();
    params.append('key', IMGBB_KEY);
    params.append('image', rawBase64);
    params.append('name', name);

    const res = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxBodyLength: Infinity,
      timeout: 30000,
    });

    if (res.data && res.data.success && res.data.data) {
      return res.data.data.display_url || res.data.data.url || null;
    }
    console.warn('IMGBB resposta inesperada:', res.data);
    return null;
  } catch (err) {
    console.error('Erro upload IMGBB:', err.response ? err.response.data : err.message || err);
    return null;
  }
}

// ---------------- Sessões (memória) ----------------
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
    };
  }
  return sessions[sessionId];
}

// ---------------- Rotas HTTP ----------------
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: Object.keys(sessions).length });
});

app.get('/sessions', (req, res) => {
  const list = Object.keys(sessions).map((id) => ({
    session: id,
    createdAt: sessions[id].createdAt,
    photosCount: sessions[id].photos.length,
    hasBoomerang: !!sessions[id].boomerang,
  }));
  res.json(list);
});

// preview simples do visualizador
app.get('/visualizador/:session', (req, res) => {
  const sessionId = req.params.session;
  const s = sessions[sessionId];
  if (!s) {
    return res.status(404).send('<h2>Visualizador - sessão não encontrada</h2>');
  }

  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Visualizador - ${sessionId}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#000;color:#fff;font-family:Arial;padding:12px">`;
  html += `<h2>Visualizador — Sessão: ${sessionId}</h2>`;
  if (s.photos && s.photos.length) {
    html += `<h3>Fotos (${s.photos.length})</h3><div style="display:flex;gap:8px;flex-wrap:wrap">`;
    s.photos.forEach((u) => {
      html += `<div style="max-width:220px"><img src="${u}" style="width:100%;height:auto;display:block;border-radius:8px"/></div>`;
    });
    html += `</div>`;
  }
  if (s.boomerang && s.boomerang.url) {
    html += `<h3>Boomerang</h3>`;
    html += `<video controls playsinline loop style="width:100%;max-width:420px;border-radius:8px"><source src="${s.boomerang.url}"></video>`;
  }
  html += `<p style="opacity:0.6;margin-top:14px">Gerado em: ${s.createdAt}</p>`;
  html += `</body></html>`;
  res.send(html);
});

// upload debug via multipart
app.post('/upload-debug', uploadMiddleware.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file' });
    const filePath = path.join(UPLOADS_DIR, file.filename);
    const buffer = await fs.readFile(filePath);
    const base64 = buffer.toString('base64');
    const url = await uploadBase64ToImgbb(base64);
    return res.json({ ok: true, url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, err: String(err) });
  }
});

// HTTP fallback used pelo celular (client-side) -> /upload_photos
app.post('/upload_photos', async (req, res) => {
  try {
    const { session, photos } = req.body || {};
    const sid = session || 'cabine-fixa';
    const s = ensureSession(sid);
    if (!Array.isArray(photos) || photos.length === 0) return res.status(400).json({ ok: false, error: 'no-photos' });

    const uploaded = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      // attempt upload to IMGBB
      // eslint-disable-next-line no-await-in-loop
      const url = await uploadBase64ToImgbb(p, `cabine_${sid}_${Date.now()}_${i}`);
      if (url) uploaded.push(url);
      else {
        // fallback: persist locally and serve via /uploads
        const filename = `${Date.now()}_${i}.jpg`;
        const target = path.join(UPLOADS_DIR, filename);
        const b64 = p.startsWith('data:') ? p.split(',')[1] : p;
        await fs.writeFile(target, Buffer.from(b64, 'base64'));
        uploaded.push(`${BASE_URL}/uploads/${filename}`);
      }
    }

    if (uploaded.length) {
      s.photos = uploaded;
    }

    // generate visualizador + QR and emit
    const visualizadorUrl = `${BASE_URL}/visualizador/${encodeURIComponent(sid)}`;
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(visualizadorUrl, { color: { dark: '#000000', light: '#ffffff' }, width: 300 });
    } catch (e) {
      console.warn('Falha gerar QR:', e);
    }

    // notify
    io.to(sid).emit('photos_ready', { session: sid, uploaded, visualizadorUrl });
    io.to(sid).emit('visualizer_ready', { session: sid, visualizerUrl, qrUrl: qrDataUrl });

    return res.json({ ok: true, uploaded, visualizadorUrl, qrUrl: !!qrDataUrl });
  } catch (err) {
    console.error('upload_photos error', err);
    return res.status(500).json({ ok: false, err: String(err) });
  }
});

// ---------------- Socket.IO ----------------
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

    // emit current state
    socket.emit('session_state', {
      session: sid,
      photosCount: s.photos.length,
      hasBoomerang: !!s.boomerang,
      preview: { photos: s.photos, boomerang: s.boomerang && s.boomerang.url ? s.boomerang.url : null },
      baseUrl: BASE_URL,
    });
  });

  /**
   * photos_from_cell
   * payload: { session, photos: [dataURL,...], ts? }
   * optional callback (ack) from client will be handled by socket.io automatically
   */
  socket.on('photos_from_cell', async (payload, cb) => {
    try {
      const session = (payload && payload.session) ? payload.session : 'cabine-fixa';
      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      console.log(`[${session}] photos_from_cell received. Count: ${photos.length}`);

      const s = ensureSession(session);
      s.lastRawPhotos = photos.slice(0, 10);

      // upload each photo (try IMGBB, fallback to /uploads)
      const uploaded = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        // eslint-disable-next-line no-await-in-loop
        const url = await uploadBase64ToImgbb(p, `cabine_${session}_${Date.now()}_${i}`);
        if (url) uploaded.push(url);
        else {
          // persist locally and serve via /uploads
          const filename = `${Date.now()}_${i}.jpg`;
          const target = path.join(UPLOADS_DIR, filename);
          const b64 = p.startsWith('data:') ? p.split(',')[1] : p;
          // eslint-disable-next-line no-await-in-loop
          await fs.writeFile(target, Buffer.from(b64, 'base64'));
          uploaded.push(`${BASE_URL}/uploads/${filename}`);
        }
      }

      if (uploaded.length) s.photos = uploaded;

      // build visualizador URL & QR
      const visualizadorUrl = `${BASE_URL}/visualizador/${encodeURIComponent(session)}`;
      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(visualizadorUrl, { color: { dark: '#000000', light: '#ffffff' }, width: 300 });
      } catch (e) {
        console.warn('Falha ao gerar QR Code', e);
      }

      // emit to session
      io.to(session).emit('photos_ready', {
        session,
        uploaded,
        visualizadorUrl,
      });

      // emit visualizer_ready with QR (this makes celular show QR overlay)
      io.to(session).emit('visualizer_ready', {
        session,
        visualizerUrl,
        qrUrl: qrDataUrl,
      });

      console.log(`[${session}] photos processed and emitted (uploaded: ${uploaded.length})`);

      if (typeof cb === 'function') cb(null, { ok: true, uploaded, visualizadorUrl });
    } catch (err) {
      console.error('Error photos_from_cell:', err);
      if (typeof cb === 'function') cb({ ok: false, error: String(err) });
      socket.emit('error_msg', { message: 'Erro ao processar fotos' });
    }
  });

  /**
   * boomerang_ready
   * payload: { session, filename, data: ArrayBuffer|Buffer|typed-array | base64 string }
   */
  socket.on('boomerang_ready', async (payload, cb) => {
    try {
      const session = (payload && payload.session) ? payload.session : 'cabine-fixa';
      console.log(`[${session}] boomerang_ready received (socket: ${socket.id})`);

      let buffer = null;

      if (payload.data) {
        if (Buffer.isBuffer(payload.data)) {
          buffer = payload.data;
        } else if (payload.data instanceof ArrayBuffer) {
          buffer = Buffer.from(payload.data);
        } else if (payload.data.data && Array.isArray(payload.data.data)) {
          buffer = Buffer.from(payload.data.data);
        } else if (typeof payload.data === 'string' && payload.data.startsWith('data:')) {
          const base64 = payload.data.split(',')[1];
          buffer = Buffer.from(base64, 'base64');
        } else if (typeof payload.data === 'string') {
          // assume raw base64
          try { buffer = Buffer.from(payload.data, 'base64'); } catch(e){ buffer = null; }
        }
      }

      if (!buffer && payload.base64) {
        buffer = Buffer.from(payload.base64, 'base64');
      }

      if (!buffer && payload.raw && typeof payload.raw === 'string' && payload.raw.indexOf('base64') > -1) {
        const base64 = payload.raw.split(',')[1];
        buffer = Buffer.from(base64, 'base64');
      }

      if (!buffer) {
        socket.emit('error_msg', { message: 'Boomerang sem dados binários válidos' });
        if (typeof cb === 'function') cb({ ok: false, error: 'no-binary' });
        return;
      }

      const fileName = payload.filename || `boomerang_${Date.now()}.webm`;
      const tempPath = path.join(UPLOADS_DIR, `${uuidv4()}_${fileName}`);
      await fs.writeFile(tempPath, buffer);

      // attempt upload to IMGBB (videos may fail); otherwise fallback to serving file
      let uploadedUrl = null;
      try {
        uploadedUrl = await uploadBase64ToImgbb(`data:video/webm;base64,${buffer.toString('base64')}`, `boomerang_${session}_${Date.now()}`);
      } catch (e) {
        console.warn('Erro no upload de vídeo para IMGBB (tentativa):', e);
      }

      if (!uploadedUrl) {
        // fallback: serve via /uploads
        uploadedUrl = `${BASE_URL}/uploads/${path.basename(tempPath)}`;
      }

      const s = ensureSession(session);
      s.boomerang = { url: uploadedUrl, uploadedAt: new Date().toISOString() };

      // generate visualizer url + qr
      const visualizadorUrl = `${BASE_URL}/visualizador/${encodeURIComponent(session)}`;
      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(visualizadorUrl, { color: { dark: '#000000', light: '#ffffff' }, width: 300 });
      } catch (e) {
        console.warn('Falha ao gerar QR Code para boomerang', e);
      }

      // emit events
      io.to(session).emit('boomerang_ready', {
        session,
        videoUrl: uploadedUrl,
        visualizadorUrl,
      });

      io.to(session).emit('visualizer_ready', {
        session,
        visualizerUrl,
        qrUrl: qrDataUrl,
      });

      console.log(`[${session}] Boomerang processed and emitted: ${uploadedUrl}`);

      // cleanup temp file a bit later
      setTimeout(() => { fs.remove(tempPath).catch(()=>{}); }, 30 * 1000);

      if (typeof cb === 'function') cb(null, { ok: true, url: uploadedUrl, visualizadorUrl });
    } catch (err) {
      console.error('Erro boomerang_ready:', err);
      if (typeof cb === 'function') cb({ ok: false, error: String(err) });
      socket.emit('error_msg', { message: 'Erro ao processar boomerang' });
    }
  });

  // operator finaliza/reset
  socket.on('reset_session', ({ session }) => {
    const sid = session || 'cabine-fixa';
    delete sessions[sid];
    io.to(sid).emit('reset_session', { session: sid });
    console.log(`Sessão ${sid} resetada por socket ${socket.id}`);
  });

  socket.on('finalize_session', ({ session }) => {
    const sid = session || 'cabine-fixa';
    io.to(sid).emit('finalize_session', { session: sid });
    console.log(`Sessão ${sid} finalizada por socket ${socket.id}`);
  });

  // ping
  socket.on('ping_server', (cb) => {
    if (cb && typeof cb === 'function') cb({ ok: true, time: Date.now() });
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

// ---------------- Start server ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} — BASE_URL=${BASE_URL}`);
  console.log(`Uploads temporários em ${UPLOADS_DIR}`);
});

/**
 * Notas finais:
 * - Ajuste IMGBB_KEY para upload de imagens. Para vídeos é recomendado Cloudinary / S3.
 * - Sessions são mantidas em memória; considere DB para persistência.
 * - Clientes (celular.html) esperam 'visualizer_ready' com { visualizerUrl, qrUrl } para travar/mostrar QR.
 * - Para debug, acesse /visualizador/:session para ver o preview do que foi recebido.
 */
