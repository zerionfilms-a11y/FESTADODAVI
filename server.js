// server (1).js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();

// CORS MÁXIMO - PERMITIR TUDO (mantive seu comportamento original)
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://agoraequeeuquerover.vercel.app',
    'https://agoraequeeuquerover-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:10000'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-socket-id');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// SERVIÇO DE ARQUIVOS ESTÁTICOS (mantido)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (path.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
    }
  }
}));

// ROTAS PARA OS ARQUIVOS PRINCIPAIS (mantidas)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/celular.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'celular.html'));
});

app.get('/visualizador.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'visualizador.html'));
});

// ROTAS PARA AS IMAGENS (mantidas)
app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logo.png'));
});

app.get('/caralho (1).png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'caralho (1).png'));
});

app.get('/imprimir (1).png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'imprimir (1).png'));
});

app.get('/clack.mp3', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'clack.mp3'));
});

const server = http.createServer(app);

// ✅ CORREÇÃO: Socket.IO com configurações mais robustas (mantive)
const io = new Server(server, {
  cors: {
    origin: [
      'https://agoraequeeuquerover.vercel.app',
      'https://agoraequeeuquerover.onrender.com',
      'http://localhost:3000',
      'http://localhost:10000'
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000,
  connectTimeout: 30000,
  maxHttpBufferSize: 1e8,
  allowEIO3: true
});

// ✅ CORREÇÃO: Sessão FIXA para o celular (sempre a mesma)
const FIXED_SESSION_ID = "cabine-fixa";
// Sessões do visualizador (cada cliente tem sua própria)
const viewerSessions = {};

// Sua chave IMGBB já estava no arquivo
const IMGBB_API_KEY = "6734e028b20f88d5795128d242f85582";

// Função uploadToImgbb (mantive o seu robusto com retries / timeout)
async function uploadToImgbb(imageData, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📤 Tentativa ${attempt}/${retries} - Iniciando upload para IMGBB.`);
            
            const base64Data = (imageData && imageData.split(',') && imageData.split(',')[1]) ? imageData.split(',')[1] : imageData;
            if (!base64Data) {
                console.error('❌ Dados base64 inválidos');
                return null;
            }
            
            // Calcular tamanho da imagem
            const imageSizeKB = Buffer.byteLength(base64Data, 'base64') / 1024;
            console.log(`📊 Tamanho da imagem: ${Math.round(imageSizeKB)}KB`);
            
            // Verificar se a imagem é muito grande
            if (imageSizeKB > 10000) { // 10MB
                console.error('❌ Imagem muito grande para IMGBB (>10MB)');
                return null;
            }
            
            const formData = new URLSearchParams();
            formData.append('key', IMGBB_API_KEY);
            formData.append('image', base64Data);

            // AbortController para timeout
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000); // 30 segundos
            
            console.log(`🔗 Enviando para IMGBB...`);
            const response = await fetch('https://api.imgbb.com/1/upload', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) {
                console.error(`❌ IMGBB retornou status ${response.status}`);
                if (attempt < retries) {
                  await new Promise(r => setTimeout(r, 2000 * attempt));
                  continue;
                }
                return null;
            }
            
            const data = await response.json();
            
            if (data.success) {
                console.log(`✅ Upload IMGBB bem-sucedido: ${data.data.url}`);
                return data.data.url;
            } else {
                console.error(`❌ Upload IMGBB falhou: ${data.error?.message || 'Erro desconhecido'}`);
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                    continue;
                }
                return null;
            }
        } catch (error) {
            console.error(`❌ Erro no upload IMGBB (tentativa ${attempt}):`, (error && error.message) ? error.message : error);
            if (attempt < retries) {
                console.log(`🔄 Tentando novamente em ${2 * attempt} segundos.`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            } else {
                console.error(`💥 Todas as tentativas falharam para upload IMGBB`);
                return null;
            }
        }
    }
}

io.on('connection', (socket) => {
  console.log('🔌 NOVA CONEXÃO - socket:', socket.id, 'origin:', socket.handshake.headers.origin);

  // Operator: create a new session (para celular)
  socket.on('operator_connected', () => {
    socket.join(FIXED_SESSION_ID);
    console.log(`🎮 OPERADOR conectado à sessão fixa: ${FIXED_SESSION_ID}`);
    
    // Notificar que a sessão está pronta
    socket.emit('session_ready', { sessionId: FIXED_SESSION_ID });
  });

  // Celular sempre usa a sessão FIXA
  socket.on('cell_connected', () => {
    socket.join(FIXED_SESSION_ID);
    console.log(`📱 CELULAR conectado à sessão fixa: ${FIXED_SESSION_ID}`);
  });

  // Melhorado: create_viewer_session com upload p/ IMGBB (mantive seu fluxo)
  socket.on('create_viewer_session', async ({ photos, storiesMontage }) => {
    console.log(`\n🔄🔄🔄 CREATE_VIEWER_SESSION INICIADO 🔄🔄🔄`);
    console.log(`📍 Sessão FIXA: ${FIXED_SESSION_ID}`);
    console.log(`📸 Quantidade de fotos: ${photos ? photos.length : 0}`);
    console.log(`🖼️ Stories Montage: ${storiesMontage ? 'Sim' : 'Não'}`);
    console.log(`🔌 Socket ID: ${socket.id}`);

    if (!photos || !Array.isArray(photos)) {
        console.error('❌❌❌ ERRO: Dados inválidos para create_viewer_session');
        socket.emit('viewer_session_error', { error: 'Dados inválidos' });
        return;
    }

    try {
        console.log('🚀 Iniciando uploads para IMGBB...');

        // Fazer upload de cada foto para IMGBB
        const uploadedUrls = [];
        let successCount = 0;
        
        for (let i = 0; i < photos.length; i++) {
            console.log(`📤 Enviando foto ${i+1} para IMGBB.`);
            try {
                const imgbbUrl = await uploadToImgbb(photos[i], 2); // 2 tentativas
                if (imgbbUrl) {
                    uploadedUrls.push(imgbbUrl);
                    successCount++;
                    console.log(`✅ Foto ${i+1} enviada: ${imgbbUrl}`);
                } else {
                    console.log(`❌ Falha no upload da foto ${i+1} — fallback para data URL`);
                    uploadedUrls.push(photos[i]); // Fallback para data URL
                }
            } catch (error) {
                console.error(`❌ Erro no upload da foto ${i+1}:`, error && error.message ? error.message : error);
                uploadedUrls.push(photos[i]); // Fallback para data URL
            }
            
            // Pequena pausa entre uploads para não sobrecarregar
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Upload da moldura do stories para IMGBB (se houver)
        let storiesUrl = null;
        if (storiesMontage) {
            console.log('📤 Enviando moldura do stories para IMGBB.');
            try {
                storiesUrl = await uploadToImgbb(storiesMontage, 2);
                if (storiesUrl) {
                    console.log(`✅ Moldura stories enviada: ${storiesUrl}`);
                } else {
                    console.log('❌ Falha no upload da moldura do stories - usando fallback');
                    storiesUrl = storiesMontage; // Fallback
                }
            } catch (error) {
                console.error('❌ Erro no upload da moldura:', error && error.message ? error.message : error);
                storiesUrl = storiesMontage; // Fallback
            }
        }

        // Criar sessão do visualizador com TTL (7 dias) — já estava no seu código
        const viewerId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        viewerSessions[viewerId] = {
            originalSession: FIXED_SESSION_ID,
            photos: photos,
            photosImgbb: uploadedUrls,
            storiesMontage: storiesMontage,
            storiesMontageImgbb: storiesUrl,
            createdAt: new Date().toISOString(),
            expiresAt // iso string
        };

        console.log(`🎯 Sessão do visualizador criada: ${viewerId}`);
        console.log(`📊 Resumo: ${successCount}/${photos.length} fotos enviadas com sucesso para IMGBB`);
        console.log(`🖼️ Stories: ${storiesUrl ? 'Enviado para IMGBB' : 'Fallback para data URL'}`);
        
        // Emito também expiresAt para o operador salvar no localStorage
        socket.emit('viewer_session_created', { viewerId, expiresAt });

    } catch (error) {
        console.error('❌ Erro ao criar sessão do visualizador:', error && error.message ? error.message : error);
        socket.emit('viewer_session_error', { error: error.message || String(error) });
    }
  });

  // Join room para visualizador
  socket.on('join_viewer', (data) => {
    const viewerId = (data && data.viewerId) || data;
    if (!viewerId) return;
    
    // manter o formato de sala anterior (você usava viewer_<id> em logs)
    socket.join(`viewer_${viewerId}`);
    console.log(`👀 ${socket.id} entrou no visualizador: ${viewerId}`);
    
    // Enviar dados completos para o visualizador (se existir)
    if (viewerSessions[viewerId]) {
      socket.emit('viewer_photos_ready', {
        photos: viewerSessions[viewerId].photos,
        photosImgbb: viewerSessions[viewerId].photosImgbb,
        storiesMontage: viewerSessions[viewerId].storiesMontage,
        storiesMontageImgbb: viewerSessions[viewerId].storiesMontageImgbb
      });
    } else {
      console.log(`❌ Visualizador não encontrado: ${viewerId}`);
      socket.emit('viewer_not_found', { viewerId });
    }
  });

  // celular -> server: photos_from_cell (mantive)
  socket.on('photos_from_cell', ({ photos, attempt }) => {
    console.log(`\n📸📸📸 RECEBENDO FOTOS DO CELULAR 📸📸📸`);
    console.log(`📍 Sessão FIXA: ${FIXED_SESSION_ID}`);
    console.log(`🖼️  Quantidade de fotos: ${photos ? photos.length : 'NENHUMA'}`);
    console.log(`🔄 Tentativa: ${attempt || 1}`);
    console.log(`🔌 Socket ID: ${socket.id}`);

    if (!photos || !Array.isArray(photos)) {
      console.error('❌❌❌ ERRO CRÍTICO: photos não é array válido');
      return;
    }

    console.log(`💾 ${photos.length} fotos recebidas na sessão fixa ${FIXED_SESSION_ID}`);
    
    // Enviar fotos para TODOS os operadores na sessão fixa
    const room = io.sockets.adapter.rooms.get(FIXED_SESSION_ID);
    const clientCount = room ? room.size : 0;
    
    console.log(`📤 ENVIANDO PARA ${clientCount} CLIENTES NA SALA ${FIXED_SESSION_ID}`);
    
    if (clientCount > 0) {
      io.to(FIXED_SESSION_ID).emit('photos_ready', photos);
      console.log(`✅✅✅ FOTOS ENVIADAS COM SUCESSO PARA O OPERADOR`);
    } else {
      console.error(`❌❌❌ NENHUM OPERADOR NA SALA ${FIXED_SESSION_ID}`);
    }
  });

  // celular informs it entered fullscreen
  socket.on('cell_entered_fullscreen', () => {
    io.to(FIXED_SESSION_ID).emit('cell_entered_fullscreen');
    console.log(`📵 Celular entrou em tela cheia na sessão fixa ${FIXED_SESSION_ID}`);
  });

  // operator clicks End session (mantive)
  socket.on('end_session', () => {
    // Apenas notificar o celular para resetar, sem afetar visualizadores
    io.to(FIXED_SESSION_ID).emit('reset_session');
    console.log(`🧹 Sessão finalizada - Celular resetado`);
  });

  socket.on('disconnect', (reason) => {
    console.log('🔌 socket disconnect', socket.id, reason);
  });
});

// --- NOVA ROTA: fallback HTTP para o visualizador pegar sessão se o socket emitir viewer_not_found ---
// GET /api/viewer/:viewerId
app.get('/api/viewer/:viewerId', (req, res) => {
  const viewerId = req.params.viewerId;
  const session = viewerSessions[viewerId];
  if (!session) {
    return res.status(404).json({ error: 'viewer_not_found' });
  }

  // Normalizar fotos (se forem array de objetos ou strings)
  const photos = (session.photosImgbb && session.photosImgbb.length) ? session.photosImgbb : session.photos;
  const storiesMontage = session.storiesMontageImgbb || session.storiesMontage || null;

  res.json({
    viewerId,
    photos,
    storiesMontage,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  });
});

// --- NOVA ROTA: proxy de download que valida se a foto pertence à sessão ---
// GET /api/download?viewerId=...&url=...
const ALLOWED_HOSTNAMES = ['i.imgbb.com', 'ibb.co', 'i.ibb.co', 'i.postimg.cc']; // ajuste conforme necessário

app.get('/api/download', async (req, res) => {
  try {
    const { viewerId, url } = req.query;
    if (!viewerId || !url) return res.status(400).send('viewerId e url são necessários');

    const session = viewerSessions[viewerId];
    if (!session) return res.status(404).send('sessão não encontrada');

    // Normalizar array de fotos (strings ou objetos com url)
    const photosList = (session.photosImgbb && session.photosImgbb.length)
      ? session.photosImgbb
      : session.photos;

    const matched = photosList.find(p => {
      if (!p) return false;
      if (typeof p === 'string') return p === url;
      if (typeof p === 'object' && p.url) return p.url === url;
      return false;
    });

    if (!matched) return res.status(403).send('Foto não pertence a essa sessão');

    // Validar hostname para evitar SSRF
    const parsed = new URL(url);
    if (!ALLOWED_HOSTNAMES.includes(parsed.hostname)) {
      return res.status(403).send('Host não autorizado');
    }

    // Fetch upstream e stream direto (sem carregar tudo em memória)
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send('Falha ao obter imagem do upstream');

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const ext = (contentType.split('/')[1] || '').split(';')[0];
    const filename = `photo-${Date.now()}.${ext || 'jpg'}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Em Node, response.body é um stream — pipe para o res
    if (upstream.body && typeof upstream.body.pipe === 'function') {
      upstream.body.pipe(res);
    } else {
      // fallback: buffer
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    }
  } catch (err) {
    console.error('Erro no /api/download', err && err.message ? err.message : err);
    res.status(500).send('Erro interno no download');
  }
});

// Health check endpoint (mantido)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    fixedSession: FIXED_SESSION_ID,
    viewerSessions: Object.keys(viewerSessions).length,
    timestamp: new Date().toISOString()
  });
});

// Limpar sessões expiradas a cada hora (mantido)
setInterval(() => {
  const now = new Date();
  let expiredCount = 0;
  
  Object.keys(viewerSessions).forEach(viewerId => {
    if (new Date(viewerSessions[viewerId].expiresAt) < now) {
      delete viewerSessions[viewerId];
      expiredCount++;
    }
  });
  
  if (expiredCount > 0) {
    console.log(`🗑️ Limpas ${expiredCount} sessões do visualizador expiradas`);
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server listening on port', PORT);
  console.log('🔓 CORS totalmente liberado');
  console.log('📁 Servindo arquivos estáticos');
  console.log(`📱 SESSÃO FIXA DO CELULAR: ${FIXED_SESSION_ID}`);
});
