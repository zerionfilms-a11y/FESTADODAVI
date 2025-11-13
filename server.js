// server.js (revisado e completo) 
// node >= 16 recommended

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // se usar node-fetch v3 em ESM, adapte; aqui assumimos compatibilidade
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // coloque sua chave aqui ou via ENV
// <<< ALTERAÇÃO: incluir protocolo na origem padrão
const VISUALIZADOR_ORIGIN = process.env.VISUALIZADOR_ORIGIN || 'https://festadodavi-production-0591.up.railway.app';

const app = express();
const server = http.createServer(app);

// <<< ALTERAÇÃO: aumentar buffer para permitir mensagens socket grandes + permitir CORS
const io = new Server(server, {
  cors: { origin: true, methods: ["GET","POST"] },
  maxHttpBufferSize: 50 * 1024 * 1024 // 50 MB
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.json({ limit: '50mb' }));
// <<< ALTERAÇÃO: limitar urlencoded também para uploads grandes via POST
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(PUBLIC_DIR));

// expõe uploads (multer dest)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

const sessions = {}; // in-memory store: { sessionId: { viewers: { vid: {...} }, operators: Set(socketId), lastStreamFrame, createdAt } }

function ensureSession(sessionId) {
  if (!sessionId) return null;
  if (!sessions[sessionId]) {
    sessions[sessionId] = { viewers: {}, operators: new Set(), lastStreamFrame: null, createdAt: new Date().toISOString() };
  }
  return sessions[sessionId];
}

// helpers: upload base64 to imgbb
async function uploadToImgbbFromDataUrl(dataUrl, name) {
  if (!IMGBB_KEY) throw new Error('IMGBB_KEY not configured');
  const parts = dataUrl.split(',');
  if (parts.length < 2) throw new Error('Invalid dataURL');
  const base64 = parts[1];
  const form = new URLSearchParams();
  form.append('key', IMGBB_KEY);
  form.append('image', base64);
  if (name) form.append('name', name);
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const j = await res.json();
  if (j && j.success && j.data && (j.data.display_url || j.data.url)) return j.data.display_url || j.data.url;
  throw new Error('IMGBB upload failed: ' + JSON.stringify(j));
}

// redirect helper: /visualizador/:session -> visualizador.html?session=...
app.get('/visualizador/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const staticVizPath = path.join(PUBLIC_DIR, 'visualizador.html');
  if (fs.existsSync(staticVizPath)) {
    const redirectUrl = `/visualizador.html?session=${encodeURIComponent(sessionId)}`;
    return res.redirect(302, redirectUrl);
  }
  const s = sessions[sessionId];
  if (!s) return res.status(404).send('<h2>Visualizador - sessão não encontrada</h2>');
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Visualizador - ${sessionId}</title></head><body style="background:#000;color:#fff;font-family:Arial;padding:12px">`;
  html += `<h2>Visualizador — Sessão: ${sessionId}</h2>`;
  if (s && s.viewers) {
    const keys = Object.keys(s.viewers);
    html += `<div>Visualizadores: ${keys.length}</div>`;
  }
  html += `</body></html>`;
  res.send(html);
});

// multer route for boomerang upload fallback
const upload = multer({ dest: UPLOADS_DIR });
app.post('/upload_boomerang', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, err: 'no file' });
    const url = `/uploads/${req.file.filename}`;
    return res.json({ ok: true, url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, err: String(err) });
  }
});

// HTTP fallback endpoint used pelo celular (/upload_photos)
app.post('/upload_photos', async (req, res) => {
  try {
    const { session, photos } = req.body || {};
    if (!session || !Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ ok: false, err: 'missing session or photos' });
    }
    ensureSession(session);
    const vid = uuidv4();
    const uploaded = [];
    if (IMGBB_KEY) {
      for (let i = 0; i < photos.length; i++) {
        try {
          if (typeof photos[i] === 'string' && photos[i].startsWith('data:')) {
            const u = await uploadToImgbbFromDataUrl(photos[i], `photo_${Date.now()}_${i}`);
            uploaded.push(u);
          } else {
            uploaded.push(photos[i]);
          }
        } catch (e) {
          console.warn('upload_photos partial upload error', e);
          uploaded.push(null);
        }
      }
    } else {
      uploaded.push(...photos);
    }
    sessions[session].viewers[vid] = { photos: uploaded.filter(Boolean), storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };

    // emit to session and viewer rooms
    io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
    io.to(`viewer:${vid}`).emit('viewer_photos_ready', {
      photos: sessions[session].viewers[vid].photos,
      storiesMontage: null,
      print: null,
      boomerang: null,
      createdAt: sessions[session].viewers[vid].createdAt
    });

    const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/, '')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;
    io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
    io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
    // also emit photos_ready for operator UI convenience
    io.to(`session:${session}`).emit('photos_ready', { session, uploaded: sessions[session].viewers[vid].photos, visualizadorUrl, storiesUrl: null, printUrl: null });

    return res.json({ ok: true, viewerId: vid, visualizadorUrl });
  } catch (err) {
    console.error('upload_photos error', err);
    return res.status(500).json({ ok: false, err: String(err) });
  }
});

io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id);

  // operator or other joins a session
  socket.on('join_session', ({ session, role }) => {
    if (!session) return;
    ensureSession(session);
    socket.join(`session:${session}`);
    socket.data.session = session;
    socket.data.role = role || 'operator';
    if (role === 'operator') sessions[session].operators.add(socket.id);
    // send last stream frame if exists
    const lastFrame = sessions[session].lastStreamFrame;
    if (lastFrame) socket.emit('stream_frame', { session, frame: lastFrame });
    console.log(`[socket] ${socket.id} joined session:${session} role=${socket.data.role}`);
  });

  // cellphone signals it's connected for a session (so we can push show_qr_on_viewer to it)
  socket.on('cell_connected', ({ session, id }) => {
    if (!session) return;
    ensureSession(session);
    socket.join(`session:${session}`);
    socket.data.session = session;
    socket.data.role = 'cell';
    console.log(`[socket] cell_connected ${socket.id} joined session:${session}`);
  });

  // viewer joins by viewerId (preferred) OR by session only (we attempt to pick the latest viewer for that session)
  socket.on('viewer_join', ({ session, viewerId, viewer }) => {
    // accept either viewerId or viewer param name
    const vid = viewerId || viewer;
    if (vid) {
      socket.join(`viewer:${vid}`);
      socket.data.viewerId = vid;
      // if stored, emit payload
      for (const sid of Object.keys(sessions)) {
        const v = sessions[sid].viewers[vid];
        if (v) {
          socket.emit('viewer_photos_ready', {
            session: sid,
            photos: v.photos || [],
            storiesMontage: v.storiesMontage || null,
            print: v.print || null,
            boomerang: v.boomerang || null,
            createdAt: v.createdAt
          });
          console.log(`[socket] viewer_join by id sent payload to ${socket.id} for viewer:${vid}`);
          return;
        }
      }
      // else nothing to send immediately
      console.log(`[socket] viewer_join (id) but no stored data for viewer:${vid}`);
      return;
    }

    // if no viewerId but session provided: attempt to pick the most recent viewer for that session
    if (session) {
      const s = sessions[session];
      if (!s) {
        console.log(`[socket] viewer_join for session:${session} but no session found`);
        return;
      }
      // find latest viewer by createdAt
      const viewers = s.viewers || {};
      const keys = Object.keys(viewers);
      if (keys.length === 0) {
        console.log(`[socket] viewer_join for session:${session} but no viewers yet`);
        return;
      }
      // pick the most recent createdAt
      let latestId = keys[0];
      let latestTs = viewers[latestId].createdAt || viewers[latestId].ts || 0;
      for (const k of keys) {
        const ts = viewers[k].createdAt || 0;
        if (ts > latestTs) {
          latestTs = ts;
          latestId = k;
        }
      }
      socket.join(`viewer:${latestId}`);
      socket.data.viewerId = latestId;
      const v = viewers[latestId];
      socket.emit('viewer_photos_ready', {
        session,
        photos: v.photos || [],
        storiesMontage: v.storiesMontage || null,
        print: v.print || null,
        boomerang: v.boomerang || null,
        createdAt: v.createdAt
      });
      console.log(`[socket] viewer_join for session:${session} -> joined viewer:${latestId} and delivered payload`);
      return;
    }
  });

  // stream frame from operator
  socket.on('stream_frame', ({ session, frame }) => {
    if (!session || !frame) return;
    ensureSession(session);
    sessions[session].lastStreamFrame = frame;
    io.to(`session:${session}`).emit('stream_frame', { session, frame });
  });

  // forward a ready photo from operator to viewer (used for high-res capture)
  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    try {
      if (viewerId) io.to(`viewer:${viewerId}`).emit('photo_ready', { session, index, photo });
      else if (session) io.to(`session:${session}`).emit('photo_ready', { session, index, photo });
    } catch (e) { console.warn('photo_ready forward error', e); }
  });

  // create viewer session: server stores and notifies viewer + operator
  socket.on('create_viewer_session', async (payload) => {
    try {
      let { session, photos, storiesMontage, print, boomerang } = payload || {};
      if (!session) session = 'cabine-fixa';
      ensureSession(session);
      const vid = uuidv4();

      // Prepare storage: attempt IMGBB uploads for any data: URLs if IMGBB_KEY present
      const storedPhotos = [];
      let storiesUrl = storiesMontage || null;
      let printUrl = print || null;

      if (Array.isArray(photos)) {
        for (let i = 0; i < photos.length; i++) {
          const p = photos[i];
          if (typeof p === 'string' && p.startsWith('data:') && IMGBB_KEY) {
            try {
              const u = await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i}`);
              storedPhotos.push(u);
            } catch (e) {
              console.warn('IMGBB upload photo failed', e);
              // fallback: push original dataURL so viewer can still view
              storedPhotos.push(p);
            }
          } else {
            storedPhotos.push(p);
          }
        }
      }

      if (storiesMontage && typeof storiesMontage === 'string' && storiesMontage.startsWith('data:') && IMGBB_KEY) {
        try {
          storiesUrl = await uploadToImgbbFromDataUrl(storiesMontage, `stories_${Date.now()}`);
        } catch (e) { console.warn('IMGBB upload stories failed', e); storiesUrl = storiesMontage; }
      } else {
        storiesUrl = storiesMontage;
      }

      if (print && typeof print === 'string' && print.startsWith('data:') && IMGBB_KEY) {
        try {
          printUrl = await uploadToImgbbFromDataUrl(print, `print_${Date.now()}`);
        } catch (e) { console.warn('IMGBB upload print failed', e); printUrl = print; }
      } else {
        printUrl = print;
      }

      // save to sessions structure
      sessions[session].viewers[vid] = {
        photos: storedPhotos.filter(Boolean),
        storiesMontage: storiesUrl || null,
        print: printUrl || null,
        boomerang: boomerang || null,
        createdAt: new Date().toISOString()
      };

      // emit ack and payloads
      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });

      const viewerPayload = {
        session,
        photos: sessions[session].viewers[vid].photos || [],
        storiesMontage: sessions[session].viewers[vid].storiesMontage || null,
        print: sessions[session].viewers[vid].print || null,
        boomerang: sessions[session].viewers[vid].boomerang || null,
        createdAt: sessions[session].viewers[vid].createdAt
      };

      // send to viewer room (if viewer connected)
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', viewerPayload);

      // craft canonical visualizador URL (with viewer id)
      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/, '')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;

      // notify the cell(s) and operator(s)
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });

      // convenience: also send photos_ready to operators (so index shows uploaded thumbs & visualizer QR)
      io.to(`session:${session}`).emit('photos_ready', {
        session,
        uploaded: sessions[session].viewers[vid].photos,
        visualizadorUrl,
        storiesUrl: sessions[session].viewers[vid].storiesMontage || null,
        printUrl: sessions[session].viewers[vid].print || null
      });

      console.log(`[create_viewer_session] session=${session} viewer=${vid} photos=${(storedPhotos||[]).length}`);
    } catch (err) {
      console.error('create_viewer_session error', err);
    }
  });

  // legacy flow: photos_submit (viewer sends raw dataURLs)
  socket.on('photos_submit', async ({ session, viewerId, photos }) => {
    try {
      if (!session) session = 'cabine-fixa';
      ensureSession(session);
      const vid = viewerId || uuidv4();
      const uploaded = [];

      if (Array.isArray(photos)) {
        for (let i = 0; i < photos.length; i++) {
          const p = photos[i];
          if (typeof p === 'string' && p.startsWith('data:') && IMGBB_KEY) {
            try {
              const u = await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i}`);
              uploaded.push(u);
            } catch (e) {
              console.warn('photos_submit imgbb upload failed', e);
              uploaded.push(p);
            }
          } else {
            uploaded.push(p);
          }
        }
      }

      sessions[session].viewers[vid] = { photos: uploaded.filter(Boolean), storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };

      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', { photos: sessions[session].viewers[vid].photos, storiesMontage: null, print: null, boomerang: null, createdAt: sessions[session].viewers[vid].createdAt });

      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/, '')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });

      // also notify operators with photos_ready
      io.to(`session:${session}`).emit('photos_ready', {
        session,
        uploaded: sessions[session].viewers[vid].photos,
        visualizadorUrl,
        storiesUrl: null,
        printUrl: null
      });

    } catch (err) {
      console.error('photos_submit error', err);
    }
  });

  // boomerang flow: accept dataUrl or videoUrl + optional previewFrame
  socket.on('boomerang_ready', async ({ session, viewerId, data, dataUrl, videoUrl, previewFrame }) => {
    try {
      if (!session) session = 'cabine-fixa';
      ensureSession(session);
      const vid = viewerId || uuidv4();

      let previewUrl = previewFrame || null;
      if (previewFrame && IMGBB_KEY && typeof previewFrame === 'string' && previewFrame.startsWith('data:')) {
        try { previewUrl = await uploadToImgbbFromDataUrl(previewFrame, `boom_preview_${Date.now()}`); } catch (e) { previewUrl = previewFrame; }
      }

      sessions[session].viewers[vid] = {
        photos: sessions[session].viewers[vid] ? sessions[session].viewers[vid].photos : [],
        storiesMontage: previewUrl,
        print: null,
        boomerang: videoUrl || data || dataUrl || null,
        createdAt: new Date().toISOString()
      };

      const viewerPayload = {
        session,
        photos: sessions[session].viewers[vid].photos || [],
        storiesMontage: previewUrl,
        print: null,
        boomerang: sessions[session].viewers[vid].boomerang || null,
        createdAt: sessions[session].viewers[vid].createdAt
      };

      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', viewerPayload);

      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/, '')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });

      // also operator convenience event
      io.to(`session:${session}`).emit('photos_ready', {
        session,
        uploaded: sessions[session].viewers[vid].photos || [],
        visualizadorUrl,
        storiesUrl: previewUrl,
        printUrl: null
      });
    } catch (err) {
      console.error('boomerang_ready error', err);
    }
  });

  // finalize/reset session (operator triggers)
  socket.on('finalize_session', ({ session }) => {
    if (!session) return;
    // notify cell(s) to return to welcome screen
    io.to(`session:${session}`).emit('finalize_session', { session });
    console.log('finalize_session for', session);
  });

  socket.on('reset_session', ({ session }) => {
    if (!session) return;
    io.to(`session:${session}`).emit('reset_session', { session });
    // optional: clear session storage
    if (sessions[session]) delete sessions[session];
    console.log('reset_session for', session);
  });

  socket.on('disconnect', () => {
    // cleanup operator socketId from sessions if present
    try {
      for (const sid of Object.keys(sessions)) {
        if (sessions[sid].operators && sessions[sid].operators.has(socket.id)) {
          sessions[sid].operators.delete(socket.id);
        }
      }
    } catch (e) { /* ignore */ }
    // console.log('[socket] disconnected', socket.id);
  });
});

server.listen(PORT, () => console.log('Server running on port', PORT));
