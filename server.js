// server.js
// Node + Express + Socket.IO server for "Cabine Fotográfica"
// In-memory session store. Not production-persistent.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// allow any origin by default; lock this down in production
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // path: '/socket.io' // default is fine
});

// In-memory store for sessions
// sessions: {
//   [sessionId]: {
//     operators: Set(socketId),
//     viewers: Set(socketId),
//     lastFrame: dataUrl,
//     viewerSessions: Map(viewerId -> payload object),
//   }
// }
const sessions = new Map();

// Helpers
function getSessionObj(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      operators: new Set(),
      viewers: new Set(),
      lastFrame: null,
      viewerSessions: new Map()
    });
  }
  return sessions.get(sessionId);
}

function makeViewerId() {
  return crypto.randomBytes(10).toString('hex'); // ~20 chars
}

// Express endpoints (health + optional static)
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sessions: sessions.size });
});

// Optional: serve static files if you put frontend here (uncomment and adjust path)
// app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO handlers
io.on('connection', (socket) => {
  console.log(`[io] socket connected: ${socket.id}`);

  // Keep track of which session(s) this socket joined for cleanup
  socket._joinedSessions = new Set();
  socket._isViewerWithId = null; // if join_viewer used, store viewerId

  // join_session: { session, role }
  socket.on('join_session', ({ session, role } = {}) => {
    if (!session) return;
    const s = getSessionObj(session);
    socket.join(session);
    socket._joinedSessions.add(session);

    if (role === 'operator') {
      s.operators.add(socket.id);
      console.log(`[session:${session}] operator joined (${socket.id})`);
      // notify existing viewers that an operator peer joined
      io.to(session).emit('peer_joined', { id: socket.id, role: 'operator', session });
    } else {
      s.viewers.add(socket.id);
      console.log(`[session:${session}] viewer joined (${socket.id})`);
      // notify operators/viewers of viewer_count
    }

    // emit updated viewer count to operators and session
    const viewersCount = s.viewers.size;
    io.to(session).emit('viewer_count', { viewers: viewersCount });

    // if we have a cached last frame, send it to the joining socket (helpful for immediate preview)
    if (s.lastFrame) {
      socket.emit('stream_frame', { session, frame: s.lastFrame });
    }
  });

  // join_viewer: viewerId param used by visualizador.html
  // client calls socket.emit('join_viewer', { viewerId })
  socket.on('join_viewer', ({ viewerId } = {}) => {
    if (!viewerId) {
      socket.emit('error', 'viewerId required for join_viewer');
      return;
    }
    // store mapping on socket for cleanup
    socket._isViewerWithId = viewerId;
    socket.join(`viewer:${viewerId}`);
    console.log(`[viewer:${viewerId}] socket ${socket.id} joined viewer room`);

    // If we have stored payload for this viewerId, send it immediately
    // viewerSessions are stored per session; search all sessions for this viewerId
    for (const [sessionId, sess] of sessions.entries()) {
      if (sess.viewerSessions && sess.viewerSessions.has(viewerId)) {
        const payload = sess.viewerSessions.get(viewerId);
        socket.emit('viewer_photos_ready', payload);
        console.log(`[viewer:${viewerId}] delivered cached viewer payload for session ${sessionId}`);
        return;
      }
    }

    // else send a not-found message (frontend may handle)
    socket.emit('viewer_photos_ready', { photos: [], message: 'viewer session not found' });
  });

  // viewer requests stream: forward to operators of session
  // { session, viewerId }
  socket.on('request_stream', ({ session, viewerId } = {}) => {
    if (!session) return;
    const s = getSessionObj(session);
    console.log(`[session:${session}] request_stream from viewer ${viewerId || socket.id}`);
    // notify operators (they will begin emitting stream_frame)
    s.operators.forEach(opId => {
      io.to(opId).emit('request_stream', { session, viewerId });
    });
    // also emit to session as a signal
    io.to(session).emit('stream_pending', { session });
  });

  // stream_frame: from operator -> server stores lastFrame and relays to viewers
  // { session, frame }
  socket.on('stream_frame', ({ session, frame } = {}) => {
    if (!session || !frame) return;
    const s = getSessionObj(session);
    s.lastFrame = frame;
    // relay to all viewers (but not back to operator)
    s.viewers.forEach(vId => {
      io.to(vId).emit('stream_frame', { session, frame });
    });
  });

  // take_photo: viewer asks operator to take photo
  // { session, index, viewerId }
  socket.on('take_photo', ({ session, index, viewerId } = {}) => {
    if (!session) return;
    const s = getSessionObj(session);
    console.log(`[session:${session}] take_photo requested index=${index} by viewer=${viewerId}`);
    // forward to operators (they will capture and emit photo_ready)
    s.operators.forEach(opId => {
      io.to(opId).emit('take_photo', { session, index, viewerId });
    });
  });

  // photo_ready: operator sends captured photo to server to forward to viewer
  // { session, index, viewerId, photo }
  socket.on('photo_ready', ({ session, index, viewerId, photo } = {}) => {
    if (!session || typeof index === 'undefined' || !viewerId || !photo) return;
    console.log(`[session:${session}] photo_ready index=${index} for viewer=${viewerId} (from ${socket.id})`);
    // forward to the viewer socket(s) — viewer might be in room `viewer:${viewerId}` or be a socket id
    // try room first
    const roomName = `viewer:${viewerId}`;
    const socketsInRoom = io.sockets.adapter.rooms.get(roomName);
    if (socketsInRoom && socketsInRoom.size > 0) {
      io.to(roomName).emit('photo_ready', { index, photo, viewerId });
      console.log(`-> forwarded photo_ready to room ${roomName}`);
      return;
    }
    // fallback: maybe viewerId is a socket id in this namespace
    const targetSocket = io.sockets.sockets.get(viewerId);
    if (targetSocket) {
      io.to(viewerId).emit('photo_ready', { index, photo, viewerId });
      console.log(`-> forwarded photo_ready to socket ${viewerId}`);
      return;
    }
    console.warn(`-> viewer ${viewerId} not found to deliver photo_ready`);
  });

  // photos_submit: viewer sends final photos to server -> server forwards to operators
  // { session, viewerId, photos }
  socket.on('photos_submit', ({ session, viewerId, photos } = {}) => {
    if (!session || !Array.isArray(photos)) return;
    const s = getSessionObj(session);
    console.log(`[session:${session}] photos_submit from viewer ${viewerId} (photos=${photos.length})`);
    // notify operators
    s.operators.forEach(opId => {
      io.to(opId).emit('photos_submit', { viewerId: viewerId || socket.id, photos });
    });
    // Also store a lastPhotos for this viewer if desired (not required)
  });

  // create_viewer_session: operator stores payload (photos/stories) and server generates viewerId
  // { session, photos, storiesMontage, print }
  socket.on('create_viewer_session', ({ session, photos, storiesMontage, print } = {}) => {
    if (!session || !Array.isArray(photos)) return;
    const viewerId = makeViewerId();
    const payload = {
      photos,
      storiesMontage: storiesMontage || null,
      print: print || null,
      createdAt: new Date().toISOString()
    };
    const s = getSessionObj(session);
    s.viewerSessions.set(viewerId, payload);
    console.log(`[session:${session}] created viewer session ${viewerId}`);
    // notify operator that viewer session created
    socket.emit('viewer_session_created', { viewerId });
    // Also emit to any user connected to room viewer:viewerId (unlikely right now)
    io.to(`viewer:${viewerId}`).emit('viewer_photos_ready', payload);
  });

  // show_qr_to_session: operator asks server to show QR overlay to all viewers in session
  // { session, visualizadorUrl }
  socket.on('show_qr_to_session', ({ session, visualizadorUrl } = {}) => {
    if (!session || !visualizadorUrl) return;
    const s = getSessionObj(session);
    s.viewers.forEach(vId => {
      io.to(vId).emit('show_qr', { visualizadorUrl });
    });
    console.log(`[session:${session}] show_qr_to_session -> relayed to ${s.viewers.size} viewers`);
  });

  // show_qr_on_viewer: operator wants to show QR to a specific viewer socket id
  // { viewerId, visualizadorUrl } (viewerId might be socket id or viewerId room)
  socket.on('show_qr_on_viewer', ({ viewerId, visualizadorUrl } = {}) => {
    if (!viewerId || !visualizadorUrl) return;
    // first try explicit viewer room
    const roomName = `viewer:${viewerId}`;
    const socketsInRoom = io.sockets.adapter.rooms.get(roomName);
    if (socketsInRoom && socketsInRoom.size > 0) {
      io.to(roomName).emit('show_qr', { visualizadorUrl });
      console.log(`show_qr_on_viewer -> shown to room ${roomName}`);
      return;
    }
    // fallback: treat viewerId as socket id
    const target = io.sockets.sockets.get(viewerId);
    if (target) {
      io.to(viewerId).emit('show_qr', { visualizadorUrl });
      console.log(`show_qr_on_viewer -> shown to socket ${viewerId}`);
      return;
    }
    console.warn('show_qr_on_viewer -> viewer not found:', viewerId);
  });

  // reset_session: clear session data and notify clients
  socket.on('reset_session', ({ session } = {}) => {
    if (!session) return;
    if (sessions.has(session)) {
      const s = sessions.get(session);
      // clear stored viewer sessions and lastFrame
      s.viewerSessions.clear();
      s.lastFrame = null;
      // notify all sockets in session
      io.to(session).emit('reset_session', { session });
      console.log(`[session:${session}] reset_session executed`);
    }
  });

  // clean disconnect
  socket.on('disconnect', (reason) => {
    console.log(`[io] socket disconnected: ${socket.id} (${reason})`);
    // remove from any sessions tracking
    for (const sessionId of socket._joinedSessions) {
      if (!sessions.has(sessionId)) continue;
      const s = sessions.get(sessionId);
      if (s.operators.has(socket.id)) s.operators.delete(socket.id);
      if (s.viewers.has(socket.id)) s.viewers.delete(socket.id);

      // notify remaining parties
      io.to(sessionId).emit('peer_left', { id: socket.id, session: sessionId });
      io.to(sessionId).emit('viewer_count', { viewers: s.viewers.size });

      // optionally remove session if empty
      if (s.operators.size === 0 && s.viewers.size === 0 && s.viewerSessions.size === 0) {
        sessions.delete(sessionId);
        console.log(`[session:${sessionId}] deleted (empty)`);
      }
    }

    // if socket had a viewerId mapping, no extra cleanup needed (viewerSessions are persistent until reset)
  });

});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
