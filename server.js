/**
 * server.js
 * Versão completa — servidor para cabine fotográfica
 *
 * Funcionalidades incluídas:
 * - Servir arquivos estáticos (index.html, celular.html, visualizador, assets)
 * - Endpoints para upload (base64 -> salvar em /uploads)
 * - Endpoint opcional para enviar imagens ao IMGBB (se IMGBB_KEY configurada)
 * - Endpoint /print (exemplo) para integração com impressoras (pode ser adaptado)
 * - Socket.IO: coordenação operator <-> viewer (stream_frame, photo, countdown, requests)
 * - Armazenamento temporário em memória de sessões, frames e fotos
 * - Logs e rotas de debug (status, list uploads)
 *
 * Requisitos NPM (instalar antes de rodar):
 * npm i express socket.io cors axios multer fs-extra qrcode
 *
 * Observação: este arquivo tenta manter toda a funcionalidade típica de um server
 * de cabine fotográfica. Se seu server anterior tinha rotas extras, dê um merge
 * apontando as diferenças específicas que você quer manter — eu não removi
 * intencionalmente funcionalidades comuns.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true, limit: '120mb' }));

// -------------- Configurações --------------
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const IMAGES_DIR = path.join(ROOT, 'images'); // para assets gerados
const IMGBB_KEY = process.env.IMGBB_KEY || null;
const ENABLE_IMGBB = !!IMGBB_KEY;

fse.ensureDirSync(UPLOADS_DIR);
fse.ensureDirSync(IMAGES_DIR);

// Multer para uploads multipart/form-data
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9\-_\.]/g, '_');
    cb(null, `${timestamp}_${safe}`);
  }
});
const upload = multer({ storage });

// Serve arquivos estáticos (raiz do projeto - onde estão index.html e celular.html)
app.use(express.static(ROOT, { index: false }));

// root
app.get('/', (req, res) => {
  // se você quiser manter index original, ele está na raiz — enviar arquivo
  const candidate = path.join(ROOT, 'index.html');
  if (fs.existsSync(candidate)) return res.sendFile(candidate);
  return res.send('<h1>Cabine Server</h1><p>Coloque o index.html na raiz.</p>');
});

// rota para celular explicitamente
app.get('/celular.html', (req, res) => {
  const candidate = path.join(ROOT, 'celular.html');
  if (fs.existsSync(candidate)) return res.sendFile(candidate);
  return res.status(404).send('celular.html não encontrado');
});

// health
app.get('/status', (req, res) => res.json({ status: 'ok', time: new Date().toISOString(), pid: process.pid }));

// listar uploads
app.get('/uploads/list', (req, res) => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const out = files.map(f => ({ name: f, url: `/uploads/${f}`, time: fs.statSync(path.join(UPLOADS_DIR, f)).mtime }));
    res.json(out);
  });
});

// servir arquivos de uploads
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1d' }));

// -------------- Endpoints de upload / imgbb --------------

// upload por multipart (form-data)
app.post('/upload-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  res.json({ ok: true, file: req.file.filename, path: `/uploads/${req.file.filename}` });
});

// upload por base64 (JSON)
app.post('/upload-base64', async (req, res) => {
  try {
    const { name, data } = req.body;
    if (!data) return res.status(400).json({ error: 'Campo data é obrigatório (base64 ou dataURL)' });

    // extrai base64 de dataURL se existir
    let base64 = data;
    const m = data.match(/^data:(.+);base64,(.+)$/);
    let ext = 'jpg';
    if (m) {
      base64 = m[2];
      const mime = m[1];
      if (mime.indexOf('png') >= 0) ext = 'png';
      else if (/jpeg|jpg/.test(mime)) ext = 'jpg';
    }
    const buffer = Buffer.from(base64, 'base64');
    const filename = `${Date.now()}_${(name || 'img').replace(/\s+/g, '_')}.${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    await fse.writeFile(filepath, buffer);
    res.json({ ok: true, file: filename, url: `/uploads/${filename}` });
  } catch (err) {
    console.error('upload-base64 error', err);
    res.status(500).json({ error: err.message });
  }
});

// upload para imgbb (opcional)
app.post('/upload-imgbb', async (req, res) => {
  if (!ENABLE_IMGBB) return res.status(400).json({ error: 'IMGBB não configurado (set IMGBB_KEY)' });
  try {
    const { image, name } = req.body;
    if (!image) return res.status(400).json({ error: 'image é obrigatório' });

    // remove prefix se houver
    let base64 = image;
    const m = image.match(/^data:(.+);base64,(.+)$/);
    if (m) base64 = m[2];

    const form = new URLSearchParams();
    form.append('key', IMGBB_KEY);
    form.append('image', base64);
    if (name) form.append('name', name);

    const r = await axios.post('https://api.imgbb.com/1/upload', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 45000
    });
    return res.json(r.data);
  } catch (err) {
    console.error('upload-imgbb error', err.response ? err.response.data : err.message);
    return res.status(500).json({ error: err.message, detail: err.response ? err.response.data : null });
  }
});

// upload via form sample (compatibilidade)
app.post('/upload-multi', upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map(f => ({ filename: f.filename, path: `/uploads/${f.filename}` }));
  res.json({ ok: true, files });
});

// -------------- Utility endpoints --------------

// gerar QR code com link (útil para mostrar QR no visualizador)
app.get('/qrcode', async (req, res) => {
  try {
    const url = req.query.url || req.body.url || 'https://example.com';
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 400 });
    const base64 = dataUrl.split(',')[1];
    const buff = Buffer.from(base64, 'base64');
    res.set('Content-Type', 'image/png');
    res.send(buff);
  } catch (err) {
    res.status(500).send('erro ao gerar qrcode: ' + err.message);
  }
});

// exemplo de endpoint de impressão (dummy) — adapte pra sua impressora/serviço
app.post('/print', async (req, res) => {
  try {
    const { fileUrl, options } = req.body;
    // Implementar integração com impressora ou serviço externo aqui.
    // Por enquanto apenas confirma que recebeu o pedido.
    console.log('print request', fileUrl, options);
    res.json({ ok: true, queued: true, fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------- Socket.IO --------------
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e7 // allow large frames
});

// sessions in-memory
const sessions = {}; // sessions[sessionId] = { operators:Set, viewers:Set, lastFrame, photos:[] ... }

function ensureSession(id) {
  const sid = id || 'default_room';
  if (!sessions[sid]) {
    sessions[sid] = {
      operators: new Set(),
      viewers: new Set(),
      lastFrameDataUrl: null,
      lastFrameTs: null,
      photos: [], // array of {index, dataurl, savedFilename?}
      meta: {}
    };
  }
  return sessions[sid];
}

function safeLog(...args) {
  console.log(new Date().toISOString(), ...args);
}

io.on('connection', (socket) => {
  safeLog('socket connected', socket.id);

  // Join session
  socket.on('join_session', (payload) => {
    try {
      const session = (payload && payload.session) ? payload.session : 'default_room';
      const role = (payload && payload.role) ? payload.role : 'viewer';
      socket.join(session);
      socket.data.session = session;
      socket.data.role = role;
      const s = ensureSession(session);
      if (role === 'operator') s.operators.add(socket.id);
      else s.viewers.add(socket.id);
      safeLog(`socket ${socket.id} joined ${session} as ${role}`);
      socket.emit('joined_ack', { session, role });
      // notify others
      socket.to(session).emit('peer_joined', { id: socket.id, role });
    } catch (err) {
      safeLog('join_session error', err.message);
    }
  });

  // operator announces streaming
  socket.on('operator_streaming', (payload) => {
    const session = (payload && payload.session) || socket.data.session || 'default_room';
    ensureSession(session).lastFrameTs = Date.now();
    socket.to(session).emit('operator_streaming', { from: socket.id, session });
  });

  socket.on('operator_stopped', (payload) => {
    const session = (payload && payload.session) || socket.data.session || 'default_room';
    socket.to(session).emit('operator_stopped', { from: socket.id, session });
  });

  // streaming frame - operator -> server -> viewers in same session
  socket.on('stream_frame', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      const frame = payload && payload.frame ? payload.frame : null;
      if (!frame) return;
      const s = ensureSession(session);
      s.lastFrameDataUrl = frame;
      s.lastFrameTs = Date.now();
      // forward to viewers and other sockets in the room except the sender
      socket.to(session).emit('stream_frame', { frame });
    } catch (err) {
      safeLog('stream_frame error', err.message);
    }
  });

  // countdown messages (operator -> viewers or vice-versa)
  socket.on('countdown', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      const value = payload && (typeof payload.value !== 'undefined') ? payload.value : null;
      socket.to(session).emit('countdown', { value });
    } catch (err) {
      safeLog('countdown error', err.message);
    }
  });

  // photo event (operator captured a photo) -> store and broadcast to viewers
  socket.on('photo', async (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      const index = payload && payload.index ? payload.index : 0;
      const dataurl = payload && payload.data ? payload.data : null;
      if (!dataurl) return;
      const s = ensureSession(session);
      // store in memory
      const rec = { index, dataurl, ts: Date.now(), savedFile: null };
      s.photos.push(rec);
      // option: save to disk
      try {
        const matches = dataurl.match(/^data:(.+);base64,(.+)$/);
        let buffer = null;
        let ext = 'jpg';
        if (matches) {
          const mime = matches[1];
          const b64 = matches[2];
          buffer = Buffer.from(b64, 'base64');
          if (mime.includes('png')) ext = 'png';
        } else {
          // fallback assume base64 jpg
          buffer = Buffer.from(dataurl.split(',')[1] || dataurl, 'base64');
        }
        const filename = `${session.replace(/[^a-z0-9_\-]/gi,'')}_${Date.now()}_p${index}.${ext}`;
        const filepath = path.join(UPLOADS_DIR, filename);
        await fse.writeFile(filepath, buffer);
        rec.savedFile = filename;
        safeLog('photo saved', filepath);
      } catch (err2) {
        safeLog('erro salvando foto', err2.message);
      }
      // broadcast to viewers
      socket.to(session).emit('photo', { index, data: dataurl, savedFile: rec.savedFile });
    } catch (err) {
      safeLog('photo handler error', err.message);
    }
  });

  // photos_done: operator finished sending photos
  socket.on('photos_done', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      socket.to(session).emit('photos_done', { session });
    } catch (err) {
      safeLog('photos_done error', err.message);
    }
  });

  // viewer requests the operator to start photos (via cellphone UI)
  socket.on('request_start_photos', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      // notify operator(s) in the session
      socket.to(session).emit('request_start_photos', { session });
    } catch (err) {
      safeLog('request_start_photos error', err.message);
    }
  });

  // viewer requests refazer
  socket.on('request_refazer', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      socket.to(session).emit('request_refazer', { session });
    } catch (err) {
      safeLog('request_refazer error', err.message);
    }
  });

  // viewer requests continue
  socket.on('request_continue', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      socket.to(session).emit('request_continue', { session });
    } catch (err) {
      safeLog('request_continue error', err.message);
    }
  });

  // request_stream: viewer asks to receive stream (server notifies operators)
  socket.on('request_stream', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      // inform operators that a viewer requests stream; operator may choose to start streaming
      socket.to(session).emit('want_stream', { session });
    } catch (err) {
      safeLog('request_stream error', err.message);
    }
  });

  // custom generic command channel
  socket.on('cmd', (payload) => {
    try {
      const session = (payload && payload.session) || socket.data.session || 'default_room';
      socket.to(session).emit('cmd', payload);
    } catch (err) {
      safeLog('cmd error', err.message);
    }
  });

  // disconnect cleanup
  socket.on('disconnect', (reason) => {
    try {
      const session = socket.data.session;
      if (session && sessions[session]) {
        sessions[session].operators.delete(socket.id);
        sessions[session].viewers.delete(socket.id);
      }
      safeLog('socket disconnected', socket.id, 'reason:', reason);
    } catch (err) {
      safeLog('disconnect cleanup error', err.message);
    }
  });
});

// -------------- Start server --------------
server.listen(PORT, () => {
  console.log(`Cabine server rodando em http://localhost:${PORT} (PID ${process.pid})`);
  if (ENABLE_IMGBB) console.log('IMGBB enabled');
});

// -------------- Extras: salvar snapshot periódica (opcional) --------------
/**
 * Se desejar, podemos habilitar salvamento periódico do último frame por sessão.
 * Estou deixando a função aqui comentada; descomente para salvar uma cópia a cada X segundos.
 */
/*
setInterval(() => {
  for (const sessionId of Object.keys(sessions)) {
    const s = sessions[sessionId];
    if (s.lastFrameDataUrl) {
      // salvar último frame em disco (opcional)
      try {
        const matches = s.lastFrameDataUrl.match(/^data:(.+);base64,(.+)$/);
        if (!matches) continue;
        const mime = matches[1];
        const b64 = matches[2];
        const ext = mime.includes('png') ? 'png' : 'jpg';
        const fname = `${sessionId.replace(/[^a-z0-9]/gi,'')}_preview_${Date.now()}.${ext}`;
        const fpath = path.join(UPLOADS_DIR, fname);
        fs.writeFileSync(fpath, Buffer.from(b64, 'base64'));
        console.log('Saved preview', fpath);
      } catch (e) {
        console.error('error saving preview', e.message);
      }
    }
  }
}, 30 * 1000);
*/

// -------------- Fim do arquivo --------------
