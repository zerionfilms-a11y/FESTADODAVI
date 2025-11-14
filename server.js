// server.js - FESTADODAVI (versão revisada / compatível / preservando funções)
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
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));
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
      // already remote URL
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
    // Shouldn't happen because allSettled used below, but keep defensive
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

  // Ask cell(s) to show QR / visualizer (so they display the QR AFTER server processed)
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

/**
 * NEW ROUTE: /upload-to-imgbb
 * - Accepts:
 *   - multipart/form-data with fields: photo1, photo2, photo3, montage (files)
 *   - or JSON body: { photos: [dataURL...], montage: dataURL }
 * - Returns: { ok: true, urls: { photo1, photo2, photo3, montage } }
 */
const multer = (() => {
  try { return require('multer'); } catch (e) { return null; }
})();

if (multer) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${uuidv4()}-${safe}`);
    }
  });
  const uploader = multer({ storage });
  app.post('/upload-to-imgbb', uploader.fields([
    { name: 'photo1', maxCount: 1 },
    { name: 'photo2', maxCount: 1 },
    { name: 'photo3', maxCount: 1 },
    { name: 'montage', maxCount: 1 }
  ]), async (req, res) => {
    try {
      const results = { photo1: null, photo2: null, photo3: null, montage: null };
      const files = req.files || {};

      // Helper to read file and upload or return local URL
      async function processFile(file) {
        try {
          const buf = await fs.promises.readFile(file.path);
          const base64 = buf.toString('base64');
          const dataUrl = `data:image/${(file.mimetype || 'png').split('/')[1]};base64,${base64}`;
          if (IMGBB_KEY && fetchFn) {
            try {
              const url = await uploadToImgbbFromDataUrl(dataUrl, file.originalname);
              // remove local
              try { await fs.promises.unlink(file.path); } catch(_) {}
              return url;
            } catch (e) {
              // fallback to serve locally
              const publicUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/uploads/${path.basename(file.path)}`;
              return publicUrl;
            }
          } else {
            return `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/uploads/${path.basename(file.path)}`;
          }
        } catch (e) {
          console.error('processFile error', e);
          return null;
        }
      }

      // files from multipart
      if (files.photo1 && files.photo1[0]) results.photo1 = await processFile(files.photo1[0]);
      if (files.photo2 && files.photo2[0]) results.photo2 = await processFile(files.photo2[0]);
      if (files.photo3 && files.photo3[0]) results.photo3 = await processFile(files.photo3[0]);
      if (files.montage && files.montage[0]) results.montage = await processFile(files.montage[0]);

      // If not provided via multipart, accept JSON body with dataURLs
      if ((!results.photo1 || !results.photo2 || !results.photo3 || !results.montage) && req.body) {
        const photos = req.body.photos || req.body.photosArray || null;
        if (Array.isArray(photos)) {
          for (let i = 0; i < photos.length && i < 3; i++) {
            const key = `photo${i+1}`;
            if (!results[key] && photos[i]) {
              try {
                results[key] = IMGBB_KEY && fetchFn ? await uploadToImgbbFromDataUrl(photos[i], key) : await saveDataUrlToUploads(photos[i], key);
              } catch (e) {
                console.error('upload/data save failed for', key, e);
              }
            }
          }
        }
        if (!results.montage && req.body.montage) {
          try {
            results.montage = IMGBB_KEY && fetchFn ? await uploadToImgbbFromDataUrl(req.body.montage, 'montage') : await saveDataUrlToUploads(req.body.montage, 'montage');
          } catch (e) {
            console.error('upload/data save failed for montage', e);
          }
        }
      }

      const any = Object.values(results).some(Boolean);
      if (!any) return res.status(400).json({ ok:false, error: 'No images received' });

      return res.json({ ok:true, urls: results });
    } catch (e) {
      console.error('/upload-to-imgbb error', e && e.stack ? e.stack : e);
      return res.status(500).json({ ok:false, error: String(e) });
    }
  });
} else {
  // multer not installed: provide a JSON-only endpoint fallback
  app.post('/upload-to-imgbb', async (req, res) => {
    try {
      const results = { photo1: null, photo2: null, photo3: null, montage: null };
      const photos = req.body.photos || req.body.photosArray || null;
      if (Array.isArray(photos)) {
        for (let i = 0; i < photos.length && i < 3; i++) {
          const key = `photo${i+1}`;
          if (photos[i]) {
            try {
              results[key] = IMGB
