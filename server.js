/**************************************************************************
 * SERVER.JS — Cabine Fotográfica com Boomerang + IMGBB + Visualizador
 * Backend oficial: https://festadodavi-production-0591.up.railway.app
 *
 * Mantido tudo original, apenas adicionando o suporte ao upload de boomerang.
 **************************************************************************/

import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import multer from "multer";
import cors from "cors";
import { fileURLToPath } from "url";
import child_process from "child_process";

// ======================================================
// CONFIGURAÇÕES BÁSICAS
// ======================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ======================================================
// PASTAS
// ======================================================
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const BOOMERANG_DIR = path.join(UPLOADS_DIR, "boomerangs");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(BOOMERANG_DIR)) fs.mkdirSync(BOOMERANG_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

// ======================================================
// MULTER — Upload handler
// ======================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BOOMERANG_DIR),
  filename: (req, file, cb) => {
    const original = file.originalname || "boomerang.webm";
    const safe = original.replace(/[^\w\.-]/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage });

// ======================================================
// SOCKET.IO
// ======================================================
const sessions = new Map(); // sessionId -> { clients: Set<socket.id>, photos: [...] }

io.on("connection", (socket) => {
  console.log(`🔌 Conectado: ${socket.id}`);

  socket.on("join_session", ({ session, role }) => {
    socket.join(session);
    socket.data.session = session;
    socket.data.role = role || "unknown";
    if (!sessions.has(session)) sessions.set(session, { clients: new Set(), photos: [] });
    sessions.get(session).clients.add(socket.id);
    console.log(`📡 ${socket.id} entrou na sessão ${session} (${role})`);
    io.to(session).emit("viewer_count", { viewers: io.sockets.adapter.rooms.get(session)?.size || 1 });
  });

  socket.on("join_viewer", ({ viewerId }) => {
    socket.join(viewerId);
    socket.data.viewerId = viewerId;
    console.log(`👁️  ${socket.id} entrou como viewer: ${viewerId}`);
    socket.emit("viewer_photos_ready", viewerSessions.get(viewerId) || {});
  });

  socket.on("stream_frame", ({ session, frame }) => {
    socket.to(session).emit("stream_frame", { session, frame });
  });

  socket.on("photo_ready", ({ session, index, viewerId, photo }) => {
    console.log(`📸 Foto recebida sessão=${session}, viewer=${viewerId}`);
    io.to(session).emit("photo_ready", { index, viewerId, photo });
  });

  socket.on("photos_submit", (payload) => {
    console.log(`📥 photos_submit: ${JSON.stringify(payload).substring(0, 200)}`);
    io.to(payload.session || socket.data.session).emit("photos_submit", payload);
  });

  socket.on("create_viewer_session", ({ session, photos, storiesMontage, print }) => {
    const viewerId = "viewer_" + Date.now() + "_" + Math.floor(Math.random() * 9999);
    viewerSessions.set(viewerId, { photos, storiesMontage, print });
    io.to(session).emit("viewer_session_created", { viewerId });
    console.log(`🎉 viewer_session_created ${viewerId}`);
  });

  socket.on("show_qr_to_session", ({ session, visualizadorUrl }) => {
    io.to(session).emit("show_qr_to_session", { visualizadorUrl });
  });

  socket.on("show_qr_on_viewer", ({ viewerId, visualizadorUrl }) => {
    io.to(viewerId).emit("show_qr_on_viewer", { visualizadorUrl });
  });

  socket.on("boomerang_ready", (data) => {
    console.log(`📼 boomerang_ready recebido (${typeof data})`);
    // retransmitir para todos os operadores
    io.emit("boomerang_ready", data);
  });

  socket.on("reset_session", ({ session }) => {
    if (sessions.has(session)) {
      sessions.get(session).photos = [];
      console.log(`♻️ Sessão ${session} resetada`);
    }
    io.to(session).emit("reset_session", { session });
  });

  socket.on("disconnect", () => {
    const session = socket.data.session;
    if (session && sessions.has(session)) {
      sessions.get(session).clients.delete(socket.id);
      io.to(session).emit("viewer_count", {
        viewers: io.sockets.adapter.rooms.get(session)?.size || 0,
      });
    }
    console.log(`❌ Desconectado: ${socket.id}`);
  });
});

// ======================================================
// VIEWER SESSIONS (dados temporários)
// ======================================================
const viewerSessions = new Map();

// ======================================================
// ENDPOINTS
// ======================================================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    viewerSessions: viewerSessions.size,
    sessions: sessions.size,
  });
});

// Upload de Boomerang
app.post("/upload_boomerang", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Arquivo não enviado" });

    const inputPath = file.path;
    const ext = path.extname(file.originalname).toLowerCase();
    const outputBase = path.basename(file.filename, ext);
    const outputPath = path.join(BOOMERANG_DIR, outputBase + ".mp4");

    // Se tiver ffmpeg, converte
    let ffmpegFound = false;
    try {
      child_process.execSync("ffmpeg -version", { stdio: "ignore" });
      ffmpegFound = true;
    } catch {
      ffmpegFound = false;
    }

    if (ffmpegFound) {
      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset veryfast -crf 28 -movflags +faststart "${outputPath}"`;
        child_process.exec(cmd, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      console.log("🎬 Boomerang convertido para MP4:", outputPath);
    }

    const publicPath = `/uploads/boomerangs/${ffmpegFound ? outputBase + ".mp4" : file.filename}`;
    const fullUrl = `${process.env.BASE_URL || "https://festadodavi-production-0591.up.railway.app"}${publicPath}`;
    console.log("✅ Upload Boomerang concluído:", fullUrl);

    res.json({ url: fullUrl });
  } catch (err) {
    console.error("❌ Erro upload boomerang:", err);
    res.status(500).json({ error: err.message });
  }
});

// Página raiz
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ======================================================
// SERVER START
// ======================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
