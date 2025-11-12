// server.js (exemplo consolidado)
// node >= 16 recommended

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // if needed for IMGBB (or use axios)
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // set in env if you want server upload
const VISUALIZADOR_ORIGIN = process.env.VISUALIZADOR_ORIGIN || (`https://festadodavi.onrender.com`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { /* defaults */ });

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.json({limit:'25mb'}));
app.use(express.urlencoded({ extended:true }));
app.use(express.static(PUBLIC_DIR));

const sessions = {}; // in-memory (s-> { viewers: {vid: {...}}, operators:Set, lastStreamFrame })

function ensureSession(s){
  if(!s) sessions[s] = { viewers:{}, operators: new Set(), lastStreamFrame: null, createdAt: new Date().toISOString() };
  return sessions[s];
}

// helpers: upload base64 to imgbb
async function uploadToImgbbFromDataUrl(dataUrl, name){
  if(!IMGBB_KEY) throw new Error('IMGBB_KEY not configured');
  // dataUrl = data:image/jpeg;base64,...
  const base64 = dataUrl.split(',')[1];
  const form = new URLSearchParams();
  form.append('key', IMGBB_KEY);
  form.append('image', base64);
  form.append('name', name);
  const res = await fetch('https://api.imgbb.com/1/upload', { method:'POST', body: form });
  const j = await res.json();
  if(j && j.success && j.data && j.data.display_url) return j.data.display_url;
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
  // fallback minimal HTML if visualizador not present
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
const upload = multer({ dest: path.join(__dirname,'uploads') });
app.post('/upload_boomerang', upload.single('file'), async (req,res) => {
  try {
    if(!req.file) return res.status(400).json({ok:false,err:'no file'});
    // in production store and return public url
    const url = `/uploads/${req.file.filename}`; // simplistic
    return res.json({ ok:true, url });
  } catch(err){
    console.error(err);
    return res.status(500).json({ ok:false, err: String(err) });
  }
});

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
    if(lastFrame) socket.emit('stream_frame', { session, frame: lastFrame });
  });

  socket.on('join_viewer', ({ viewerId })=>{
    if(!viewerId) return;
    socket.join(`viewer:${viewerId}`);
    socket.data.viewerId = viewerId;
    // if viewer exists in any session, send the stored payload
    for(const sid of Object.keys(sessions)){
      const v = sessions[sid].viewers[viewerId];
      if(v){
        socket.emit('viewer_photos_ready', {
          photos: v.photos || [],
          storiesMontage: v.storiesMontage || null,
          print: v.print || null,
          boomerang: v.boomerang || null,
          createdAt: v.createdAt
        });
        break;
      }
    }
  });

  // operator -> stream frame
  socket.on('stream_frame', ({ session, frame })=>{
    if(!session || !frame) return;
    ensureSession(session);
    sessions[session].lastStreamFrame = frame;
    io.to(`session:${session}`).emit('stream_frame', { session, frame });
  });

  // operator or viewer may send photo_ready (forward)
  socket.on('photo_ready', ({ session, index, viewerId, photo })=>{
    try {
      if(viewerId) io.to(`viewer:${viewerId}`).emit('photo_ready', { index, photo });
      else io.to(`session:${session}`).emit('photo_ready', { index, photo });
    } catch(e){ console.warn('photo_ready forward error', e); }
  });

  // create_viewer_session: server stores provided resources and emits viewer_session_created and viewer_photos_ready
  socket.on('create_viewer_session', async (payload) => {
    try {
      let { session, photos, storiesMontage, print, boomerang } = payload || {};
      if(!session) session = 'cabine-fixa';
      ensureSession(session);
      const vid = uuidv4();

      // If the server received dataURLs for storiesMontage/print, optionally upload to IMGBB
      let storiesUrl = null, printUrl = null;
      const uploaded = [];

      // attempt to upload if IMGBB_KEY provided and value looks like dataURL
      if(IMGBB_KEY){
        try {
          if(Array.isArray(photos)){
            for(let i=0;i<photos.length;i++){
              if(typeof photos[i] === 'string' && photos[i].startsWith('data:')) {
                try { const u = await uploadToImgbbFromDataUrl(photos[i], `photo_${Date.now()}_${i}`); uploaded.push(u); } catch(e){ uploaded.push(null); }
              } else uploaded.push(photos[i]);
            }
          }
          if(storiesMontage && storiesMontage.startsWith('data:')) {
            try { storiesUrl = await uploadToImgbbFromDataUrl(storiesMontage, `stories_${Date.now()}`); } catch(e){ storiesUrl = null; }
          } else storiesUrl = storiesMontage;
          if(print && print.startsWith('data:')) {
            try { printUrl = await uploadToImgbbFromDataUrl(print, `print_${Date.now()}`); } catch(e){ printUrl = null; }
          } else printUrl = print;
        } catch(e){ console.warn('IMGBB server upload partial error', e); }
      } else {
        // no IMGBB server-side; accept URLs or dataURLs as-is (client may have uploaded)
        if(Array.isArray(photos)) uploaded.push(...photos);
        storiesUrl = storiesMontage;
        printUrl = print;
      }

      sessions[session].viewers[vid] = {
        photos: uploaded.filter(Boolean),
        storiesMontage: storiesUrl,
        print: printUrl,
        boomerang: boomerang || null,
        createdAt: (new Date()).toISOString()
      };

      // emit ack to operator clients
      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });

      // send payload to the viewer room (viewer might not be connected yet; when viewer connects it will get it)
      const viewerPayload = {
        photos: sessions[session].viewers[vid].photos || [],
        storiesMontage: sessions[session].viewers[vid].storiesMontage || null,
        print: sessions[session].viewers[vid].print || null,
        boomerang: sessions[session].viewers[vid].boomerang || null,
        createdAt: sessions[session].viewers[vid].createdAt
      };
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', viewerPayload);

      // craft visualizador URL canonical
      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;

      // notify viewer if connected and operators (so operator's UI and on-cell show QR)
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });

    } catch(err){
      console.error('create_viewer_session error', err);
    }
  });

  // photos_submit: older flow where viewer sends array of dataURLs
  socket.on('photos_submit', async ({ session, viewerId, photos })=>{
    try {
      if(!session) session = 'cabine-fixa';
      ensureSession(session);
      const uploaded = [];
      if(IMGBB_KEY){
        for(let i=0;i<photos.length;i++){
          try {
            const u = await uploadToImgbbFromDataUrl(photos[i], `photo_${Date.now()}_${i}`);
            uploaded.push(u);
          } catch(e){ uploaded.push(null); }
        }
      } else {
        uploaded.push(...photos);
      }
      const vid = viewerId || uuidv4();
      sessions[session].viewers[vid] = { photos: uploaded.filter(Boolean), storiesMontage: null, print: null, boomerang:null, createdAt: (new Date()).toISOString() };
      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', { photos: sessions[session].viewers[vid].photos, storiesMontage: null, print:null, boomerang:null, createdAt: sessions[session].viewers[vid].createdAt });

      const viewerPayload = { photos: sessions[session].viewers[vid].photos, storiesMontage: null, print:null, boomerang:null, createdAt: sessions[session].viewers[vid].createdAt };
      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
    } catch(err){ console.error('photos_submit error', err); }
  });

  // boomerang_ready (client may send dataURL or url)
  socket.on('boomerang_ready', async ({ session, viewerId, dataUrl, videoUrl, previewFrame })=>{
    try {
      if(!session) session = 'cabine-fixa';
      ensureSession(session);
      const vid = viewerId || uuidv4();
      // optionally upload previewFrame to IMGBB
      let previewUrl = null;
      if(previewFrame && IMGBB_KEY){
        try { previewUrl = await uploadToImgbbFromDataUrl(previewFrame, `boom_preview_${Date.now()}`); } catch(e){ previewUrl = null; }
      } else previewUrl = previewFrame || null;

      sessions[session].viewers[vid] = {
        photos: sessions[session].viewers[vid] ? sessions[session].viewers[vid].photos : [],
        storiesMontage: previewUrl,
        print: null,
        boomerang: videoUrl || dataUrl || null,
        createdAt: (new Date()).toISOString()
      };

      const viewerPayload = {
        photos: sessions[session].viewers[vid].photos || [],
        storiesMontage: previewUrl,
        print: null,
        boomerang: sessions[session].viewers[vid].boomerang || null,
        createdAt: sessions[session].viewers[vid].createdAt
      };

      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', viewerPayload);

      const visualizadorUrl = `${VISUALIZADOR_ORIGIN.replace(/\/+$/,'')}/visualizador.html?session=${encodeURIComponent(session)}&viewer=${encodeURIComponent(vid)}`;
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
    } catch(err){ console.error('boomerang_ready error', err); }
  });

  // finalize/reset session (operator)
  socket.on('finalize_session', ({ session })=>{
    if(!session) return;
    // notify cell(s) to return to welcome
    io.to(`session:${session}`).emit('finalize_session', { session });
    // and clear the session data if needed (optional)
    // sessions[session] = { viewers:{}, operators: new Set(), lastStreamFrame: null, createdAt: new Date().toISOString() };
    console.log('finalize_session for', session);
  });

  socket.on('reset_session', ({ session })=>{
    if(!session) return;
    io.to(`session:${session}`).emit('reset_session', { session });
    // clear data cache for session
    delete sessions[session];
    console.log('reset_session for', session);
  });

  socket.on('disconnect', ()=>{
    // cleanup if operator disconnected etc (optional)
  });
});

server.listen(PORT, ()=> console.log('Server running on port', PORT));
