// server.js
// Node/Express + Socket.IO simple relay for photobooth
// - Session fixed: "cabine-fixa"
// - Recebe stream_frame from operator -> forwards to viewers
// - Relays take_photo (viewer -> operators) and photo_ready (operator -> viewer)
// - For production: integrate your IMGBB / montage logic in the photos_submit handler
//
// Usage: node server.js
// Port: process.env.PORT || 3000

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ["*"], methods: ["GET","POST"] }
});

const PORT = process.env.PORT || 3000;
const FIXED_SESSION = process.env.FIXED_SESSION || 'cabine-fixa';

// Serve static files (put index.html / celular.html / assets into public/)
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory session tracking
const sessions = {}; // sid -> { operators: Set(socketId), viewers: Set(socketId) }
const sessionState = {}; // sid -> { lastFrameDataUrl }

function ensureSession(sid) {
  if (!sessions[sid]) {
    sessions[sid] = { operators: new Set(), viewers: new Set() };
    sessionState[sid] = { lastFrameDataUrl: null };
  }
  return sessions[sid];
}

io.on('connection', (socket) => {
  console.log('Socket connected', socket.id);

  socket.on('join_session', ({ session, role }) => {
    const sid = session || FIXED_SESSION;
    ensureSession(sid);
    socket.data.session = sid;
    socket.data.role = role || 'viewer';

    if (socket.data.role === 'operator') {
      sessions[sid].operators.add(socket.id);
      socket.join(sid + ':operators');
      console.log(`Operator ${socket.id} joined ${sid}`);
      // if we have a cached last frame, send it to this operator (not strictly needed)
      const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
      if (last) {
        socket.emit('stream_frame', { session: sid, frame: last });
      }
    } else {
      sessions[sid].viewers.add(socket.id);
      socket.join(sid + ':viewers');
      console.log(`Viewer ${socket.id} joined ${sid}`);
      // notify operators that a viewer joined (operators can auto-start if needed)
      io.in(sid + ':operators').emit('peer_joined', { id: socket.id, role: 'viewer', session: sid });
      // if last frame exists, send immediately
      const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
      if (last) {
        socket.emit('stream_frame', { session: sid, frame: last });
      } else {
        socket.emit('stream_pending', { session: sid });
      }
    }

    // emit counts
    io.in(sid + ':operators').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
    io.in(sid + ':viewers').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
  });

  // viewer asks for stream -> notify operators; also reply with cached frame if available
  socket.on('request_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(sid + ':operators').emit('want_stream', { session: sid, viewerId: socket.id });
    const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
    if (last) {
      socket.emit('stream_frame', { session: sid, frame: last });
    } else {
      socket.emit('stream_pending', { session: sid });
    }
  });

  // operator sends small frames for preview -> broadcast to viewers & cache last frame
  socket.on('stream_frame', ({ session, frame }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    sessionState[sid].lastFrameDataUrl = frame; // cache last
    // broadcast to viewers only
    io.in(sid + ':viewers').emit('stream_frame', { session: sid, frame });
  });

  // viewer requests a high-res capture; forward to operators
  socket.on('take_photo', ({ session, index, viewerId }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // forward to operators so the operator (PC) can capture high-res and reply
    io.in(sid + ':operators').emit('take_photo', { session: sid, index, viewerId });
  });

  // operator replies with captured photo for a specific viewer
  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    if (viewerId) {
      io.to(viewerId).emit('photo_ready', { index, photo });
    } else {
      // broadcast as fallback
      io.in(sid + ':viewers').emit('photo_ready', { index, photo });
    }
  });

  // viewer sends final photos array -> forward to operators (where your montage/IMGBB logic will run)
  socket.on('photos_submit', ({ session, viewerId, photos }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(sid + ':operators').emit('photos_submit', { viewerId, photos, session: sid });
    // Optionally acknowledge viewer
    io.to(viewerId).emit('photos_received', { status: 'ok' });
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
    console.log('Socket disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
