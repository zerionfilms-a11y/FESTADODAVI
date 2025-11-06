/**
 * server.js - CORRIGIDO
 *
 * Node/Express + Socket.IO server for Festadodavi
 *
 * Features:
 *  - session/room model: operators join session rooms, viewers connect with viewerId
 *  - handles photos_submit and boomerang_ready from viewers and uploads to IMGBB
 *  - emits visualizador payloads and QR notifications to viewers and operators
 *
 * Usage:
 *   - set env IMGBB_KEY (required to upload to imgbb)
 *   - set env PORT (optional)
 *   - set env FRONTEND_ORIGIN (optional, for CORS)
 *
 * Install deps:
 *   npm i express socket.io node-fetch uuid form-data fluent-ffmpeg
 *   // fluent-ffmpeg requires ffmpeg installed on the host (apt, brew, etc).
 *
 * Notes:
 *  - This implementation uses in-memory stores. For production use persistent DB/Redis.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch'); // npm i node-fetch@2
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');

let ffmpegAvailable = false;
let ffmpeg = null;
try {
  // try to require fluent-ffmpeg; optional
  ffmpeg = require('fluent-ffmpeg');
  // if no ffmpeg binary installed, fluent-ffmpeg will fail at runtime when used.
  ffmpegAvailable = true;
} catch (e) {
  ffmpegAvailable = false;
}

/* --------------------------
   Configuration & stores
   -------------------------- */
const IMGBB_KEY = process.env.IMGBB_KEY || 'fc52605669365cdf28ea379d10f2a341'; // set this in your environment
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

if (!IMGBB_KEY) {
  console.warn('⚠️ IMGBB_KEY not set. Uploads to imgbb will fail until you set IMGBB_KEY env var.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"]
  },
  path: '/socket.io'
});

// In-memory sessions:
// sessions[sessionId] = { operators: Set(socketId), viewers: { viewerId: payload }, lastStreamFrame: 'data:'... }
const sessions = {};

/* --------------------------
   Helpers
   -------------------------- */

function ensureSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { operators: new Set(), viewers: {}, lastStreamFrame: null };
  }
  return sessions[sessionId];
}

async function uploadToImgbbFromDataUrl(dataUrl, name = 'upload') {
  if (!IMGBB_KEY) throw new Error('IMGBB_KEY not configured');
  // remove data:image/...;base64,
  const m = dataUrl.match(/^data:image\/\w+;base64,(.*)$/);
  if (!m) throw new Error('Invalid data URL for image');
  const base64 = m[1];

  const form = new FormData();
  form.append('key', IMGBB_KEY);
  form.append('image', base64);
  form.append('name', name);

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('IMGBB upload failed: ' + res.status + ' ' + text);
  }
  const json = await res.json();
  if (!json || !json.success || !json.data || !json.data.url) {
    throw new Error('IMGBB bad response: ' + JSON.stringify(json));
  }
  return json.data.url;
}

async function uploadBufferToImgbb(buffer, name = 'video') {
  // imgbb primarily supports images; for videos you might need another host.
  // We'll upload a thumbnail (first frame) if needed. For now throw.
  throw new Error('uploadBufferToImgbb not implemented for videos. Consider using a file host or S3.');
}

// Save base64 dataurl to temp file (image/video)
function saveDataUrlToTempFile(dataUrl, extHint='') {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!matches) throw new Error('Invalid data URL');
  const mime = matches[1];
  const base64 = matches[2];
  let ext = 'bin';
  if (mime.includes('/')) ext = mime.split('/')[1];
  if (extHint) ext = extHint;
  const buffer = Buffer.from(base64, 'base64');
  const tmpPath = path.join(os.tmpdir(), `festadodavi_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  return { path: tmpPath, mime, buffer };
}

/* optional FFmpeg boomerang processing:
   create a looped video by concatenating forward + reversed segments and trimming to target length.
   requires ffmpeg available on the host.
*/
async function processBoomerangWithFFmpeg(inputPath, outputPath, options = {}) {
  if (!ffmpegAvailable) throw new Error('ffmpeg not available');
  const { loopRepeats = 6, reverse = true } = options; // generate ~15s depends on input length
  return new Promise((resolve, reject) => {
    try {
      // We'll create a reversed copy, then concat multiple times: forward + reverse + forward...
      // Steps:
      //  - create reversed.mp4 (ffmpeg -i input -vf reverse -af areverse reversed.mp4)
      //  - create concat list file
      //  - run ffmpeg concat -> outputPath
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-'));
      const reversed = path.join(tmpDir, 'rev.mp4');
      const listFile = path.join(tmpDir, 'list.txt');

      // reverse
      ffmpeg(inputPath)
        .outputOptions('-vf', 'reverse')
        .outputOptions('-af', 'areverse')
        .save(reversed)
        .on('end', () => {
          // build concat list
          const parts = [];
          for (let i = 0; i < loopRepeats; i++) {
            parts.push(inputPath);
            parts.push(reversed);
          }
          // write list file
          const content = parts.map(p => `file '${p.replace(/'/g, "'\"'\"'")}'`).join('\n');
          fs.writeFileSync(listFile, content, 'utf8');

          // concat
          ffmpeg()
            .input(listFile)
            .inputOptions('-f', 'concat', '-safe', '0')
            .outputOptions('-c', 'copy')
            .save(outputPath)
            .on('end', () => {
              // cleanup
              try { fs.unlinkSync(reversed); } catch(e){}
              try { fs.unlinkSync(listFile); } catch(e){}
              try { fs.rmdirSync(tmpDir); } catch(e){}
              resolve(outputPath);
            })
            .on('error', (err) => reject(err));
        })
        .on('error', (err) => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

/* --------------------------
   Express routes
   -------------------------- */
app.get('/health', (req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegAvailable, now: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('Festadodavi socket server running');
});

// Serve static files from public directory
app.use(express.static('public'));

/* --------------------------
   Socket.IO event handlers
   -------------------------- */
io.on('connection', (socket) => {
  console.log('[socket] connected', socket.id);

  socket.on('join_session', ({ session, role }) => {
    if (!session) return;
    ensureSession(session);
    socket.join(`session:${session}`);
    socket.data.session = session;
    socket.data.role = role || 'operator';
    if (role === 'operator') {
      sessions[session].operators.add(socket.id);
      console.log(`[socket] operator ${socket.id} joined session ${session}`);
    } else {
      console.log(`[socket] socket ${socket.id} joined session ${session} as ${role}`);
    }
    // optionally emit last stream frame cached
    const lastFrame = sessions[session].lastStreamFrame;
    if (lastFrame) {
      socket.emit('stream_frame', { session, frame: lastFrame });
    }
  });

  socket.on('join_viewer', ({ viewerId }) => {
    if (!viewerId) return;
    socket.join(`viewer:${viewerId}`);
    socket.data.viewerId = viewerId;
    console.log(`[socket] viewer ${socket.id} joined viewer:${viewerId}`);
    // if viewer data exists, push photos_ready
    // find viewer in all sessions
    for (const sessionId of Object.keys(sessions)) {
      const view = sessions[sessionId].viewers[viewerId];
      if (view) {
        // send viewer_photos_ready
        socket.emit('viewer_photos_ready', {
          photos: view.photos || [],
          storiesMontage: view.storiesMontage || null,
          print: view.print || null,
          boomerang: view.boomerang || null,
          createdAt: view.createdAt
        });
        break;
      }
    }
  });

  // CORREÇÃO: Adicionar handler para cell_connected
  socket.on('cell_connected', ({ session }) => {
    console.log(`[cell_connected] Celular conectado na sessão: ${session}`);
    ensureSession(session);
    // Opcional: notificar operadores que um celular se conectou
    io.to(`session:${session}`).emit('cell_connected', { viewerId: socket.id });
  });

  // CORREÇÃO: Adicionar handler para cell_entered_fullscreen
  socket.on('cell_entered_fullscreen', ({ session, viewerId }) => {
    console.log(`[cell_entered_fullscreen] Celular ${viewerId} entrou em fullscreen na sessão: ${session}`);
    ensureSession(session);
    // Notificar operadores que um celular entrou em fullscreen
    io.to(`session:${session}`).emit('cell_entered_fullscreen', { viewerId });
  });

  // Relay stream_frame from operator → cache last frame & broadcast to viewers in session
  socket.on('stream_frame', ({ session, frame }) => {
    if (!session || !frame) return;
    ensureSession(session);
    sessions[session].lastStreamFrame = frame;
    // broadcast to viewers in this session (if any)
    // we'll emit a lightweight event 'stream_frame' to room `session:${session}` so viewers can pick it up
    io.to(`session:${session}`).emit('stream_frame', { session, frame });
  });

  // request_stream (viewer asks for cached frame) — forward to operators to request streaming
  socket.on('request_stream', ({ session, viewerId }) => {
    if (!session) return;
    // notify operators to start streaming (they may already be streaming)
    io.to(`session:${session}`).emit('request_stream', { session, viewerId });
    // also notify the viewer to wait (stream_pending)
    if (socket.data && socket.data.viewerId) {
      socket.emit('stream_pending', { session });
    }
  });

  // operator requests take_photo => forward to operator client(s) maybe to trigger capture
  socket.on('take_photo', ({ session, index, viewerId }) => {
    // typically viewer triggers this but operators can ask too
    io.to(`session:${session}`).emit('take_photo', { session, index, viewerId });
  });

  // operator sends photo_ready (dataURL) to server -> forward to specific viewer
  socket.on('photo_ready', ({ session, index, viewerId, photo }) => {
    try {
      if (viewerId) {
        io.to(`viewer:${viewerId}`).emit('photo_ready', { index, photo });
      } else {
        // broadcast to session viewers
        io.to(`session:${session}`).emit('photo_ready', { index, photo });
      }
    } catch (e) {
      console.warn('photo_ready forward error', e);
    }
  });

  // Viewer sends photos_submit (array of dataURLs) — server will upload to IMGBB and create viewer entry and emit show_qr
  socket.on('photos_submit', async ({ session, viewerId, photos }) => {
    try {
      if (!session) session = 'cabine-fixa';
      ensureSession(session);

      console.log(`[photos_submit] viewerId=${viewerId} photos=${(photos && photos.length) || 0}`);

      // upload each photo (images) to IMGBB (sequential to avoid rate issues)
      const uploaded = [];
      for (let i = 0; i < photos.length; i++) {
        try {
          const url = await uploadToImgbbFromDataUrl(photos[i], `cabine_photo_${Date.now()}_${i+1}`);
          uploaded.push(url);
          console.log(`[IMGBB] uploaded photo ${i+1}: ${url}`);
        } catch (err) {
          console.warn('IMGBB upload photo error', err);
        }
      }

      // store viewer data (if viewerId provided) OR generate one
      const vid = viewerId || uuidv4();
      const viewerEntry = {
        photos: uploaded,
        storiesMontage: null,
        print: null,
        boomerang: null,
        createdAt: (new Date()).toISOString()
      };
      sessions[session].viewers[vid] = viewerEntry;

      // notify operator(s) and viewer socket(s)
      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', {
        photos: uploaded,
        storiesMontage: null,
        print: null,
        boomerang: null,
        createdAt: viewerEntry.createdAt
      });

      // Optionally generate visualizador payload and emit 'show_qr' with visualizadorUrl
      try {
        const viewerPayload = { 
          photos: uploaded, 
          storiesMontage: null, 
          print: null, 
          boomerang: null,
          createdAt: viewerEntry.createdAt 
        };
        const payloadStr = JSON.stringify(viewerPayload);
        const b64 = Buffer.from(payloadStr, 'utf8').toString('base64');
        const visualizadorUrl = `${(process.env.VISUALIZADOR_ORIGIN || ('http://'+(process.env.HOSTNAME || 'localhost:'+PORT)))}/visualizador.html?data=${encodeURIComponent(b64)}`;
        // emit show_qr to viewer and operators
        io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
        io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });
      } catch(err) {
        console.warn('Error creating visualizador url', err);
      }

    } catch (err) {
      console.error('photos_submit handler error', err);
    }
  });

  // CORREÇÃO: Novo handler para boomerang_ready simplificado
  socket.on('boomerang_ready', async ({ session, viewerId, dataUrl, previewFrame }) => {
    try {
      console.log(`[boomerang_ready] viewer=${viewerId} session=${session}`);
      if (!dataUrl) return;

      // Fazer upload do preview frame para IMGBB
      let boomerangPreviewUrl = null;
      if (previewFrame) {
        try {
          boomerangPreviewUrl = await uploadToImgbbFromDataUrl(previewFrame, `boomerang_preview_${Date.now()}`);
          console.log(`[IMGBB] uploaded boomerang preview: ${boomerangPreviewUrl}`);
        } catch (err) {
          console.warn('IMGBB upload boomerang preview error', err);
        }
      }

      // Store viewer entry
      ensureSession(session);
      const vid = viewerId || uuidv4();
      sessions[session].viewers[vid] = {
        photos: sessions[session].viewers[vid] ? sessions[session].viewers[vid].photos : [],
        storiesMontage: boomerangPreviewUrl,
        print: null,
        boomerang: dataUrl, // manter dataUrl completo para o visualizador
        createdAt: (new Date()).toISOString()
      };

      // Build visualizador URL payload
      const viewerPayload = {
        photos: sessions[session].viewers[vid].photos || [],
        storiesMontage: boomerangPreviewUrl,
        print: null,
        boomerang: dataUrl,
        createdAt: sessions[session].viewers[vid].createdAt
      };
      
      const payloadStr = JSON.stringify(viewerPayload);
      const b64 = Buffer.from(payloadStr, 'utf8').toString('base64');
      const visualizadorUrl = `${process.env.VISUALIZADOR_ORIGIN || ('http://'+(process.env.HOSTNAME || 'localhost:'+PORT))}/visualizador.html?data=${encodeURIComponent(b64)}`;

      // Notify operator and viewer
      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', viewerPayload);
      
      // Emit show_qr to both operator and viewer
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });

      console.log(`[boomerang_ready] processed viewer=${vid} visualizadorUrl=${visualizadorUrl}`);

    } catch (err) {
      console.error('boomerang_ready handler error', err);
    }
  });

  // CORREÇÃO: Handler para boomerang com dados binários
  socket.on('boomerang_binary', async ({ session, viewerId, filename, data }) => {
    try {
      console.log(`[boomerang_binary] viewer=${viewerId} session=${session}, data size: ${data ? data.byteLength : 0}`);
      
      if (!data || !session) return;

      // Converter ArrayBuffer para Buffer
      const buffer = Buffer.from(data);
      
      // Criar data URL para o vídeo
      const dataUrl = `data:video/webm;base64,${buffer.toString('base64')}`;

      // Criar thumbnail (primeiro frame) para preview
      let previewFrame = null;
      try {
        // Aqui você poderia extrair o primeiro frame do vídeo usando ffmpeg
        // Por enquanto, vamos usar um placeholder
        previewFrame = null; // Implementar extração de thumbnail se necessário
      } catch (e) {
        console.warn('Erro ao criar thumbnail do boomerang:', e);
      }

      // Processar como o boomerang_ready normal
      ensureSession(session);
      const vid = viewerId || uuidv4();
      sessions[session].viewers[vid] = {
        photos: sessions[session].viewers[vid] ? sessions[session].viewers[vid].photos : [],
        storiesMontage: previewFrame,
        print: null,
        boomerang: dataUrl,
        createdAt: (new Date()).toISOString()
      };

      const viewerPayload = {
        photos: sessions[session].viewers[vid].photos || [],
        storiesMontage: previewFrame,
        print: null,
        boomerang: dataUrl,
        createdAt: sessions[session].viewers[vid].createdAt
      };
      
      const payloadStr = JSON.stringify(viewerPayload);
      const b64 = Buffer.from(payloadStr, 'utf8').toString('base64');
      const visualizadorUrl = `${process.env.VISUALIZADOR_ORIGIN || ('http://'+(process.env.HOSTNAME || 'localhost:'+PORT))}/visualizador.html?data=${encodeURIComponent(b64)}`;

      io.to(`session:${session}`).emit('viewer_session_created', { viewerId: vid });
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', viewerPayload);
      io.to(`viewer:${vid}`).emit('show_qr', { visualizadorUrl });
      io.to(`session:${session}`).emit('show_qr_on_viewer', { viewerId: vid, visualizadorUrl });

      console.log(`[boomerang_binary] processed viewer=${vid}`);

    } catch (err) {
      console.error('boomerang_binary handler error', err);
    }
  });

  // create_viewer_session (operator created viewer entry directly)
  socket.on('create_viewer_session', ({ session, photos, storiesMontage, print, boomerang }) => {
    try {
      ensureSession(session);
      const vid = uuidv4();
      sessions[session].viewers[vid] = {
        photos: photos || [],
        storiesMontage: storiesMontage || null,
        print: print || null,
        boomerang: boomerang || null,
        createdAt: (new Date()).toISOString()
      };
      // notify operator (who called)
      socket.emit('viewer_session_created', { viewerId: vid });
      // notify any connected viewer sockets (none likely) and operator room with viewer_photos_ready
      io.to(`viewer:${vid}`).emit('viewer_photos_ready', {
        photos: sessions[session].viewers[vid].photos,
        storiesMontage: sessions[session].viewers[vid].storiesMontage,
        print: sessions[session].viewers[vid].print,
        boomerang: sessions[session].viewers[vid].boomerang,
        createdAt: sessions[session].viewers[vid].createdAt
      });
      io.to(`session:${session}`).emit('viewer_photos_ready', {
        photos: sessions[session].viewers[vid].photos,
        storiesMontage: sessions[session].viewers[vid].storiesMontage,
        print: sessions[session].viewers[vid].print,
        boomerang: sessions[session].viewers[vid].boomerang,
        createdAt: sessions[session].viewers[vid].createdAt
      });
    } catch (e) {
      console.error('create_viewer_session err', e);
    }
  });

  socket.on('show_qr_to_session', ({ session, visualizadorUrl }) => {
    if (!session || !visualizadorUrl) return;
    // send show_qr event to all viewers connected in that session (they will display the QR)
    io.to(`session:${session}`).emit('show_qr', { visualizadorUrl });
    // also send to operators
    io.to(`session:${session}`).emit('show_qr_on_viewer', { visualizadorUrl });
  });

  socket.on('show_qr_on_viewer', ({ viewerId, visualizadorUrl }) => {
    if (!viewerId || !visualizadorUrl) return;
    io.to(`viewer:${viewerId}`).emit('show_qr', { visualizadorUrl });
  });

  socket.on('reset_session', ({ session }) => {
    if (!session) return;
    // clear session data (in-memory)
    if (sessions[session]) {
      sessions[session].viewers = {};
      sessions[session].lastStreamFrame = null;
    }
    io.to(`session:${session}`).emit('reset_session', { session });
  });

  socket.on('disconnect', () => {
    // cleanup operator membership sets
    const sess = socket.data && socket.data.session;
    if (sess && sessions[sess]) {
      sessions[sess].operators.delete(socket.id);
    }
    console.log('[socket] disconnected', socket.id);
  });

});

/* --------------------------
   Start server
   -------------------------- */
server.listen(PORT, () => {
  console.log(`Festadodavi server listening on port ${PORT}`);
  console.log(`FFmpeg available: ${ffmpegAvailable}`);
  console.log(`IMGBB Key: ${IMGBB_KEY ? '✅ Configured' : '❌ Not configured'}`);
});
