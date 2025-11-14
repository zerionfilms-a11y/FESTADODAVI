// server.js (SUBSTITUA PELO SEU ATUAL)
// Node >= 16+ recommended
// Configure IMGBB_KEY via env for production

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

// Simple CORS headers for endpoints called directly from the client (index)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// uploads dir + viewers persistence dir
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VIEWERS_DIR = path.join(UPLOADS_DIR, 'viewers');
if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch(e){ console.error('Failed to create uploads dir', e); }
}
if (!fs.existsSync(VIEWERS_DIR)) {
  try { fs.mkdirSync(VIEWERS_DIR, { recursive: true }); } catch(e){ console.error('Failed to create viewers dir', e); }
}
app.use('/uploads', express.static(UPLOADS_DIR));

// in-memory session store
// sessions[sessionId] = { viewers: { viewerId: { photos: [], storiesMontage, print, boomerang, createdAt } }, operators: Set(socketId), lastStreamFrame }
const sessions = {};

// global viewersStore for easy viewerId lookup and persistence
// viewersStore[viewerId] = { session, photos, storiesMontage, print, boomerang, createdAt }
const viewersStore = {};

// load persisted viewers on startup (if any)
function loadPersistedViewers() {
  try {
    const files = fs.readdirSync(VIEWERS_DIR);
    files.forEach(f => {
      if (!f.endsWith('.json')) return;
      try {
        const full = path.join(VIEWERS_DIR, f);
        const raw = fs.readFileSync(full, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.viewerId) {
          viewersStore[data.viewerId] = data;
        }
      } catch (e) { console.warn('failed loading viewer file', f, e.message); }
    });
    console.log(`[server] loaded ${Object.keys(viewersStore).length} persisted viewers`);
  } catch (e) {
    console.warn('no persisted viewers found or error reading viewers dir', e && e.message);
  }
}
loadPersistedViewers();

// helper: persist single viewer to disk (atomic)
async function persistViewer(viewerId) {
  try {
    if (!viewersStore[viewerId]) return;
    const outPath = path.join(VIEWERS_DIR, `${viewerId}.json`);
    const tmpPath = outPath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(viewersStore[viewerId], null, 2), 'utf8');
    await fs.promises.rename(tmpPath, outPath);
  } catch (e) {
    console.error('persistViewer error', e && e.message ? e.message : e);
  }
}

// cleanup job: remove viewers older than retentionMs
const VIEWER_RETENTION_MS = (process.env.VIEWER_RETENTION_HOURS ? Number(process.env.VIEWER_RETENTION_HOURS) : 24) * 3600 * 1000;
async function cleanupOldViewers() {
  try {
    const now = Date.now();
    const keys = Object.keys(viewersStore);
    for (const k of keys) {
      const v = viewersStore[k];
      if (!v || !v.createdAt) continue;
      const created = new Date(v.createdAt).getTime();
      if (!created) continue;
      if (now - created > VIEWER_RETENTION_MS) {
        // delete from memory and disk
        delete viewersStore[k];
        const p = path.join(VIEWERS_DIR, `${k}.json`);
        try { if (fs.existsSync(p)) await fs.promises.unlink(p); } catch(e){}
        console.log(`[cleanup] removed viewer ${k}`);
      }
    }
  } catch (e) {
    console.error('cleanupOldViewers error', e);
  }
}
// schedule hourly
setInterval(cleanupOldViewers, 60 * 60 * 1000);

// Ensure session object exists
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
    const origin = VISUALIZADOR_ORIGIN.replace(/\/+$/, '');
    const publicUrl = `${origin}/uploads/${name}`;
    return publicUrl;
  } catch (e) {
    throw new Error('saveDataUrlToUploads error: ' + (e && e.message ? e.message : e));
  }
}

// Helper: upload to imgbb from dataURL (returns url string)
async function uploadToImgbbFromDataUrl(dataUrl, name) {
  if (!IMGBB_KEY) throw new Error('IMGBB_KEY not configured');
  if (!fetchFn) throw new Error('No fetch available for IMGBB upload');

  const parts = dataUrl.split(',');
  if (parts.length < 2) throw new Error('Invalid dataURL');
  const base64 = parts[1];

  const body = new URLSearchParams();
  body.append('key', IMGBB_KEY);
  body.append('image', base64);
  if (name) body.append('name', name);

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
  res.json({ ok: true, time: new Date().toISOString(), sessions: Object.keys(sessions).length, viewers: Object.keys(viewersStore).length });
});

// API: Return viewer data (used by visualizador.html to fetch by viewerId)
app.get('/api/viewer/:viewerId', (req, res) => {
  const vid = req.params.viewerId;
  if (!vid) return res.status(400).json({ ok:false, err:'missing viewerId' });
  const v = viewersStore[vid];
  if (!v) return res.status(404).json({ ok:false, err:'viewer not found' });
  return res.json({ ok:true, viewer: v });
});

// Redirect helper for visualizador (keeps compatibility if someone links /visualizador/<viewerId>)
app.get('/visualizador/:viewerId', (req, res) => {
  const viewerId = req.params.viewerId;
  const staticVizPath = path.join(PUBLIC_DIR, 'visualizador.html');
  if (fs.existsSync(staticVizPath)) {
    const redirectUrl = `/visualizador.html?session=${encodeURIComponent(viewerId)}`;
    return res.redirect(302, redirectUrl);
  }
  const v = viewersStore[viewerId];
  if (!v) return res.status(404).send('<h2>Visualizador - viewer não encontrado</h2>');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Visualizador - ${viewerId}</title></head><body style="background:#000;color:#fff;font-family:Arial;padding:12px">
  <h2>Visualizador — Viewer: ${viewerId}</h2>
  <pre>${JSON.stringify(v, null, 2)}</pre>
  </body></html>`;
  res.send(html);
});

// Endpoint for client to ask server to upload provided dataURLs to IMGBB
app.post('/upload-to-imgbb', async (req, res) => {
  try {
    const { photos, montage } = req.body || {};
    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ ok:false, err: 'missing photos array' });
    }
    // ensure up to 3
    const p3 = photos.slice(0,3);
    const resultUrls = {};
    // upload photos in series to avoid hitting remote limits
    for (let i = 0; i < p3.length; i++) {
      const p = p3[i];
      try {
        if (typeof p === 'string' && p.startsWith('data:')) {
          const url = (IMGBB_KEY && fetchFn) ? await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i+1}`) : await saveDataUrlToUploads(p, `photo_${i+1}`);
          resultUrls[`photo${i+1}`] = url;
        } else if (typeof p === 'string' && /^https?:\/\//i.test(p)) {
          resultUrls[`photo${i+1}`] = p;
        } else {
          resultUrls[`photo${i+1}`] = null;
        }
      } catch (e) {
        console.warn('upload-to-imgbb photo upload failed for index', i, e && e.message);
        resultUrls[`photo${i+1}`] = null;
      }
    }
    // montage
    if (montage && typeof montage === 'string' && montage.startsWith('data:')) {
      try {
        const murl = (IMGBB_KEY && fetchFn) ? await uploadToImgbbFromDataUrl(montage, `montage_${Date.now()}`) : await saveDataUrlToUploads(montage, `montage`);
        resultUrls.montage = murl;
      } catch (e) {
        console.warn('upload-to-imgbb montage upload failed', e && e.message);
        resultUrls.montage = null;
      }
    } else if (montage && typeof montage === 'string') {
      resultUrls.montage = montage;
    } else {
      resultUrls.montage = null;
    }

    return res.json({ ok:true, urls: resultUrls });
  } catch (err) {
    console.error('/upload-to-imgbb error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok:false, err: String(err) });
  }
});

/**
 * Unified handler used by both HTTP fallback and socket flow.
 * - creates viewerId immediately and stores placeholder
 * - uploads images (imgbb if key, otherwise save local)
 * - when upload finished, updates session store, persist viewer to disk and emits to rooms
 */
async function handleIncomingPhotos({ session, photos = [], storiesMontage = null, print = null, viewerId: providedViewerId = null, socketOrigin = null }) {
  if (!session) session = 'cabine-fixa';
  ensureSession(session);
  const vid = providedViewerId || uuidv4();

  // store placeholder immediately so viewer join can find it
  sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };

  // Emit immediate creation so operator UI knows a viewer started (fast)
  try {
    io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
  } catch (e) {
    console.warn('emit viewer_session_created failed', e);
  }

  // Process up to first 3 photos
  const maxPhotos = Math.min(3, (photos && photos.length) ? photos.length : 0);
  const photoTasks = [];

  for (let i = 0; i < maxPhotos; i++) {
    const p = photos[i];
    if (typeof p === 'string' && p.startsWith('data:')) {
      // dataURL -> upload to IMGBB or save locally
      photoTasks.push((async () => {
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
      photoResults = (photos || []).slice(0, maxPhotos).map(p => (typeof p === 'string' && /^https?:\/\//i.test(p)) ? p : null);
    }
  } catch (e) {
    photoResults = [];
  }

  const storyUrl = (results && results[1] && results[1].status === 'fulfilled') ? results[1].value : null;
  const printUrl = (results && results[2] && results[2].status === 'fulfilled') ? results[2].value : null;

  const finalPhotos = (photoResults || []).filter(Boolean).slice(0,3);
  const nowIso = new Date().toISOString();

  // store final record in session view
  sessions[session].viewers[vid] = {
    photos: finalPhotos,
    storiesMontage: storyUrl || null,
    print: printUrl || null,
    boomerang: null,
    createdAt: nowIso
  };

  // also store globally for visualizador lookup and persist to disk
  viewersStore[vid] = {
    viewerId: vid,
    session,
    photos: finalPhotos,
    storiesMontage: storyUrl || null,
    print: printUrl || null,
    boomerang: null,
    createdAt: nowIso
  };
  // persist (async, fire and forget)
  persistViewer(vid).catch(e => console.warn('persistViewer failed', e && e.message));

  const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;

  // emit to viewer room (if any)
  try {
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

  // emit convenience events to operator/session
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

  // Ask cell(s) to show QR / visualizer
  try {
    io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
    io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
  } catch (e) {
    console.warn('emit show_qr_on_viewer/show_qr failed', e);
  }

  logServer(`handleIncomingPhotos: finished session=${session} viewer=${vid} photos=${finalPhotos.length} stories=${Boolean(storyUrl)} print=${Boolean(printUrl)}`);

  return { ok: true, viewerId: vid, visualizadorUrl };
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
    sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
    const previewVisualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;
    // respond quickly
    res.json({ ok:true, viewerId: vid, visualizadorUrl: previewVisualizadorUrl });

    // process uploads and emit when ready, run async
    handleIncomingPhotos({ session, photos, viewerId: vid }).catch(err => {
      console.error('handleIncomingPhotos (http) error', err && err.stack ? err.stack : err);
    });
  } catch (err) {
    console.error('upload_photos error', err && err.stack ? err.stack : err);
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
      const stored = viewersStore[vid];
      if (stored) {
        socket.emit('viewer_photos_ready', {
          session: stored.session || session,
          viewerId: vid,
          photos: stored.photos || [],
          storiesMontage: stored.storiesMontage || null,
          print: stored.print || null,
          boomerang: stored.boomerang || null,
          createdAt: stored.createdAt
        });
        console.log(`[socket] viewer_join by id sent persisted payload to ${socket.id} for viewer:${vid}`);
        return;
      }
      // fallback to search in sessions
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
          console.log(`[socket] viewer_join by id sent payload to ${socket.id} for viewer:${vid} (from sessions store)`);
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
      // emit quick creation to operators
      io.to(`session:${sess}`).emit('viewer_session_created', { viewerId: vid });
      // ack if provided
      try { if (typeof ack === 'function') ack(null, { ok:true, viewerId: vid }); } catch(e){}
      // process and upload then notify when ready
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

      // persist global viewersStore
      viewersStore[vid] = {
        viewerId: vid,
        session: sess,
        photos: sessions[sess].viewers[vid].photos || [],
        storiesMontage: sessions[sess].viewers[vid].storiesMontage || null,
        print: sessions[sess].viewers[vid].print || null,
        boomerang: sessions[sess].viewers[vid].boomerang || null,
        createdAt: sessions[sess].viewers[vid].createdAt
      };
      persistViewer(vid).catch(()=>{});

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

  // finalize_session: do not delete persisted viewers; just notify UI
  socket.on('finalize_session', ({ session }) => {
    if (!session) return;
    io.to(`session:${session}`).emit('finalize_session', { session });
    console.log('finalize_session for', session);
  });

  // reset_session: emit reset and clear in-memory sessions but do NOT delete persisted viewers
  socket.on('reset_session', ({ session }) => {
    if (!session) return;
    io.to(`session:${session}`).emit('reset_session', { session });
    // delete in-memory session (operators/lastFrame), but keep persisted viewers in viewersStore
    if (sessions[session]) {
      // keep viewers data persisted — do not delete viewersStore entries
      delete sessions[session];
    }
    console.log('reset_session for', session, '(in-memory cleared; persisted viewers kept)');
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
