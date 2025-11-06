/**
 * server.js — CABINE FOTOGRÁFICA (COMPLETO)
 *
 * Funcionalidades:
 * - Servidor Express + Socket.IO
 * - Recebe fotos (dataURLs) do celular e faz upload para IMGBB
 * - Recebe boomerang (ArrayBuffer/binary) via socket e faz upload para IMGBB
 * - Gera/armazena sessão com fotos/boomerang e emite eventos para operator/index
 * - Rotas: / (static public), /health, /sessions (admin), /visualizador/:session (preview simples)
 *
 * Dependências:
 *  - express, socket.io, multer, axios, fs-extra, uuid, qrcode
 *
 * Atenção:
 *  - Altere IMGBB_KEY para sua chave IMGBB
 *  - Ajuste BASE_URL se necessário (padrão: https://festadodavi.onrender.com)
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

const app = express();
const server = http.createServer(app);

// Socket.IO com configurações razoáveis
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  // path: '/socket.io' // use default
});

// Configs
const BASE_URL = process.env.BASE_URL || 'festadodavi-production-0591.up.railway.app'; // preferência salva
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // <<< coloque sua chave real
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// cria pastas necessárias
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(PUBLIC_DIR);

app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));
app.use(express.static(PUBLIC_DIR)); // serve index.html, celular.html, visualizador.html se colocados em /public

// simples middleware de log
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --------- Util: upload para IMGBB (aceita dataURL ou base64 sem prefix) ----------
async function uploadBase64ToImgbb(base64OrDataUrl, name = 'cabine_asset') {
  // aceita dataURL (data:*/*;base64,AAAA...) ou base64 puro
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
      // prefer display_url when available
      return res.data.data.display_url || res.data.data.url || null;
    }
    console.warn('IMGBB resposta inesperada:', res.data);
    return null;
  } catch (err) {
    console.error('Erro upload IMGBB:', err.response ? err.response.data : err.message || err);
    return null;
  }
}

// --------- Estrutura de sessão em memória (pode ser persistida em DB) ----------
/**
 * sessions = {
 *   sessionId: {
 *     createdAt,
 *     operatorSocketId,
 *     viewers: [ socketId ],
 *     photos: [url1, url2, ...],
 *     boomerang: { url, uploadedAt } | null,
 *     lastRawPhotos: [dataURL,...] // opcional
 *   }
 * }
 */
const sessions = {};

// helpers de sessão
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

// ---------- Rotas HTTP ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: Object.keys(sessions).length });
});

// rota admin para listar sessões
app.get('/sessions', (req, res) => {
  const list = Object.keys(sessions).map((id) => ({
    session: id,
    createdAt: sessions[id].createdAt,
    photosCount: sessions[id].photos.length,
    hasBoomerang: !!sessions[id].boomerang,
  }));
  res.json(list);
});

// rota para visualizar a payload do visualizador (simples)
app.get('/visualizador/:session', (req, res) => {
  const sessionId = req.params.session;
  const s = sessions[sessionId];
  if (!s) {
    return res.status(404).send('<h2>Visualizador - sessão não encontrada</h2>');
  }

  // Gera uma página simples com fotos e/o boomerang
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Visualizador - ${sessionId}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#000;color:#fff;font-family:Arial;padding:12px">`;
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

// POST route (multipart) for optional manual upload (operator UI / debug)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const uploadMiddleware = multer({ storage });

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

// ------------- Socket.IO -------------
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
      // viewer/cell
      if (!s.viewers.includes(socket.id)) s.viewers.push(socket.id);
      console.log(`[${sid}] viewer joined: ${socket.id}`);
    }

    // emit state to this socket
    socket.emit('session_state', {
      session: sid,
      photosCount: s.photos.length,
      hasBoomerang: !!s.boomerang,
      preview: { photos: s.photos, boomerang: s.boomerang && s.boomerang.url ? s.boomerang.url : null },
      baseUrl: BASE_URL,
    });
  });

  // cellphone: envia fotos em dataURLs (array)
  // { session, viewerId(optional), photos: [dataURL,...] }
  socket.on('photos_from_cell', async (payload) => {
    try {
      const session = payload.session || 'cabine-fixa';
      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      console.log(`[${session}] photos_from_cell received. Count: ${photos.length}`);

      const s = ensureSession(session);
      s.lastRawPhotos = photos.slice(0, 10);

      // upload each to IMGBB (se possível)
      const uploaded = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        // small delay to avoid flooding IMGBB
        // eslint-disable-next-line no-await-in-loop
        const url = await uploadBase64ToImgbb(p, `cabine_${session}_${Date.now()}_${i}`);
        if (url) uploaded.push(url);
      }

      if (uploaded.length) {
        s.photos = uploaded;
      }

      // build visualizador URL (server-side route) - index/operador can generate QR from this link
      const visualizadorUrl = `${BASE_URL}/visualizador/${encodeURIComponent(session)}`;

      // notify operator(s) and viewers in the session
      io.to(session).emit('photos_ready', {
        session,
        uploaded,
        visualizadorUrl,
      });

      console.log(`[${session}] photos processed and emitted (uploaded: ${uploaded.length})`);
    } catch (err) {
      console.error('Error photos_from_cell:', err);
      socket.emit('error_msg', { message: 'Erro ao processar fotos' });
    }
  });

  // cellphone: envia boomerang as binary (ArrayBuffer or Buffer) via socket
  // Data: { session, filename, arrayBuffer/Buffer (binary) } — we accept both shapes
  socket.on('boomerang_ready', async (payload) => {
    try {
      const session = payload.session || 'cabine-fixa';
      console.log(`[${session}] boomerang_ready received (socket: ${socket.id})`);

      // payload.data may be ArrayBuffer or Buffer or we may receive in payload as base64 string
      let buffer = null;

      if (payload.data) {
        // If payload.data is ArrayBuffer-like:
        if (Buffer.isBuffer(payload.data)) {
          buffer = payload.data;
        } else if (payload.data instanceof ArrayBuffer) {
          buffer = Buffer.from(payload.data);
        } else if (payload.data.data && Array.isArray(payload.data.data)) {
          // sometimes socket.io transfers typed arrays like { data: [...] }
          buffer = Buffer.from(payload.data.data);
        } else if (typeof payload.data === 'string' && payload.data.startsWith('data:')) {
          // dataURL string
          const base64 = payload.data.split(',')[1];
          buffer = Buffer.from(base64, 'base64');
        } else if (typeof payload.data === 'string') {
          // assume base64 raw
          try {
            buffer = Buffer.from(payload.data, 'base64');
          } catch (e) {
            buffer = null;
          }
        }
      }

      // fallback: payload.base64
      if (!buffer && payload.base64) {
        buffer = Buffer.from(payload.base64, 'base64');
      }

      if (!buffer) {
        console.warn('boomerang_ready: não veio buffer válido. Tentando tratar payload.raw...');
        if (payload.raw && typeof payload.raw === 'string' && payload.raw.indexOf('base64') > -1) {
          const base64 = payload.raw.split(',')[1];
          buffer = Buffer.from(base64, 'base64');
        }
      }

      if (!buffer) {
        socket.emit('error_msg', { message: 'Boomerang sem dados binários válidos' });
        return;
      }

      // grava temporariamente e faz upload
      const fileName = payload.filename || `boomerang_${Date.now()}.webm`;
      const tempPath = path.join(UPLOADS_DIR, `${uuidv4()}_${fileName}`);
      await fs.writeFile(tempPath, buffer);

      // converte para base64 para IMGBB (IMGBB tende a aceitar imagens; vídeos podem não aceitar. Tentaremos)
      const b64 = buffer.toString('base64');

      // IMGBB NÃO é ideal para vídeos — se não aceitar, você precisa de Cloudinary ou S3. Tentamos mesmo assim.
      let uploadedUrl = null;
      try {
        uploadedUrl = await uploadBase64ToImgbb(`data:video/webm;base64,${b64}`, `boomerang_${session}_${Date.now()}`);
      } catch (e) {
        console.warn('Erro no upload de vídeo para IMGBB (tentativa):', e);
      }

      // se o upload falhar, pode haver fallback: servir o arquivo temporário via /uploads (não ideal em produção)
      if (!uploadedUrl) {
        const publicPath = `/uploads/${path.basename(tempPath)}`;
        // expõe a rota pública temporária
        app.use('/uploads', express.static(UPLOADS_DIR));
        uploadedUrl = `${BASE_URL}${publicPath}`;
        console.warn('Fallback: boomerang servido localmente em:', uploadedUrl);
      }

      // atualiza sessão
      const s = ensureSession(session);
      s.boomerang = { url: uploadedUrl, uploadedAt: new Date().toISOString() };

      // gera visualizador link
      const visualizadorUrl = `${BASE_URL}/visualizador/${encodeURIComponent(session)}`;

      // emite para a sessão — operator e viewer deverão receber e mostrar QR/imagem/video
      io.to(session).emit('boomerang_ready', {
        session,
        videoUrl: uploadedUrl,
        visualizadorUrl,
      });

      console.log(`[${session}] Boomerang processado e enviado: ${uploadedUrl}`);

      // opcional: remove arquivo temporário após 30s (mantemos por segurança)
      setTimeout(() => {
        fs.remove(tempPath).catch(() => {});
      }, 30 * 1000);
    } catch (err) {
      console.error('Erro boomerang_ready:', err);
      socket.emit('error_msg', { message: 'Erro ao processar boomerang' });
    }
  });

  // operator -> finalize / reset session
  socket.on('reset_session', ({ session }) => {
    const sid = session || 'cabine-fixa';
    delete sessions[sid];
    io.to(sid).emit('reset_session', { session: sid });
    console.log(`Sessão ${sid} resetada por socket ${socket.id}`);
  });

  // health / debug
  socket.on('ping_server', (cb) => {
    if (cb && typeof cb === 'function') cb({ ok: true, time: Date.now() });
  });

  socket.on('disconnect', () => {
    // remove from viewers lists
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

// ------------- Inicialização do servidor -------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} — BASE_URL=${BASE_URL}`);
  console.log(`Uploads temporários em ${UPLOADS_DIR}`);
});

/**
 * Observações e recomendações:
 *  - IMGBB não é ideal para vídeos; se você precisa de boomerangs confiáveis, use Cloudinary / S3.
 *  - Este servidor tenta fazer upload de vídeo para IMGBB; caso falhe, serve o arquivo temporário via /uploads.
 *  - Sessions são mantidas em memória — reinício do servidor perde dados. Para persistência use um DB.
 *  - integração com index.html / celular.html:
 *     -> Celular emite 'photos_from_cell' com { session, photos: [dataURL, ...] }.
 *     -> Celular emite 'boomerang_ready' com { session, filename, data: ArrayBuffer/Buffer }.
 *     -> Index / operador escuta 'photos_ready' e 'boomerang_ready' para gerar QR / montar visualizador.
 *
 * Teste rápido:
 *  - Start: NODE_ENV=production IMGBB_KEY=... node server.js
 *  - Acesse: http://localhost:3000/ (ou seu PUBLIC_DIR com index.html)
 */
