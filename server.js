// server.js
// Node >= 16+ recommended
// Replace IMGBB_KEY via env for production

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
// Use global fetch if available (Node 18+), otherwise fallback to node-fetch
let fetchFn = global.fetch;
try { if (!fetchFn) fetchFn = require('node-fetch'); } catch(e){ /* node-fetch not present */ }

const PORT = process.env.PORT || 3000;
const IMGBB_KEY = process.env.IMGBB_KEY || ''; // configure in env for uploads
const VISUALIZADOR_ORIGIN = (process.env.VISUALIZADOR_ORIGIN && process.env.VISUALIZADOR_ORIGIN.startsWith('http')) ?
  process.env.VISUALIZADOR_ORIGIN :
  (`https://festadodavi-production-0591.up.railway.app`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));
app.use(express.static(PUBLIC_DIR));

// uploads dir
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

// in-memory session store
// sessions[sessionId] = { viewers: { viewerId: { photos: [], storiesMontage, print, createdAt } }, operators: Set(socketId), lastStreamFrame }
const sessions = {};

function ensureSession(sessionId) {
  if (!sessionId) return null;
  if (!sessions[sessionId]) {
    sessions[sessionId] = { viewers: {}, operators: new Set(), lastStreamFrame: null, createdAt: new Date().toISOString() };
  }
  return sessions[sessionId];
}

// Helper: save a dataURL (data:image/..) to local uploads directory and return public URL
async function saveDataUrlToUploads(dataUrl, filenamePrefix = 'photo') {
  try {
    const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) throw new Error('Invalid data url');
    const mime = m[1];
    const b64 = m[2];
    const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
    const name = `${filenamePrefix}-${Date.now()}-${uuidv4()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, name);
    const buffer = Buffer.from(b64, 'base64');
    await fs.promises.writeFile(filePath, buffer);
    // return absolute public URL
    const publicUrl = `/uploads/${name}`;
    return publicUrl;
  } catch (e) {
    throw e;
  }
}

// Helper: upload to imgbb from dataURL (returns url string)
async function uploadToImgbbFromDataUrl(dataUrl, name) {
  if (!IMGBB_KEY) throw new Error('IMGBB_KEY not configured');
  if (!fetchFn) throw new Error('No fetch available for IMGBB upload');
  const parts = dataUrl.split(',');
  if (parts.length < 2) throw new Error('Invalid dataURL');
  const base64 = parts[1];
  const form = new URLSearchParams();
  form.append('key', IMGBB_KEY);
  form.append('image', base64);
  if (name) form.append('name', name);
  const res = await fetchFn('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const j = await res.json();
  if (j && j.success && j.data && (j.data.display_url || j.data.url)) return j.data.display_url || j.data.url;
  throw new Error('IMGBB upload failed: ' + JSON.stringify(j));
}

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), sessions: Object.keys(sessions).length });
});

// Redirect helper for visualizador
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
  const keys = Object.keys(s.viewers || {});
  html += `<div>Visualizadores: ${keys.length}</div>`;
  html += `</body></html>`;
  res.send(html);
});

/**
 * Unified handler used by both HTTP fallback and socket flow.
 * - creates viewerId immediately and stores placeholder
 * - uploads images (imgbb if key, otherwise save local)
 * - when upload finished, updates session store and emits to rooms
 */
async function handleIncomingPhotos({ session, photos = [], storiesMontage = null, print = null, viewerId: providedViewerId = null, socketOrigin = null }) {
  if (!session) session = 'cabine-fixa';
  ensureSession(session);
  const vid = providedViewerId || uuidv4();
  // store placeholder immediately so viewer join can find it
  sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
  // Emit immediate creation so operator UI knows a viewer started (fast)
  io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
  // Also, if socketOrigin provided, and is socket id, join that socket to viewer room? (caller side handles)
  // Now process uploads concurrently but do not block caller ack (caller should have received viewerId if socket ack flow used)
  // We'll attempt IMGBB uploads if key present, else save to uploads dir
  const maxPhotos = Math.min(3, photos.length || 0);
  const uploadedUrls = [];
  const photoTasks = [];
  for (let i = 0; i < maxPhotos; i++) {
    const p = photos[i];
    if (typeof p === 'string' && p.startsWith('data:')) {
      if (IMGBB_KEY) {
        // try upload to imgbb
        photoTasks.push((async () => {
          try {
            const url = await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i}`);
            return url;
          } catch (e) {
            // fallback to saving local
            try {
              const local = await saveDataUrlToUploads(p, `photo_${i}`);
              // convert to absolute URL (include origin)
              const origin = VISUALIZADOR_ORIGIN.replace(/\/+$/, '');
              return `${origin}${local}`;
            } catch (ee) {
              return null;
            }
          }
        })());
      } else {
        // save locally
        photoTasks.push((async () => {
          try {
            const local = await saveDataUrlToUploads(p, `photo_${i}`);
            const origin = VISUALIZADOR_ORIGIN.replace(/\/+$/, '');
            return `${origin}${local}`;
          } catch (e) {
            return null;
          }
        })());
      }
    } else if (typeof p === 'string' && p.startsWith('http')) {
      // already a URL (passed through)
      photoTasks.push(Promise.resolve(p));
    } else {
      photoTasks.push(Promise.resolve(null));
    }
  }

  // Also process storiesMontage and print if provided and dataURL
  const storyTask = (async () => {
    if (!storiesMontage) return null;
    if (typeof storiesMontage === 'string' && storiesMontage.startsWith('data:')) {
      if (IMGBB_KEY) {
        try {
          return await uploadToImgbbFromDataUrl(storiesMontage, `stories_${Date.now()}`);
        } catch (e) {
          try {
            const local = await saveDataUrlToUploads(storiesMontage, `stories`);
            return `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}${local}`;
          } catch (ee) { return null; }
        }
      } else {
        try {
          const local = await saveDataUrlToUploads(storiesMontage, `stories`);
          return `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}${local}`;
        } catch (e) { return null; }
      }
    } else if (typeof storiesMontage === 'string' && storiesMontage.startsWith('http')) {
      return storiesMontage;
    }
    return null;
  })();

  const printTask = (async () => {
    if (!print) return null;
    if (typeof print === 'string' && print.startsWith('data:')) {
      if (IMGBB_KEY) {
        try {
          return await uploadToImgbbFromDataUrl(print, `print_${Date.now()}`);
        } catch (e) {
          try {
            const local = await saveDataUrlToUploads(print, `print`);
            return `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}${local}`;
          } catch (ee) { return null; }
        }
      } else {
        try {
          const local = await saveDataUrlToUploads(print, `print`);
          return `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}${local}`;
        } catch (e) { return null; }
      }
    } else if (typeof print === 'string' && print.startsWith('http')) {
      return print;
    }
    return null;
  })();

  // run all uploads in parallel
  let settled = [];
  try {
    settled = await Promise.allSettled([Promise.all(photoTasks), storyTask, printTask]);
  } catch(e){
    // ignore — we'll handle results below
  }

  // parse results
  let photoResults = [];
  try {
    if (settled && settled.length >= 1 && settled[0].status === 'fulfilled') {
      photoResults = settled[0].value || [];
    } else if (Array.isArray(photos)) {
      // fallback: map original http urls
      photoResults = photos.slice(0, maxPhotos).map(p => (typeof p === 'string' && p.startsWith('http')) ? p : null);
    }
  } catch(e){ photoResults = []; }

  const storyUrl = (settled && settled[1] && settled[1].status === 'fulfilled') ? settled[1].value : null;
  const printUrl = (settled && settled[2] && settled[2].status === 'fulfilled') ? settled[2].value : null;

  // store final record
  sessions[session].viewers[vid] = {
    photos: photoResults.filter(Boolean),
    storiesMontage: storyUrl || null,
    print: printUrl || null,
    boomerang: null,
    createdAt: new Date().toISOString()
  };

  // craft visualizador URL (viewer-specific)
  const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;

  // emit to viewer room (if viewer connected)
  io.to(`viewer:${vid}`).emit('viewer_photos_ready', {
    session,
    viewerId: vid,
    photos: sessions[session].viewers[vid].photos,
    storiesMontage: sessions[session].viewers[vid].storiesMontage,
    print: sessions[session].viewers[vid].print,
    createdAt: sessions[session].viewers[vid].createdAt
  });

  // emit convenience events to operator/session
  io.to(`session:${session}`).emit('photos_ready', {
    session,
    uploaded: sessions[session].viewers[vid].photos,
    visualizadorUrl,
    storiesUrl: sessions[session].viewers[vid].storiesMontage || null,
    printUrl: sessions[session].viewers[vid].print || null
  });

  // Ask cell(s) to show QR / visualizer (so they display the QR AFTER server processed)
  io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
  io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });

  return { ok: true, viewerId: vid, visualizadorUrl };
}

// HTTP fallback endpoint used pelo celular (/upload_photos)
app.post('/upload_photos', async (req, res) => {
  try {
    const { session, photos } = req.body || {};
    if (!session || !Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ ok: false, err: 'missing session or photos' });
    }
    // create viewer quickly and respond with viewerId so client isn't waiting for uploads
    const vid = uuidv4();
    ensureSession(session);
    sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
    // immediate ack with viewerId and URL to visualizador (will be updated after upload)
    const previewVisualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;
    // respond quickly
    res.json({ ok:true, viewerId: vid, visualizadorUrl: previewVisualizadorUrl });

    // process uploads and emit when ready
    handleIncomingPhotos({ session, photos, viewerId: vid }).catch(err => {
      console.error('handleIncomingPhotos (http) error', err);
    });
  } catch (err) {
    console.error('upload_photos error', err);
    return res.status(500).json({ ok: false, err: String(err) });
  }
});

// Socket handlers and events
io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id);

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

  socket.on('cell_connected', ({ session, id }) => {
    if (!session) return;
    ensureSession(session);
    socket.join(`session:${session}`);
    socket.data.session = session;
    socket.data.role = 'cell';
    console.log(`[socket] cell_connected ${socket.id} joined session:${session}`);
  });

  // viewer joins by viewerId or session (server picks latest viewer)
  socket.on('viewer_join', ({ session, viewerId, viewer }) => {
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
            viewerId: vid,
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
      console.log(`[socket] viewer_join (id) but no stored data for viewer:${vid}`);
      return;
    }

    if (session) {
      const s = sessions[session];
      if (!s) {
        console.log(`[socket] viewer_join for session:${session} but no session found`);
        return;
      }
      const viewers = s.viewers || {};
      const keys = Object.keys(viewers);
      if (keys.length === 0) {
        console.log(`[socket] viewer_join for session:${session} but no viewers yet`);
        return;
      }
      // pick most recent by createdAt
      let latestId = keys[0];
      let latestTs = viewers[latestId].createdAt || 0;
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
        viewerId: latestId,
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

  // photos_from_cell (socket flow) - accept payload of photos (dataURLs or URLs)
  socket.on('photos_from_cell', async (payload, ack) => {
    try {
      const { session, photos, viewerId } = payload || {};
      const sess = session || 'cabine-fixa';
      // immediate create viewer id and ack quickly
      const vid = viewerId || uuidv4();
      ensureSession(sess);
      sessions[sess].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
      // emit quick creation to operators
      io.to(`session:${sess}`).emit('viewer_session_created', { viewerId: vid });
      // ack if provided
      try { if (typeof ack === 'function') ack(null, { ok:true, viewerId: vid }); } catch(e){}
      // process and upload in background then notify when ready
      handleIncomingPhotos({ session: sess, photos: photos || [], viewerId: vid }).catch(err => {
        console.error('handleIncomingPhotos (socket) error', err);
      });
    } catch (err) {
      console.error('photos_from_cell handler error', err);
      try { if (typeof ack === 'function') ack(err); } catch(e){}
    }
  });

  // legacy: photos_submit (same processing)
  socket.on('photos_submit', async (payload, ack) => {
    try {
      const { session, photos, viewerId } = payload || {};
      const sess = session || 'cabine-fixa';
      const vid = viewerId || uuidv4();
      ensureSession(sess);
      // ack early
      try { if (typeof ack === 'function') ack(null, { ok:true, viewerId: vid }); } catch(e){}
      // process
      handleIncomingPhotos({ session: sess, photos: photos || [], viewerId: vid }).catch(err => console.error('photos_submit flow error', err));
    } catch (err) {
      console.error('photos_submit handler error', err);
      try { if (typeof ack === 'function') ack(err); } catch(e){}
    }
  });

  // create_viewer_session: server-side flow triggered by operator (accepts photos or urls)
  socket.on('create_viewer_session', async (payload) => {
    try {
      await handleIncomingPhotos(payload);
    } catch (e) {
      console.error('create_viewer_session error', e);
    }
  });

  // boomerang/video flow
  socket.on('boomerang_ready', async ({ session, viewerId, data, dataUrl, videoUrl, previewFrame }) => {
    try {
      const sess = session || 'cabine-fixa';
      ensureSession(sess);
      const vid = viewerId || uuidv4();
      // handle preview frame upload optionally
      let previewUrl = previewFrame || null;
      if (previewFrame && typeof previewFrame === 'string' && previewFrame.startsWith('data:')) {
        if (IMGBB_KEY) {
          try { previewUrl = await uploadToImgbbFromDataUrl(previewFrame, `boom_preview_${Date.now()}`); } catch(e) { previewUrl = await saveDataUrlToUploads(previewFrame, 'boom_preview').then(p => `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}${p}`).catch(()=> previewFrame); }
        } else {
          previewUrl = await saveDataUrlToUploads(previewFrame, 'boom_preview').then(p => `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}${p}`).catch(()=> previewFrame);
        }
      }
      // update or create viewer record
      sessions[sess].viewers[vid] = sessions[sess].viewers[vid] || { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
      sessions[sess].viewers[vid].boomerang = videoUrl || data || dataUrl || null;
      sessions[sess].viewers[vid].storiesMontage = previewUrl || sessions[sess].viewers[vid].storiesMontage || null;
      sessions[sess].viewers[vid].createdAt = new Date().toISOString();
      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', {
        session: sess,
        viewerId: vid,
        photos: sessions[sess].viewers[vid].photos || [],
        storiesMontage: sessions[sess].viewers[vid].storiesMontage || null,
        print: sessions[sess].viewers[vid].print || null,
        boomerang: sessions[sess].viewers[vid].boomerang || null,
        createdAt: sessions[sess].viewers[vid].createdAt
      });
      io.to(`session:${sess}`).emit('boomerang_ready', { session: sess, videoUrl: sessions[sess].viewers[vid].boomerang, visualizadorUrl });
      io.to(`session:${sess}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
    } catch (e) {
      console.error('boomerang_ready error', e);
    }
  });

  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    try {
      if (viewerId) io.to(`viewer:${viewerId}`).emit('photo_ready', { session, index, photo });
      else if (session) io.to(`session:${session}`).emit('photo_ready', { session, index, photo });
    } catch (e) { console.warn('photo_ready forward error', e); }
  });

  socket.on('finalize_session', ({ session }) => {
    if (!session) return;
    io.to(`session:${session}`).emit('finalize_session', { session });
    console.log('finalize_session for', session);
  });

  socket.on('reset_session', ({ session }) => {
    if (!session) return;
    io.to(`session:${session}`).emit('reset_session', { session });
    // optionally clear session storage
    if (sessions[session]) delete sessions[session];
    console.log('reset_session for', session);
  });

  socket.on('disconnect', () => {
    try {
      for (const sid of Object.keys(sessions)) {
        if (sessions[sid].operators && sessions[sid].operators.has(socket.id)) {
          sessions[sid].operators.delete(socket.id);
        }
      }
    } catch (e) { /* ignore */ }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
