// server.js
// Node >= 16+ recommended
// Replace IMGBB_KEY via env for production

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Try require busboy but be defensive
let BusboyModule = null;
try { BusboyModule = require('busboy'); } catch(e){ BusboyModule = null; }
let Busboy = null;
if (BusboyModule) {
  if (typeof BusboyModule === 'function') Busboy = BusboyModule;
  else if (BusboyModule && typeof BusboyModule.Busboy === 'function') Busboy = BusboyModule.Busboy;
  else if (BusboyModule && typeof BusboyModule.default === 'function') Busboy = BusboyModule.default;
  else {
    for (const k of Object.keys(BusboyModule)) {
      if (typeof BusboyModule[k] === 'function') { Busboy = BusboyModule[k]; break; }
    }
  }
}
if (!Busboy) {
  console.warn('Busboy not available. Multipart/form-data upload route will fallback to JSON or fail gracefully.');
}

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
  try { const ac = require('abort-controller'); AbortControllerLocal = ac; } catch (e) { AbortControllerLocal = null; }
}

const PORT = process.env.PORT || 3000;
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341';
const VISUALIZADOR_ORIGIN = (process.env.VISUALIZADOR_ORIGIN && process.env.VISUALIZADOR_ORIGIN.startsWith('http')) ?
  process.env.VISUALIZADOR_ORIGIN :
  (`https://festadodavi-production-0591.up.railway.app`);

const app = express();

// CORS - allow operator browser to fetch endpoints
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '160mb' }));
app.use(express.urlencoded({ extended: true, limit: '160mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST","OPTIONS"] } });

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch(e){ console.error('create uploads dir failed', e); }
}
app.use('/uploads', express.static(UPLOADS_DIR));

// in-memory sessions
const sessions = {};
function ensureSession(sessionId) {
  if (!sessionId) return null;
  if (!sessions[sessionId]) sessions[sessionId] = { viewers: {}, operators: new Set(), lastStreamFrame: null, createdAt: new Date().toISOString() };
  return sessions[sessionId];
}

// helpers
async function saveDataUrlToUploads(dataUrl, filenamePrefix = 'photo') {
  try {
    const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) throw new Error('Invalid data url');
    const mime = m[1], b64 = m[2];
    const extRaw = mime.split('/')[1];
    const ext = (extRaw === 'jpeg') ? 'jpg' : extRaw.replace(/[^a-z0-9]/gi,'');
    const name = `${filenamePrefix}-${Date.now()}-${uuidv4()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, name);
    const buffer = Buffer.from(b64, 'base64');
    await fs.promises.writeFile(filePath, buffer);
    const origin = VISUALIZADOR_ORIGIN.replace(/\/+$/, '');
    return `${origin}/uploads/${name}`;
  } catch (e) { throw new Error('saveDataUrlToUploads error: ' + (e && e.message ? e.message : e)); }
}

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

// health
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), sessions: Object.keys(sessions).length }));

// visualizador redirect
app.get('/visualizador/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const staticVizPath = path.join(PUBLIC_DIR, 'visualizador.html');
  if (fs.existsSync(staticVizPath)) return res.redirect(302, `/visualizador.html?session=${encodeURIComponent(sessionId)}`);
  const s = sessions[sessionId];
  if (!s) return res.status(404).send('<h2>Visualizador - sessão não encontrada</h2>');
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Visualizador - ${sessionId}</title></head><body style="background:#000;color:#fff;font-family:Arial;padding:12px">`;
  html += `<h2>Visualizador — Sessão: ${sessionId}</h2>`;
  html += `<div>Visualizadores: ${Object.keys(s.viewers||{}).length}</div></body></html>`;
  res.send(html);
});

/**
 * POST /upload-to-imgbb
 * Accepts either:
 * - application/json body: { photos: [ url or dataURL ], montage: dataURL|url }
 * - multipart/form-data (if busboy available)
 * Responds: { ok:true, urls: { photo1, photo2, photo3, montage } }
 */
app.post('/upload-to-imgbb', async (req, res) => {
  try {
    // If JSON body with photos/montage - handle directly
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('application/json') !== -1 || contentType.indexOf('application/javascript') !== -1) {
      // body already parsed by express.json
      const { photos = [], montage = null } = req.body || {};
      const urls = { photo1: null, photo2: null, photo3: null, montage: null };
      // upload each photo if dataURL, otherwise keep url as-is
      for (let i=0;i<3;i++) {
        const p = photos[i];
        if (!p) continue;
        if (typeof p === 'string' && p.startsWith('data:')) {
          try { urls['photo'+(i+1)] = (IMGBB_KEY && fetchFn) ? await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i+1}`) : await saveDataUrlToUploads(p, `photo_${i+1}`); }
          catch(e){ console.warn('json upload photo fallback', e); try{ urls['photo'+(i+1)] = await saveDataUrlToUploads(p, `photo_${i+1}`); }catch(ee){ urls['photo'+(i+1)] = null; } }
        } else if (typeof p === 'string' && /^https?:\/\//i.test(p)) {
          urls['photo'+(i+1)] = p;
        } else {
          urls['photo'+(i+1)] = null;
        }
      }
      // montage
      if (montage && typeof montage === 'string') {
        if (montage.startsWith('data:')) {
          try { urls.montage = (IMGBB_KEY && fetchFn) ? await uploadToImgbbFromDataUrl(montage, `stories_${Date.now()}`) : await saveDataUrlToUploads(montage, `stories`); }
          catch(e){ console.warn('json upload montage fallback', e); try{ urls.montage = await saveDataUrlToUploads(montage, 'stories'); }catch(ee){ urls.montage = null; } }
        } else if (/^https?:\/\//i.test(montage)) urls.montage = montage;
      }
      return res.json({ ok:true, urls });
    }

    // Else if multipart/form-data and busboy available -> use busboy
    if (contentType.indexOf('multipart/form-data') !== -1) {
      if (!Busboy) return res.status(500).json({ ok:false, err: 'Busboy not installed/available on server. Consider sending JSON instead.' });

      // Use Busboy
      const busboy = new Busboy({ headers: req.headers, limits: { files: 10, fileSize: 60 * 1024 * 1024 } });
      const fileBuffers = {};
      const urlFields = {};

      busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        const parts = [];
        file.on('data', (data) => parts.push(data));
        file.on('end', () => { fileBuffers[fieldname] = { buffer: Buffer.concat(parts), mime: mimetype, filename }; });
      });
      busboy.on('field', (fieldname, val) => { urlFields[fieldname] = val; });
      busboy.on('finish', async () => {
        try {
          const result = { photo1:null, photo2:null, photo3:null, montage:null };
          const handlePhoto = async (n) => {
            const f = 'photo' + n;
            const urlf = 'photoUrl' + n;
            if (fileBuffers[f]) {
              const it = fileBuffers[f];
              const dataUrl = `data:${it.mime};base64,${it.buffer.toString('base64')}`;
              try { return (IMGBB_KEY && fetchFn) ? await uploadToImgbbFromDataUrl(dataUrl, `photo_${Date.now()}_${n}`) : await saveDataUrlToUploads(dataUrl, `photo_${n}`); }
              catch(e){ console.warn('busboy upload failed', e); try{ return await saveDataUrlToUploads(dataUrl, `photo_${n}`); }catch(ee){ return null; } }
            }
            if (urlFields[urlf]) return urlFields[urlf];
            return null;
          };
          const handleMontage = async () => {
            if (fileBuffers['montage']) {
              const it = fileBuffers['montage'];
              const dataUrl = `data:${it.mime};base64,${it.buffer.toString('base64')}`;
              try { return (IMGBB_KEY && fetchFn) ? await uploadToImgbbFromDataUrl(dataUrl, `stories_${Date.now()}`) : await saveDataUrlToUploads(dataUrl, 'stories'); }
              catch(e){ console.warn('busboy montage upload failed', e); try{ return await saveDataUrlToUploads(dataUrl, 'stories'); }catch(ee){ return null; } }
            }
            if (urlFields['montageUrl']) return urlFields['montageUrl'];
            return null;
          };

          result.photo1 = await handlePhoto(1);
          result.photo2 = await handlePhoto(2);
          result.photo3 = await handlePhoto(3);
          result.montage = await handleMontage();
          return res.json({ ok:true, urls: result });
        } catch (e) {
          console.error('busboy finish error', e && e.stack ? e.stack : e);
          return res.status(500).json({ ok:false, err: String(e && e.stack ? e.stack : e) });
        }
      });

      req.pipe(busboy);
      return;
    }

    // Unknown content-type: try to read body (maybe express parsed it) and handle as JSON fallback
    if (req.body && (req.body.photos || req.body.montage)) {
      // reuse JSON handling above by calling this endpoint again internally
      req.headers['content-type'] = 'application/json';
      return app._router.handle(req, res, () => {});
    }

    return res.status(400).json({ ok:false, err: 'Unsupported Content-Type. Send application/json or multipart/form-data.' });
  } catch (e) {
    console.error('/upload-to-imgbb top error', e && e.stack ? e.stack : e);
    return res.status(500).json({ ok:false, err: String(e && e.stack ? e.stack : e) });
  }
});

/**
 * Unified handler used by both HTTP fallback and socket flow.
 */
async function handleIncomingPhotos({ session, photos = [], storiesMontage = null, print = null, viewerId: providedViewerId = null, socketOrigin = null }) {
  if (!session) session = 'cabine-fixa';
  ensureSession(session);
  const vid = providedViewerId || uuidv4();

  sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
  try { io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid }); } catch(e){}

  const maxPhotos = Math.min(3, (photos && photos.length) ? photos.length : 0);
  const photoTasks = [];

  for (let i = 0; i < maxPhotos; i++) {
    const p = photos[i];
    if (typeof p === 'string' && p.startsWith('data:')) {
      photoTasks.push((async () => {
        if (IMGBB_KEY && fetchFn) {
          try { return await uploadToImgbbFromDataUrl(p, `photo_${Date.now()}_${i}`); }
          catch(e){ console.warn('IMGBB upload failed for photo index', i, e); try{ return await saveDataUrlToUploads(p, `photo_${i}`); }catch(ee){ return null; } }
        } else {
          try { return await saveDataUrlToUploads(p, `photo_${i}`); } catch(e){ return null; }
        }
      })());
    } else if (typeof p === 'string' && /^https?:\/\//i.test(p)) {
      photoTasks.push(Promise.resolve(p));
    } else {
      photoTasks.push(Promise.resolve(null));
    }
  }

  const storyTask = (async () => {
    if (!storiesMontage) return null;
    if (typeof storiesMontage === 'string' && storiesMontage.startsWith('data:')) {
      if (IMGBB_KEY && fetchFn) {
        try { return await uploadToImgbbFromDataUrl(storiesMontage, `stories_${Date.now()}`); }
        catch(e){ try{ return await saveDataUrlToUploads(storiesMontage, `stories`); }catch(ee){ return null; } }
      } else {
        try { return await saveDataUrlToUploads(storiesMontage, 'stories'); } catch(e){ return null; }
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
        try { return await uploadToImgbbFromDataUrl(print, `print_${Date.now()}`); }
        catch(e){ try{ return await saveDataUrlToUploads(print, `print`); }catch(ee){ return null; } }
      } else {
        try { return await saveDataUrlToUploads(print, 'print'); } catch(e){ return null; }
      }
    } else if (typeof print === 'string' && /^https?:\/\//i.test(print)) {
      return print;
    }
    return null;
  })();

  logServer(`handleIncomingPhotos: starting upload tasks for session=${session} viewer=${vid} photos=${maxPhotos}`);
  let results;
  try { results = await Promise.allSettled([ Promise.all(photoTasks), storyTask, printTask ]); } catch(e){ results = []; }

  let photoResults = [];
  try {
    if (results && results[0] && results[0].status === 'fulfilled') photoResults = Array.isArray(results[0].value) ? results[0].value : [];
    else photoResults = (photos||[]).slice(0,maxPhotos).map(p => (typeof p === 'string' && /^https?:\/\//i.test(p)) ? p : null);
  } catch(e){ photoResults = []; }

  const storyUrl = (results && results[1] && results[1].status === 'fulfilled') ? results[1].value : null;
  const printUrl = (results && results[2] && results[2].status === 'fulfilled') ? results[2].value : null;

  const finalPhotos = (photoResults || []).filter(Boolean).slice(0,3);
  sessions[session].viewers[vid] = { photos: finalPhotos, storiesMontage: storyUrl || null, print: printUrl || null, boomerang: null, createdAt: new Date().toISOString() };

  const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;

  try { io.to(`viewer:${vid}`).emit('viewer_photos_ready', { session, viewerId: vid, photos: sessions[session].viewers[vid].photos, storiesMontage: sessions[session].viewers[vid].storiesMontage, print: sessions[session].viewers[vid].print, createdAt: sessions[session].viewers[vid].createdAt }); } catch(e){}
  try { io.to(`session:${session}`).emit('photos_ready', { session, uploaded: sessions[session].viewers[vid].photos, visualizadorUrl, storiesUrl: sessions[session].viewers[vid].storiesMontage || null, printUrl: sessions[session].viewers[vid].print || null }); } catch(e){}
  try { io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl }); io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl }); } catch(e){}

  logServer(`handleIncomingPhotos: finished session=${session} viewer=${vid} photos=${finalPhotos.length} stories=${Boolean(storyUrl)} print=${Boolean(printUrl)}`);
  return { ok: true, viewerId: vid, visualizadorUrl };
}

function logServer(msg) { console.log(`[server ${new Date().toISOString()}] ${msg}`); }

// upload_photos HTTP fallback
app.post('/upload_photos', async (req, res) => {
  try {
    const { session, photos } = req.body || {};
    if (!session || !Array.isArray(photos) || photos.length === 0) return res.status(400).json({ ok:false, err:'missing session or photos' });
    const vid = uuidv4();
    ensureSession(session);
    sessions[session].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
    const previewVisualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;
    res.json({ ok:true, viewerId: vid, visualizadorUrl: previewVisualizadorUrl });
    handleIncomingPhotos({ session, photos, viewerId: vid }).catch(err => console.error('handleIncomingPhotos (http) error', err && err.stack ? err.stack : err));
  } catch (err) {
    console.error('upload_photos error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok:false, err: String(err) });
  }
});

// socket.io handlers (unchanged logic)
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
      for (const sid of Object.keys(sessions)) {
        const v = sessions[sid].viewers[vid];
        if (v) {
          socket.emit('viewer_photos_ready', { session: sid, viewerId: vid, photos: v.photos || [], storiesMontage: v.storiesMontage || null, print: v.print || null, boomerang: v.boomerang || null, createdAt: v.createdAt });
          console.log(`[socket] viewer_join by id sent payload to ${socket.id} for viewer:${vid}`);
          return;
        }
      }
      console.log(`[socket] viewer_join (id) but no stored data for viewer:${vid}`);
      return;
    }

    if (session) {
      const s = sessions[session];
      if (!s) { console.log(`[socket] viewer_join for session:${session} but no session found`); return; }
      const viewers = s.viewers || {};
      const keys = Object.keys(viewers);
      if (keys.length === 0) { console.log(`[socket] viewer_join for session:${session} but no viewers yet`); return; }
      let latestId = keys[0];
      let latestTs = viewers[latestId].createdAt || 0;
      for (const k of keys) {
        const ts = viewers[k].createdAt || 0;
        if (ts > latestTs) { latestTs = ts; latestId = k; }
      }
      socket.join(`viewer:${latestId}`);
      socket.data.viewerId = latestId;
      const v = viewers[latestId];
      socket.emit('viewer_photos_ready', { session, viewerId: latestId, photos: v.photos || [], storiesMontage: v.storiesMontage || null, print: v.print || null, boomerang: v.boomerang || null, createdAt: v.createdAt });
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

  socket.on('photos_from_cell', async (payload, ack) => {
    try {
      const { session, photos, viewerId } = payload || {};
      const sess = session || 'cabine-fixa';
      const vid = viewerId || uuidv4();
      ensureSession(sess);
      sessions[sess].viewers[vid] = { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
      io.to(`session:${sess}`).emit('viewer_session_created', { viewerId: vid });
      try { if (typeof ack === 'function') ack(null, { ok:true, viewerId: vid }); } catch(e){}
      handleIncomingPhotos({ session: sess, photos: photos || [], viewerId: vid }).catch(err => console.error('handleIncomingPhotos (socket) error', err && err.stack ? err.stack : err));
    } catch (err) {
      console.error('photos_from_cell handler error', err && err.stack ? err.stack : err);
      try { if (typeof ack === 'function') ack(err); } catch(e){}
    }
  });

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

  socket.on('create_viewer_session', async (payload) => {
    try { await handleIncomingPhotos(payload); } catch (e) { console.error('create_viewer_session error', e && e.stack ? e.stack : e); }
  });

  socket.on('boomerang_ready', async ({ session, viewerId, data, dataUrl, videoUrl, previewFrame }) => {
    try {
      const sess = session || 'cabine-fixa';
      ensureSession(sess);
      const vid = viewerId || uuidv4();
      let previewUrl = previewFrame || null;
      if (previewFrame && typeof previewFrame === 'string' && previewFrame.startsWith('data:')) {
        if (IMGBB_KEY && fetchFn) {
          try { previewUrl = await uploadToImgbbFromDataUrl(previewFrame, `boom_preview_${Date.now()}`); } catch(e) { previewUrl = await saveDataUrlToUploads(previewFrame, 'boom_preview').catch(()=> previewFrame); }
        } else { previewUrl = await saveDataUrlToUploads(previewFrame, 'boom_preview').catch(()=> previewFrame); }
      }
      sessions[sess].viewers[vid] = sessions[sess].viewers[vid] || { photos: [], storiesMontage: null, print: null, boomerang: null, createdAt: new Date().toISOString() };
      sessions[sess].viewers[vid].boomerang = videoUrl || data || dataUrl || null;
      sessions[sess].viewers[vid].storiesMontage = previewUrl || sessions[sess].viewers[vid].storiesMontage || null;
      sessions[sess].viewers[vid].createdAt = new Date().toISOString();
      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(vid)}`;
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', { session: sess, viewerId: vid, photos: sessions[sess].viewers[vid].photos || [], storiesMontage: sessions[sess].viewers[vid].storiesMontage || null, print: sessions[sess].viewers[vid].print || null, boomerang: sessions[sess].viewers[vid].boomerang || null, createdAt: sessions[sess].viewers[vid].createdAt });
      io.to(`session:${sess}`).emit('boomerang_ready', { session: sess, videoUrl: sessions[sess].viewers[vid].boomerang, visualizadorUrl });
      io.to(`session:${sess}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
    } catch (e) { console.error('boomerang_ready error', e && e.stack ? e.stack : e); }
  });

  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    try { if (viewerId) io.to(`viewer:${viewerId}`).emit('photo_ready', { session, index, photo }); else if (session) io.to(`session:${session}`).emit('photo_ready', { session, index, photo }); } catch(e){}
  });

  socket.on('finalize_session', ({ session }) => { if (!session) return; io.to(`session:${session}`).emit('finalize_session', { session }); console.log('finalize_session for', session); });
  socket.on('reset_session', ({ session }) => { if (!session) return; io.to(`session:${session}`).emit('reset_session', { session }); if (sessions[session]) delete sessions[session]; console.log('reset_session for', session); });

  socket.on('disconnect', () => {
    try { for (const sid of Object.keys(sessions)) if (sessions[sid].operators && sessions[sid].operators.has(socket.id)) sessions[sid].operators.delete(socket.id); } catch(e){}
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
