/*********************************************************************
 * CABINE FOTOGRÁFICA - SERVER.JS COMPLETO
 * Versão 2025 - Totalmente integrado com frontend (index + celular + visualizador)
 * Mantém todas as funções originais e corrige bugs de sessão, reset e IMGBB
 *********************************************************************/

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// ----------------------------------------------------
// CONFIGURAÇÕES BÁSICAS
// ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

// URL pública do backend (Railway)
const BASE_URL = "https://festadodavi-production-0591.up.railway.app";

// ----------------------------------------------------
// APP E SERVIDOR
// ----------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Health check simples
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Servidor ativo",
    time: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// SERVIDOR HTTP + SOCKET.IO
// ----------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e8,
});

// ----------------------------------------------------
// ESTRUTURAS DE DADOS EM MEMÓRIA
// ----------------------------------------------------
const sessions = {}; // { sessionId: { operator, clients[], photos[], lastStream, ... } }
const viewers = {};  // { viewerId: { photos, storiesMontage, print, createdAt } }

// ----------------------------------------------------
// FUNÇÕES AUXILIARES
// ----------------------------------------------------
function ensureSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      operator: null,
      clients: [],
      photos: [],
      lastStream: null,
      lastViewer: null,
      createdAt: Date.now(),
    };
  }
  return sessions[id];
}

// ----------------------------------------------------
// SOCKET.IO HANDLERS
// ----------------------------------------------------
io.on("connection", (socket) => {
  console.log("📡 Nova conexão:", socket.id);

  // Cliente entra numa sessão
  socket.on("join_session", ({ session, role }) => {
    if (!session) return;
    socket.join(session);
    const s = ensureSession(session);

    if (role === "operator") {
      s.operator = socket.id;
      console.log(`🎛️ Operador conectado à sessão ${session}`);
    } else if (role === "client" || role === "celular") {
      s.clients.push(socket.id);
      console.log(`📱 Celular conectado à sessão ${session}`);
    } else if (role === "viewer") {
      console.log(`👀 Visualizador conectado à sessão ${session}`);
    }

    io.to(session).emit("peer_joined", { id: socket.id, role, session });
    updateViewerCount(session);
  });

  // Stream frame do operador → clientes
  socket.on("stream_frame", ({ session, frame }) => {
    if (!session || !frame) return;
    const s = ensureSession(session);
    s.lastStream = frame;
    io.to(session).emit("stream_frame", { session, frame });
  });

  // Foto enviada (alta resolução)
  socket.on("photo_ready", ({ session, index, viewerId, photo }) => {
    if (!session || !photo) return;
    const s = ensureSession(session);
    s.photos[index] = photo;
    io.to(session).emit("photo_captured", { session, index, photo });
    console.log(`📸 Foto ${index} capturada na sessão ${session}`);
  });

  // Celular envia o pacote de fotos tiradas
  socket.on("photos_submit", ({ session, viewerId, photos }) => {
    if (!session) return;
    const s = ensureSession(session);
    s.photos = photos;
    io.to(session).emit("photos_submit", { viewerId, photos });
    console.log(`📤 photos_submit da sessão ${session}, ${photos?.length} fotos`);
  });

  // Operador cria sessão de visualizador
  socket.on("create_viewer_session", ({ session, photos, storiesMontage, print }) => {
    const viewerId = "v_" + Date.now();
    viewers[viewerId] = { photos, storiesMontage, print, createdAt: new Date().toISOString() };
    const s = ensureSession(session);
    s.lastViewer = viewerId;
    io.to(session).emit("viewer_session_created", { viewerId });
    console.log(`🆕 viewer_session_created para sessão ${session}: ${viewerId}`);
  });

  // Mostrar QR no celular
  socket.on("show_qr_to_session", ({ session, visualizadorUrl }) => {
    io.to(session).emit("show_qr_on_viewer", { visualizadorUrl });
  });

  // Reset da sessão
  socket.on("reset_session", ({ session }) => {
    if (!session) return;
    sessions[session] = ensureSession(session);
    sessions[session].photos = [];
    io.to(session).emit("reset_session", { session });
    console.log(`🔁 reset_session emitido para ${session}`);
  });

  // Pedido para iniciar stream
  socket.on("request_stream", ({ session }) => {
    io.to(session).emit("request_stream", { session });
  });

  // Cliente desconectou
  socket.on("disconnect", () => {
    console.log("❌ Desconectado:", socket.id);
    for (const [sess, data] of Object.entries(sessions)) {
      data.clients = data.clients.filter((id) => id !== socket.id);
      if (data.operator === socket.id) data.operator = null;
      updateViewerCount(sess);
    }
  });
});

// ----------------------------------------------------
// FUNÇÃO AUXILIAR
// ----------------------------------------------------
function updateViewerCount(session) {
  const s = ensureSession(session);
  const viewersCount = s.clients.length;
  io.to(session).emit("viewer_count", { viewers: viewersCount });
}

// ----------------------------------------------------
// ENDPOINTS HTTP
// ----------------------------------------------------

// 🔹 Retorna JSON com dados do visualizador
app.get("/viewer/:id", (req, res) => {
  const v = viewers[req.params.id];
  if (!v) {
    return res.status(404).json({ error: "Visualizador não encontrado" });
  }
  res.json(v);
});

// 🔹 Recebe GET visualizador via ?session=... (modo alternativo)
app.get("/visualizador-data", (req, res) => {
  const session = req.query.session;
  if (!session) return res.status(400).json({ error: "session faltando" });
  const s = sessions[session];
  if (!s || !s.photos?.length) {
    return res.status(404).json({ error: "Sessão não encontrada ou sem fotos" });
  }
  res.json({
    photos: s.photos,
    storiesMontage: s.lastViewer ? viewers[s.lastViewer]?.storiesMontage : null,
    print: s.lastViewer ? viewers[s.lastViewer]?.print : null,
  });
});

// 🔹 Histórico completo de sessões (para recuperação)
app.get("/history", (req, res) => {
  const list = Object.entries(sessions).map(([id, s]) => ({
    sessionId: id,
    photos: s.photos?.length || 0,
    lastViewer: s.lastViewer,
    createdAt: new Date(s.createdAt).toLocaleString(),
  }));
  res.json(list);
});

// ----------------------------------------------------
// SERVIDOR ON-LINE
// ----------------------------------------------------
server.listen(PORT, () => {
  console.log(`✅ Servidor iniciado em ${BASE_URL} (porta ${PORT})`);
});
