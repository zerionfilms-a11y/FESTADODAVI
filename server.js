// server.js - simple signaling/relay server for photobooth (stream frames + remote photo capture)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ["http://localhost:3000","*"], methods: ["GET","POST"] } });

const PORT = process.env.PORT || 3000;
const FIXED_SESSION = process.env.FIXED_SESSION || 'cabine-fixa';

// Simple in-memory session registry
const sessions = {}; // sessionId -> { operators: Set, viewers: Set }
const sessionState = {}; // sessionId -> { lastFrameDataUrl }

function ensureSession(sid) {
  if (!sessions[sid]) {
    sessions[sid] = { operators: new Set(), viewers: new Set() };
    sessionState[sid] = { lastFrameDataUrl: null };
  }
  return sessions[sid];
}

// Serve static files (if you deploy server with the html files in 'public')
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join_session', ({ session, role }) => {
    const sid = session || FIXED_SESSION;
    ensureSession(sid);
    socket.data.session = sid;
    socket.data.role = role || 'viewer';
    if (socket.data.role === 'operator') {
      sessions[sid].operators.add(socket.id);
      socket.join(sid + ':operators');
      console.log(`operator ${socket.id} joined session ${sid}`);
      // send latest frame immediately if exists
      const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
      if (last) {
        socket.emit('stream_frame', { session: sid, frame: last });
      }
    } else {
      sessions[sid].viewers.add(socket.id);
      socket.join(sid + ':viewers');
      console.log(`viewer ${socket.id} joined session ${sid}`);
      // tell operators a viewer joined so they can auto-start if needed
      io.in(sid + ':operators').emit('peer_joined', { id: socket.id, role: 'viewer', session: sid });
    }
    // emit counts for monitoring
    io.in(sid + ':operators').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
    io.in(sid + ':viewers').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
  });

  socket.on('request_stream', ({ session }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // notify operators to start streaming to this session
    io.in(sid + ':operators').emit('want_stream', { session: sid, viewerId: socket.id });
    // if we already have a cached frame, send immediately to requester
    const last = sessionState[sid] && sessionState[sid].lastFrameDataUrl;
    if (last) {
      socket.emit('stream_frame', { session: sid, frame: last });
    } else {
      socket.emit('stream_pending', { session: sid });
    }
  });

  // Operator broadcasting small frames for live preview on viewers
  socket.on('stream_frame', ({ session, frame }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // cache last frame (for new viewers)
    sessionState[sid].lastFrameDataUrl = frame;
    // broadcast to viewers in session
    io.in(sid + ':viewers').emit('stream_frame', { session: sid, frame });
  });

  // Viewer requests a high-quality photo capture; server forwards to operators
  socket.on('take_photo', ({ session, index, viewerId }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // forward to operators with viewerId so operator can reply specifically
    io.in(sid + ':operators').emit('take_photo', { session: sid, index, viewerId });
  });

  // Operator sends back captured photo for a specific viewer
  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    // forward directly to the intended viewer socket id
    if (viewerId) {
      io.to(viewerId).emit('photo_ready', { index, photo });
    } else {
      // broadcast to all viewers if no target specified (fallback)
      io.in(sid + ':viewers').emit('photo_ready', { index, photo });
    }
  });

  // Viewer sends final photos array to server; forward to operators to process (montage, imgbb)
  socket.on('photos_submit', ({ session, viewerId, photos }) => {
    const sid = session || socket.data.session || FIXED_SESSION;
    ensureSession(sid);
    io.in(sid + ':operators').emit('photos_submit', { viewerId, photos, session: sid });
  });

  socket.on('disconnect', () => {
    const sid = socket.data.session || FIXED_SESSION;
    if (sessions[sid]) {
      sessions[sid].operators.delete(socket.id);
      sessions[sid].viewers.delete(socket.id);
      // inform remaining peers
      io.in(sid + ':operators').emit('peer_left', { id: socket.id, role: socket.data.role, session: sid });
      io.in(sid + ':viewers').emit('peer_left', { id: socket.id, role: socket.data.role, session: sid });
      // emit counts
      io.in(sid + ':operators').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
      io.in(sid + ':viewers').emit('viewer_count', { viewers: sessions[sid].viewers.size, operators: sessions[sid].operators.size });
    }
    console.log('socket disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
