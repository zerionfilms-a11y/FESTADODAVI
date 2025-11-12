/**
 * server.js — CABINE FOTOGRÁFICA (COMPLETO) — atualizado para enviar storiesMontage/printMontage e redirecionar visualizador
 *
 * Dependências:
 *  - express, socket.io, multer, axios, fs-extra, path, uuid, qrcode
 *
 * Atenção:
 *  - Altere IMGBB_KEY para sua chave IMGBB se quiser upload automático no servidor
 *  - BASE_URL deve apontar para seu domínio público (ex: https://festadodavi-production-0591.up.railway.app)
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

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling']
});

// Configs
const BASE_URL = process.env.BASE_URL || 'https://festadodavi-production-0591.up.railway.app';
const IMGBB_KEY = process.env.IMGBB_KEY || ''; // se quiser IMGBB no servidor, coloque a chave aqui
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(PUBLIC_DIR);

app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true, limit: '120mb' }));
app.use(express.static(PUBLIC_DIR));
app.use((req,res,next)=>{ console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`); next(); });

// util: upload dataURL/base64 to imgbb
async function uploadBase64ToImgbb(base64OrDataUrl, name = 'cabine_asset') {
  if (!IMGBB_KEY) {
    console.warn('IMGBB_KEY não configurada. uploadBase64ToImgbb retornará null.');
    return null;
  }
  try {
    let rawBase64 = base64OrDataUrl;
    if (rawBase64.startsWith('data:')) rawBase64 = rawBase64.split(',')[1];
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

// sessions in-memory
const sessions = {};
function ensureSession(sessionId) {
  if (!sessionId) sessionId = 'cabine-fixa';
  if (!sessions[sessionId]) {
    sessions[sessionId] = { createdAt: new Date().toISOString(), operatorSocketId: null, viewers: [], photos: [], boomerang: null, lastRawPhotos: [] };
  }
  return sessions[sessionId];
}

// health
app.get('/health', (req,res)=> res.json({ ok:true, uptime: process.uptime(), sessions: Object.keys(sessions).length }));

// IMPORTANT: keep existing visualizador route compatible — but redirect to static visualizador.html if present
app.get('/visualizador/:session', (req,res) => {
  const sessionId = req.params.session;
  // If you have a static visualizador.html in public, redirect to it with the session query param
  const staticVizPath = path.join(PUBLIC_DIR, 'visualizador.html');
  if (fs.existsSync(staticVizPath)) {
    const redirectUrl = `/visualizador.html?session=${encodeURIComponent(sessionId)}`;
    return res.redirect(302, redirectUrl);
  }
  // Fallback: generate simple HTML if visualizador.html not present
  const s = sessions[sessionId];
  if (!s) return res.status(404).send('<h2>Visualizador - sessão não encontrada</h2>');
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Visualizador - ${sessionId}</title></head><body style="background:#000;color:#fff;font-family:Arial;padding:12px">`;
  html += `<h2>Visualizador — Sessão: ${sessionId}</h2>`;
  if (s.photos && s.photos.length) {
    html += `<h3>Fotos (${s.photos.length})</h3><div style="display:flex;gap:8px;flex-wrap:wrap">`;
    s.photos.forEach((u) => html += `<div style="max-width:220px"><img src="${u}" style="width:100%;height:auto;display:block;border-radius:8px"/></div>`);
    html += `</div>`;
  }
  if (s.boomerang && s.boomerang.url) {
    html += `<h3>Boomerang</h3><video controls playsinline loop style="width:100%;max-width:420px;border-radius:8px"><source src="${s.boomerang.url}"></video>`;
  }
  html += `<p style="opacity:0.6;margin-top:14px">Gerado em: ${s.createdAt}</p></body></html>`;
  res.send(html);
});

// upload debug route
const storage = multer.diskStorage({
  destination: (req,file,cb)=> cb(null, UPLOADS_DIR),
  filename: (req,file,cb)=> cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadMiddleware = multer({ storage });
app.post('/upload-debug', uploadMiddleware.single('file'), async (req,res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error:'no file' });
    const buffer = await fs.readFile(path.join(UPLOADS_DIR, file.filename));
    const base64 = buffer.toString('base64');
    const url = await uploadBase64ToImgbb(base64);
    return res.json({ ok:true, url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, err: String(err) });
  }
});

// socket
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join_session', ({ session, role }) => {
    const sid = session || 'cabine-fixa';
    socket.join(sid);
    const s = ensureSession(sid);
    if (role === 'operator') {
      s.operatorSocketId = socket.id;
    } else {
      if (!s.viewers.includes(socket.id)) s.viewers.push(socket.id);
    }
    socket.emit('session_state', {
      session: sid,
      photosCount: s.photos.length,
      hasBoomerang: !!s.boomerang,
      preview: { photos: s.photos, boomerang: s.boomerang && s.boomerang.url ? s.boomerang.url : null },
      baseUrl: BASE_URL
    });
  });

  // cellphone sends photos (dataURLs) or uploaded URLs
  socket.on('photos_from_cell', async (payload) => {
    try {
      const session = (payload && payload.session) || 'cabine-fixa';
      const rawPhotos = Array.isArray(payload.photos) ? payload.photos : [];
      console.log(`[${session}] photos_from_cell received. Count: ${rawPhotos.length}`);
      const s = ensureSession(session);
      s.lastRawPhotos = rawPhotos.slice(0,10);

      // Try to upload photos to IMGBB (if configured) or accept already-uploaded URLs
      const uploaded = [];
      for (let i=0;i<rawPhotos.length;i++){
        const p = rawPhotos[i];
        if (typeof p === 'string' && p.startsWith('http')) {
          uploaded.push(p);
        } else {
          // if base64 / dataURL -> try uploadServer
          // eslint-disable-next-line no-await-in-loop
          const url = await uploadBase64ToImgbb(p, `cabine_${session}_${Date.now()}_${i}`);
          if (url) uploaded.push(url);
          else {
            // if upload failed, keep original dataURL (client can use dataURL)
            uploaded.push(p);
          }
        }
      }

      // handle stories montage and print montage if sent
      let storiesUrl = null;
      let printUrl = null;
      if (payload.storiesMontage) {
        const sm = payload.storiesMontage;
        if (typeof sm === 'string' && sm.startsWith('data:')) {
          storiesUrl = await uploadBase64ToImgbb(sm, `stories_${session}_${Date.now()}`) || sm;
        } else if (typeof sm === 'string' && sm.startsWith('http')) {
          storiesUrl = sm;
        }
      }
      if (payload.print) {
        const pm = payload.print;
        if (typeof pm === 'string' && pm.startsWith('data:')) {
          printUrl = await uploadBase64ToImgbb(pm, `print_${session}_${Date.now()}`) || pm;
        } else if (typeof pm === 'string' && pm.startsWith('http')) {
          printUrl = pm;
        }
      }

      // store uploaded urls in session
      if (uploaded && uploaded.length) s.photos = uploaded;

      // build visualizador URL pointing to static visualizador.html with query
      const visualizadorUrl = `${BASE_URL.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(session)}`;

      // notify all sockets in session with both photos_ready and viewer_photos_ready
      io.to(session).emit('photos_ready', {
        session,
        uploaded,
        visualizadorUrl,
        storiesUrl,
        printUrl
      });

      // Also emit viewer-specific event expected by visualizador.html
      io.to(session).emit('viewer_photos_ready', {
        session,
        photos: uploaded,
        storiesMontage: storiesUrl || payload.storiesMontage || null,
        print: printUrl || payload.print || null,
        visualizadorUrl
      });

      console.log(`[${session}] photos processed and emitted (uploaded: ${uploaded.length})`);
    } catch (err) {
      console.error('Error photos_from_cell:', err);
      socket.emit('error_msg', { message: 'Erro ao processar fotos' });
    }
  });

  // boomerang handler (tries to handle binary and dataURL cases)
  socket.on('boomerang_ready', async (payload) => {
    try {
      const session = payload.session || 'cabine-fixa';
      console.log(`[${session}] boomerang_ready received (socket: ${socket.id})`);
      let buffer = null;
      if (payload.data) {
        if (Buffer.isBuffer(payload.data)) buffer = payload.data;
        else if (payload.data instanceof ArrayBuffer) buffer = Buffer.from(payload.data);
        else if (payload.data.data && Array.isArray(payload.data.data)) buffer = Buffer.from(payload.data.data);
        else if (typeof payload.data === 'string' && payload.data.startsWith('data:')) buffer = Buffer.from(payload.data.split(',')[1],'base64');
        else if (typeof payload.data === 'string') {
          try { buffer = Buffer.from(payload.data, 'base64'); } catch(e){ buffer = null; }
        }
      }
      if (!buffer && payload.base64) buffer = Buffer.from(payload.base64,'base64');
      if (!buffer && payload.raw && typeof payload.raw === 'string' && payload.raw.indexOf('base64')> -1) {
        const base64 = payload.raw.split(',')[1]; buffer = Buffer.from(base64,'base64');
      }
      if (!buffer) {
        socket.emit('error_msg', { message: 'Boomerang sem dados binários válidos' });
        return;
      }
      const fileName = payload.filename || `boomerang_${Date.now()}.webm`;
      const tempPath = path.join(UPLOADS_DIR, `${uuidv4()}_${fileName}`);
      await fs.writeFile(tempPath, buffer);

      const b64 = buffer.toString('base64');
      let uploadedUrl = null;
      try {
        uploadedUrl = await uploadBase64ToImgbb(`data:video/webm;base64,${b64}`, `boomerang_${session}_${Date.now()}`);
      } catch (e) {
        console.warn('Erro no upload de vídeo para IMGBB (tentativa):', e);
      }
      if (!uploadedUrl) {
        app.use('/uploads', express.static(UPLOADS_DIR));
        uploadedUrl = `${BASE_URL.replace(/\/+$/,'')}/uploads/${path.basename(tempPath)}`;
      }
      const s = ensureSession(session);
      s.boomerang = { url: uploadedUrl, uploadedAt: new Date().toISOString() };

      const visualizadorUrl = `${BASE_URL.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(session)}`;
      io.to(session).emit('boomerang_ready', { session, videoUrl: uploadedUrl, visualizadorUrl });

      console.log(`[${session}] Boomerang processed and sent: ${uploadedUrl}`);

      setTimeout(()=>{ fs.remove(tempPath).catch(()=>{}); }, 30*1000);
    } catch (err) {
      console.error('Erro boomerang_ready:', err);
      socket.emit('error_msg', { message: 'Erro ao processar boomerang' });
    }
  });

  socket.on('create_viewer_session', ({ session, photos, storiesMontage, print }) => {
    // optional: store viewer session metadata (very simple)
    const sid = session || 'cabine-fixa';
    const s = ensureSession(sid);
    // push to history simple id
    const viewerId = `${sid}:${Date.now()}`;
    if (!s.viewHistory) s.viewHistory = [];
    s.viewHistory.unshift({ viewerId, photos: photos || [], storiesMontage: storiesMontage || null, print: print || null, createdAt: new Date().toISOString() });
    socket.emit('viewer_session_created', { viewerId });
  });

  socket.on('reset_session', ({ session }) => {
    const sid = session || 'cabine-fixa';
    delete sessions[sid];
    io.to(sid).emit('reset_session', { session: sid });
    console.log(`Sessão ${sid} resetada por socket ${socket.id}`);
  });

  socket.on('ping_server', (cb) => { if (cb && typeof cb === 'function') cb({ ok:true, time: Date.now() }); });

  socket.on('disconnect', () => {
    try {
      Object.keys(sessions).forEach((sid) => {
        const s = sessions[sid];
        if (!s) return;
        if (s.operatorSocketId === socket.id) s.operatorSocketId = null;
        const idx = s.viewers.indexOf(socket.id);
        if (idx >= 0) s.viewers.splice(idx,1);
      });
    } catch(e){}
    console.log('Socket disconnected:', socket.id);
  });
});

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> {
  console.log(`Servidor rodando na porta ${PORT} — BASE_URL=${BASE_URL}`);
  console.log(`Uploads temporários em ${UPLOADS_DIR}`);
});
