// server.js
// Node >= 16+ recommended
// Replace IMGBB_KEY via env for production

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// fetch compatibility: prefer global.fetch (Node 18+), otherwise try node-fetch (v2 or v3)
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    const nf = require('node-fetch');
    // node-fetch v3 exports default; v2 exports function directly
    fetchFn = nf.default || nf;
  } catch (e) {
    fetchFn = null;
    console.warn('fetch not available (global.fetch not present and node-fetch not installed). IMGBB uploads will fail.');
  }
}

// Provide AbortController if missing (node < 15)
let AbortControllerLocal = global.AbortController;
if (!AbortControllerLocal) {
  try {
    const ac = require('abort-controller');
    AbortControllerLocal = ac;
  } catch (e) {
    AbortControllerLocal = null;
  }
}

const PORT = process.env.PORT || 3000;
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // configure in env for uploads
const VISUALIZADOR_ORIGIN = (process.env.VISUALIZADOR_ORIGIN && process.env.VISUALIZADOR_ORIGIN.startsWith('http')) ?
  process.env.VISUALIZADOR_ORIGIN :
  (`https://festadodavi-production-0591.up.railway.app`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true, limit: '120mb' }));
app.use(express.static(PUBLIC_DIR));

// uploads dir
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create uploads dir', e);
    // continue — write operations will fail later and be logged
  }
}
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

// Helper: save a dataURL (data:image/..) to local uploads directory and return public absolute URL
async function saveDataUrlToUploads(dataUrl, filenamePrefix = 'photo') {
  try {
    const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) throw new Error('Invalid data url');
    const mime = m[1];
    const b64 = m[2];
    const extRaw = mime.split('/')[1];
    const ext = (extRaw === 'jpeg') ? 'jpg' : extRaw.replace(/[^a-z0-9]/gi,'');
    const name = `${filenamePrefix}-${Date.now()}-${uuidv4()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, name);
    const buffer = Buffer.from(b64, 'base64');
    await fs.promises.writeFile(filePath, buffer);
    // return absolute public URL including origin so callers don't have to guess
    const origin = VISUALIZADOR_ORIGIN.replace(/\/+$/, '');
    const publicUrl = `${origin}/uploads/${name}`;
    return publicUrl;
  } catch (e) {
    // bubble up with context
    throw new Error('saveDataUrlToUploads error: ' + (e && e.message ? e.message : e));
  }
}

// Helper: upload to imgbb from dataURL (returns url string)
async function uploadToImgbbFromDataUrl(dataUrl, name) {
  if (!IMGBB_KEY) throw new Error('IMGBB_KEY not configured');
  if (!fetchFn) throw new Error('No fetch available for IMGBB upload');

  // Use URLSearchParams (imgbb accepts urlencoded or multipart)
  const parts = dataUrl.split(',');
  if (parts.length < 2) throw new Error('Invalid dataURL');
  const base64 = parts[1];

  const body = new URLSearchParams();
  body.append('key', IMGBB_KEY);
  body.append('image', base64);
  if (name) body.append('name', name);

  // try with AbortController if available
  const controller = AbortControllerLocal ? new AbortControllerLocal() : null;
  const signal = controller ? controller.signal : undefined;
  const timeout = controller ? setTimeout(()=>controller.abort(), 25000) : null;

  try {
    const res = await fetchFn('https://api.imgbb.com/1/upload', { method: 'POST', body, signal });
    if (timeout) clearTimeout(timeout);
    const j = await res.json();
    if (j && j.success && j.data && (j.data.display_url || j.data.url)) return j.data.display_url || j.data.url;
    throw new Error('IMGBB upload failed: ' + JSON.stringify(j));
  } catch (e) {
    if (timeout) try{ clearTimeout(timeout) }catch(_){} 
    throw new Error('uploadToImgbbFromDataUrl error: ' + (e && e.message ? e.message : e));
  }
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
 * - creates viewerId
 * - uploads images (imgbb if key, otherwise save local)
 * - waits for montage upload to finish BEFORE emitting visualizer events
 */
async function handleIncomingPhotos({ session, photos = [], storiesMontage = null, print = null, viewerId: providedViewerId = null, socketOrigin = null }) {
  if (!session) session = 'cabine-fixa';
  ensureSession(session);
  const vid = providedViewerId || uuidv4();

  // store placeholder immediately so viewer join can find it (but do NOT emit visualizer yet)
  sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };

  logServer(`handleIncomingPhotos: starting session=${session} viewer=${vid}`);

  // Process up to first 3 photos
  const maxPhotos = Math.min(3, (photos && photos.length) ? photos.length : 0);
  const photoTasks = [];

  for (let i = 0; i < maxPhotos; i++) {
    const p = photos[i];
    if (typeof p === 'string' && p.startsWith('data:')) {
      // dataURL -> upload to IMGBB or save locally
      photoTasks.push((async () => {
        // prefer IMGBB
        if (IMGBB_KEY && fetchFn) {
          try {
            const url = await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i}`);
            return url;
          } catch (e) {
            console.warn('IMGBB upload failed for photo index', i, e && e.message ? e.message : e);
            try {
              const local = await saveDataUrlToUploads(p, `photo_${i}`);
              return local;
            } catch (ee) {
              console.error('fallback saveDataUrlToUploads failed', ee);
              return null;
            }
          }
        } else {
          // save locally
          try {
            const local = await saveDataUrlToUploads(p, `photo_${i}`);
            return local;
          } catch (e) {
            console.error('saveDataUrlToUploads failed', e);
            return null;
          }
        }
      })());
    } else if (typeof p === 'string' && /^https?:\/\//i.test(p)) {
      // already remote URL - keep as-is
      photoTasks.push(Promise.resolve(p));
    } else {
      photoTasks.push(Promise.resolve(null));
    }
  }

  // stories and print tasks
  const storyTask = (async () => {
    if (!storiesMontage) return null;
    if (typeof storiesMontage === 'string' && storiesMontage.startsWith('data:')) {
      if (IMGBB_KEY && fetchFn) {
        try {
          return await uploadToImgbbFromDataUrl(storiesMontage, `stories_${Date.now()}`);
        } catch (e) {
          console.warn('IMGBB stories upload failed, saving local...', e && e.message ? e.message : e);
          try {
            const local = await saveDataUrlToUploads(storiesMontage, `stories`);
            return local;
          } catch (ee) {
            console.error('saveDataUrlToUploads for stories failed', ee);
            return null;
          }
        }
      } else {
        try {
          const local = await saveDataUrlToUploads(storiesMontage, `stories`);
          return local;
        } catch (e) {
          console.error('saveDataUrlToUploads for stories failed', e);
          return null;
        }
      }
    } else if (typeof storiesMontage === 'string' && /^https?:\/\//i.test(storiesMontage)) {
      return storiesMontage;
    }
    return null;
  })();

  const printTask = (async () => {
    if (!print) return null;
    if (typeof print === 'string' && print.startsWith('data:')) {
      if (IMGBB_KEY && fetchFn) {
        try {
          return await uploadToImgbbFromDataUrl(print, `print_${Date.now()}`);
        } catch (e) {
          console.warn('IMGBB print upload failed, saving local...', e && e.message ? e.message : e);
          try {
            const local = await saveDataUrlToUploads(print, `print`);
            return local;
          } catch (ee) {
            console.error('saveDataUrlToUploads for print failed', ee);
            return null;
          }
        }
      } else {
        try {
          const local = await saveDataUrlToUploads(print, `print`);
          return local;
        } catch (e) {
          console.error('saveDataUrlToUploads for print failed', e);
          return null;
        }
      }
    } else if (typeof print === 'string' && /^https?:\/\//i.test(print)) {
      return print;
    }
    return null;
  })();

  // run uploads in parallel and wait
  logServer(`handleIncomingPhotos: starting upload tasks for session=${session} viewer=${vid} photos=${maxPhotos}`);
  let results;
  try {
    results = await Promise.allSettled([ Promise.all(photoTasks), storyTask, printTask ]);
  } catch (e) {
    console.error('parallel upload error', e);
    results = [];
  }

  // parse results
  let photoResults = [];
  try {
    if (results && results.length >= 1 && results[0].status === 'fulfilled') {
      photoResults = Array.isArray(results[0].value) ? results[0].value : [];
    } else {
      // fallback: try to map original http urls
      photoResults = (photos || []).slice(0, maxPhotos).map(p => (typeof p === 'string' && /^https?:\/\//i.test(p)) ? p : null);
    }
  } catch (e) {
    photoResults = [];
  }

  const storyUrl = (results && results[1] && results[1].status === 'fulfilled') ? results[1].value : null;
  const printUrl = (results && results[2] && results[2].status === 'fulfilled') ? results[2].value : null;

  // store final record (filter out nulls)
  const finalPhotos = (photoResults || []).filter(Boolean).slice(0,3);
  sessions[session].viewers[vid] = {
    photos: finalPhotos,
    storiesMontage: storyUrl || null,
    print: printUrl || null,
    boomerang: null,
    createdAt: new Date().toISOString()
  };

  const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;

  // Now: emit events AFTER uploads finish and we have storyUrl (or null)
  try {
    // emit to viewer room
    io.to(`viewer:${vid}`).emit('viewer_photos_ready', {
      session,
      viewerId: vid,
      photos: sessions[session].viewers[vid].photos,
      storiesMontage: sessions[session].viewers[vid].storiesMontage,
      print: sessions[session].viewers[vid].print,
      createdAt: sessions[session].viewers[vid].createdAt
    });
  } catch (e) {
    console.warn('emit viewer_photos_ready failed', e);
  }

  // emit convenience events to operator/session, include storiesUrl if available
  try {
    io.to(`session:${session}`).emit('photos_ready', {
      session,
      uploaded: sessions[session].viewers[vid].photos,
      visualizadorUrl,
      storiesUrl: sessions[session].viewers[vid].storiesMontage || null,
      printUrl: sessions[session].viewers[vid].print || null
    });
  } catch (e) {
    console.warn('emit photos_ready failed', e);
  }

  // create viewer session created event AFTER uploads (so operator won't prematurely show visualizer)
  try {
    io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
  } catch (e) {
    console.warn('emit viewer_session_created failed', e);
  }

  // Ask cell(s) to show QR / visualizer (so they display the QR AFTER server processed)
  try {
    io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
    io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
  } catch (e) {
    console.warn('emit show_qr_on_viewer/show_qr failed', e);
  }

  logServer(`handleIncomingPhotos: finished session=${session} viewer=${vid} photos=${finalPhotos.length} stories=${Boolean(storyUrl)} print=${Boolean(printUrl)}`);

  return { ok: true, viewerId: vid, visualizadorUrl, storiesUrl: storyUrl || null };
}

// simple server-side log helper
function logServer(msg) {
  console.log(`[server ${new Date().toISOString()}] ${msg}`);
}

// HTTP fallback endpoint used pelo celular (/upload_photos)
app.post('/upload_photos', async (req, res) => {
  try {
    const { session, photos } = req.body || {};
    if (!session || !Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ ok: false, err: 'missing session or photos' });
    }
    const vid = uuidv4();
    ensureSession(session);
    // respond quickly to cellphone with preview visualizer (server will process and produce final visualizer later)
    const previewVisualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;
    res.json({ ok:true, viewerId: vid, visualizadorUrl: previewVisualizadorUrl });

    // process uploads and emit when ready (this will complete uploads and then emit definitive events)
    handleIncomingPhotos({ session, photos, viewerId: vid }).catch(err => {
      console.error('handleIncomingPhotos (http) error', err && err.stack ? err.stack : err);
    });
  } catch (err) {
    console.error('upload_photos error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, err: String(err) });
  }
});

// New JSON endpoint: accept { photos: [...], montage: dataURLOrUrl } -> upload using server IMGBB_KEY if configured
// This avoids multipart and busboy issues for browser-origin POSTs.
app.post('/upload-to-imgbb', async (req, res) => {
  // CORS header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(200);

  try {
    const { photos, montage } = req.body || {};
    if ((!photos || !Array.isArray(photos) || photos.length === 0) && !montage) {
      return res.status(400).json({ ok:false, err: 'missing photos and montage' });
    }

    // We'll attempt to upload montage and return urls mapping
    const result = { ok: true, urls: {} };

    // upload montage first (so operator can wait on it)
    if (montage && typeof montage === 'string') {
      if (montage.startsWith('data:')) {
        try {
          if (IMGBB_KEY && fetchFn) {
            const u = await uploadToImgbbFromDataUrl(montage, `stories_${Date.now()}`);
            result.urls.montage = u;
          } else {
            const local = await saveDataUrlToUploads(montage, 'stories');
            result.urls.montage = local;
          }
        } catch (e) {
          console.warn('/upload-to-imgbb montage upload failed', e && e.message ? e.message : e);
          // still continue, montage maybe null
          result.urls.montage = null;
        }
      } else if (/^https?:\/\//i.test(montage)) {
        result.urls.montage = montage;
      }
    }

    // upload photos (keep order)
    for (let i = 0; i < Math.min(3, (photos || []).length); i++) {
      const p = photos[i];
      try {
        if (typeof p === 'string' && p.startsWith('data:')) {
          if (IMGBB_KEY && fetchFn) {
            const u = await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i+1}`);
            result.urls[`photo${i+1}`] = u;
          } else {
            const local = await saveDataUrlToUploads(p, `photo_${i+1}`);
            result.urls[`photo${i+1}`] = local;
          }
        } else if (typeof p === 'string' && /^https?:\/\//i.test(p)) {
          result.urls[`photo${i+1}`] = p;
        } else {
          result.urls[`photo${i+1}`] = null;
        }
      } catch (e) {
        console.warn('/upload-to-imgbb photo upload failed for index', i, e && e.message ? e.message : e);
        result.urls[`photo${i+1}`] = null;
      }
    }

    return res.json(result);
  } catch (e) {
    console.error('/upload-to-imgbb error', e && e.stack ? e.stack : e);
    return res.status(500).json({ ok:false, err: String(e) });
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
      // ack if provided
      try { if (typeof ack === 'function') ack(null, { ok:true, viewerId: vid }); } catch(e){}
      // process and upload (this function will wait for montage upload before emitting visualizer events)
      handleIncomingPhotos({ session: sess, photos: photos || [], viewerId: vid }).catch(err => {
        console.error('handleIncomingPhotos (socket) error', err && err.stack ? err.stack : err);
      });
    } catch (err) {
      console.error('photos_from_cell handler error', err && err.stack ? err.stack : err);
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
      try { if (typeof ack === 'function') ack(null, { ok:true, viewerId: vid }); } catch(e){}
      handleIncomingPhotos({ session: sess, photos: photos || [], viewerId: vid }).catch(err => console.error('photos_submit flow error', err && err.stack ? err.stack : err));
    } catch (err) {
      console.error('photos_submit handler error', err && err.stack ? err.stack : err);
      try { if (typeof ack === 'function') ack(err); } catch(e){}
    }
  });

  // create_viewer_session: server-side flow triggered by operator (accepts photos or urls)
  socket.on('create_viewer_session', async (payload) => {
    try {
      await handleIncomingPhotos(payload);
    } catch (e) {
      console.error('create_viewer_session error', e && e.stack ? e.stack : e);
    }
  });

  // boomerang/video flow
  socket.on('boomerang_ready', async ({ session, viewerId, data, dataUrl, videoUrl, previewFrame }) => {
    try {
      const sess = session || 'cabine-fixa';
      ensureSession(sess);
      const vid = viewerId || uuidv4();
      let previewUrl = previewFrame || null;
      if (previewFrame && typeof previewFrame === 'string' && previewFrame.startsWith('data:')) {
        if (IMGBB_KEY && fetchFn) {
          try { previewUrl = await uploadToImgbbFromDataUrl(previewFrame, `boom_preview_${Date.now()}`); } catch(e) { previewUrl = await saveDataUrlToUploads(previewFrame, 'boom_preview').catch(()=> previewFrame); }
        } else {
          previewUrl = await saveDataUrlToUploads(previewFrame, 'boom_preview').catch(()=> previewFrame);
        }
      }
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
      console.error('boomerang_ready error', e && e.stack ? e.stack : e);
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
