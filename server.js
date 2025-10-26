// server.js
// Simple Node/Express + Socket.IO photobooth relay
// No external deps required other than express and socket.io
// Usage: node server.js
// Optional env: PORT, IMGBB_KEY

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const FIXED_SESSION = process.env.FIXED_SESSION || 'cabine-fixa';
const IMGBB_KEY = process.env.IMGBB_KEY || null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ["*"], methods: ["GET","POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

// in-memory stores
const sessions = {}; // sid -> { operators: Set, viewers: Set }
const viewerData = {}; // viewerId -> { photos:[], storiesMontage, print, createdAt, uploadedUrls? }
const sessionState = {}; // sid -> { lastFrameDataUrl }

function ensureSession(sid) {
  if (!sessions[sid]) {
    sessions[sid] = { operators: new Set(), viewers: new Set() };
    sessionState[sid] = { lastFrameDataUrl: null };
  }
  return sessions[sid];
}
function makeId(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
}

// helper to upload to imgbb (server-side) if key present (returns URL)
async function uploadImgbbServer(dataUrl, name = 'cabine') {
  if (!IMGBB_KEY) throw new Error('IMGBB_KEY not configured on server');
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const form = new URLSearchParams();
  form.append('key', IMGBB_KEY);
  form.append('image', base64);
  form.append('name', name);
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json && json.success && json.data && json.data.url) return json.data.url;
  throw new Error('IMGBB upload failed: ' + JSON.stringify(json));
}

// socket logic
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // join session as operator/viewer
  socket.on('join_session', ({ session, role }) => {
    const sid = session || FIXED_SESSION;
    ensureSession(sid);
    socket.data.session = sid;
    socket.data.role = role || 'viewer';

    if (socket.data.role === 'operator') {
      sessions[sid].operators.add(socket.id);
      socket.join(sid + ':operators');
      console.log(`operator ${socket.id} joined ${sid}`);
      // send last frame if exists
      const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
      if (last) socket.emit('stream_frame', { session: sid, frame: last });
      // inform operators about counts
    } else {
      sessions[sid].viewers.add(socket.id);
      socket.join(sid + ':viewers');
      console.log(`viewer ${socket.id} joined ${sid}`);
      io.in(sid + ':operators').emit('peer_joined', { id: socket.id, role: 'viewer', session: sid });
      const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
      if (last) socket.emit('stream_frame', { session: sid, frame: last });
      else socket.emit('stream_pending', { session: sid });
    }
    // emit counts
    io.in(sid + ':operators').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
    io.in(sid + ':viewers').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
  });

  // legacy cell-connected event (from celular)
  socket.on('cell_connected', ({ session }) => {
    const sid = session || FIXED_SESSION;
    ensureSession(sid);
    socket.data.session = sid;
    socket.data.role = 'viewer';
    sessions[sid].viewers.add(socket.id);
    socket.join(sid + ':viewers');
    io.in(sid + ':operators').emit('peer_joined', { id: socket.id, role: 'viewer', session: sid });
    const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
    if (last) socket.emit('stream_frame', { session: sid, frame: last });
  });

  // visualizador explicit join
  socket.on('join_viewer', ({ viewerId }) => {
    if (!viewerId) return;
    socket.join('viewer_' + viewerId);
    console.log('socket joined viewer room', viewerId, socket.id);
    // if server already has data for this viewerId, emit it:
    if (viewerData[viewerId]) {
      socket.emit('viewer_photos_ready', viewerData[viewerId]);
    }
  });

  // viewer asks server to request stream
  socket.on('request_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(sid + ':operators').emit('want_stream', { session: sid, viewerId: socket.id });
    const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
    if (last) socket.emit('stream_frame', { session: sid, frame: last });
    else socket.emit('stream_pending', { session: sid });
  });

  // operator sends stream frame (low-res)
  socket.on('stream_frame', ({ session, frame }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    sessionState[sid].lastFrameDataUrl = frame;
    io.in(sid + ':viewers').emit('stream_frame', { session: sid, frame });
  });

  // viewer requests a high-res capture
  socket.on('take_photo', ({ session, index, viewerId }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(sid + ':operators').emit('take_photo', { session: sid, index, viewerId });
  });

  // operator returns photo_ready to viewer
  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    if (viewerId) {
      io.to(viewerId).emit('photo_ready', { index, photo });
    } else {
      io.in(sid + ':viewers').emit('photo_ready', { index, photo });
    }
  });

  // viewer sends final photos array -> forward to operators
  socket.on('photos_submit', ({ session, viewerId, photos }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(sid + ':operators').emit('photos_submit', { viewerId, photos, session: sid });
    io.to(viewerId).emit('photos_received', { status: 'ok' });
  });

  // server helper: create_viewer_session (server may upload to imgbb if configured)
  socket.on('create_viewer_session', async ({ session, photos, storiesMontage, print }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    const viewerId = makeId('viewer');
    const payload = { photos: photos || [], storiesMontage: storiesMontage || null, print: print || null, createdAt: new Date().toISOString() };
    // store in memory
    viewerData[viewerId] = payload;

    // if IMGBB_KEY present on server, try to upload the dataurls to imgbb to produce public URLs
    if (IMGBB_KEY) {
      try {
        const uploaded = [];
        for (let i=0;i<(photos||[]).length;i++) {
          const url = await uploadImgbbServer(photos[i], `viewer_${viewerId}_photo_${i+1}`);
          uploaded.push(url);
        }
        let storiesUrl = null;
        if (storiesMontage) {
          storiesUrl = await uploadImgbbServer(storiesMontage, `viewer_${viewerId}_stories`);
        }
        let printUrl = null;
        if (print) {
          try { printUrl = await uploadImgbbServer(print, `viewer_${viewerId}_print`); } catch(e){ /*ignore*/ }
        }
        payload.photos = uploaded;
        payload.storiesMontage = storiesUrl;
        payload.print = printUrl;
        viewerData[viewerId] = payload;
      } catch(e) {
        console.warn('Server IMGBB upload failed', e);
        // keep dataurls as-is
      }
    }

    // notify operator UI (the one who requested create) and any viewers if needed
    // Emit to creating operator
    socket.emit('viewer_session_created', { viewerId });
    // Also broadcast to operators in the session
    io.in(sid + ':operators').emit('viewer_session_created', { viewerId });
    // And keep a copy of payload on server; viewers that later join with join_viewer will receive it
    console.log('viewer_session_created', viewerId, 'session', sid);
  });

  // server side: send show_qr to specific viewer or session
  socket.on('show_qr_on_viewer', ({ viewerId, visualizadorUrl }) => {
    if (viewerId) {
      io.to(viewerId).emit('show_qr', { visualizadorUrl });
      console.log('show_qr to viewer', viewerId);
    }
  });
  socket.on('show_qr_to_session', ({ session, visualizadorUrl }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    io.in(sid + ':viewers').emit('show_qr', { visualizadorUrl });
    console.log('show_qr to session', sid);
  });

  // reset session instruction
  socket.on('reset_session', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    io.in(sid + ':viewers').emit('reset_session', { session: sid });
    io.in(sid + ':operators').emit('reset_session', { session: sid });
    // clear stored session state (frames)
    if (sessionState[sid]) sessionState[sid].lastFrameDataUrl = null;
    console.log('reset_session for', sid);
  });

  socket.on('disconnect', () => {
    const sid = socket.data.session || FIXED_SESSION;
    if (sessions[sid]) {
      sessions[sid].operators.delete(socket.id);
      sessions[sid].viewers.delete(socket.id);
      io.in(sid + ':operators').emit('peer_left', { id: socket.id, role: socket.data.role, session: sid });
      io.in(sid + ':viewers').emit('peer_left', { id: socket.id, role: socket.data.role, session: sid });
      io.in(sid + ':operators').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
      io.in(sid + ':viewers').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
    }
    // remove viewerData? no, keep until TTL (not implemented)
    console.log('socket disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
