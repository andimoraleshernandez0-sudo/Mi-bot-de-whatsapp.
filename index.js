const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Estado global
let sock = null;
let currentQR = null;
let connectionStatus = 'Iniciando servidor...';
let connectedUser = null;
let lastRepliedUsers = new Map();

const RESPUESTAS_PATH = path.join(__dirname, 'respuestas.json');

// Cargar respuestas configuradas
function getRespuestas() {
  try {
    if (fs.existsSync(RESPUESTAS_PATH)) {
      return JSON.parse(fs.readFileSync(RESPUESTAS_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Error leyendo respuestas.json:', err);
  }
  return { activado: true, responderEnGrupos: false, reglas: [] };
}

// Guardar respuestas
function saveRespuestas(data) {
  fs.writeFileSync(RESPUESTAS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// Inicializar conexión Baileys
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_session'));
  const { version } = await fetchLatestBaileysVersion();

  connectionStatus = 'Conectando con WhatsApp...';

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['WhatsApp Bot Servidor', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      connectionStatus = 'Esperando escaneo de Código QR';
      console.log('\n===========================================');
      console.log('NUEVO CÓDIGO QR GENERADO:');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('O abre en el navegador: http://localhost:' + PORT);
      console.log('===========================================\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      currentQR = null;
      connectedUser = null;
      connectionStatus = `Desconectado (Razón: ${statusCode || 'Desconocida'}). Reconectando...`;
      console.log(connectionStatus);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('Sesión cerrada. Borra la carpeta auth_session y reinicia para volver a vincular.');
        connectionStatus = 'Sesión cerrada por el usuario. Necesita nuevo escaneo.';
      }
    } else if (connection === 'open') {
      currentQR = null;
      connectedUser = sock.user ? sock.user.id.split(':')[0] : 'Conectado';
      connectionStatus = 'Conectado con éxito a WhatsApp';
      console.log(`\n✅ ¡BOT CONECTADO EXITOSAMENTE COMO: +${connectedUser}!`);
    }
  });

  // Procesar mensajes entrantes
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const config = getRespuestas();
      if (!config.activado) return;

      for (const msg of chatUpdate.messages) {
        // Ignorar mensajes enviados por el bot
        if (!msg.message || msg.key.fromMe) continue;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');

        // Ignorar grupos si está desactivado
        if (isGroup && !config.responderEnGrupos) continue;

        // Extraer texto del mensaje
        const messageText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''
        ).trim().toLowerCase();

        if (!messageText) continue;

        // Cooldown anti-spam por usuario
        const now = Date.now();
        const cooldown = (config.tiempoEsperaEntreMensajesSegundos || 5) * 1000;
        const lastReply = lastRepliedUsers.get(sender) || 0;

        // Buscar coincidencia en las reglas
        let respuestaEncontrada = null;

        for (const regla of config.reglas) {
          const match = regla.palabrasClave.some(palabra => {
            const p = palabra.toLowerCase().trim();
            // Coincidencia exacta o contenida como palabra
            return messageText === p || messageText.includes(p);
          });

          if (match) {
            respuestaEncontrada = regla.respuesta;
            break;
          }
        }

        // Si no encontró regla pero tiene mensaje por defecto activo
        if (!respuestaEncontrada && config.mensajePorDefectoActivo && (now - lastReply > cooldown * 2)) {
          respuestaEncontrada = config.mensajePorDefecto;
        }

        if (respuestaEncontrada && (now - lastReply > cooldown)) {
          lastRepliedUsers.set(sender, now);
          console.log(`[Auto-Respuesta] Enviando a ${sender.split('@')[0]}: "${messageText}" -> "${respuestaEncontrada.substring(0, 30)}..."`);
          
          await sock.sendMessage(sender, { text: respuestaEncontrada }, { quoted: msg });
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });
}

// -------------------------------------------------------------
// RUTAS DE LA API Y PANEL WEB
// -------------------------------------------------------------

// Estado del servidor
app.get('/api/status', async (req, res) => {
  let qrDataUrl = null;
  if (currentQR) {
    try {
      qrDataUrl = await QRCode.toDataURL(currentQR);
    } catch (err) {
      console.error(err);
    }
  }

  res.json({
    status: connectionStatus,
    isConnected: !!connectedUser,
    user: connectedUser,
    hasQR: !!currentQR,
    qrDataUrl
  });
});

// Solicitar código de vinculación numérico (Pairing Code)
app.post('/api/pairing-code', async (req, res) => {
  try {
    let { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Debes proporcionar un número con código de país (ej: 5491123456789)' });
    }

    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

    if (!sock) {
      return res.status(500).json({ error: 'El servicio de WhatsApp aún no ha iniciado.' });
    }

    if (sock.authState.creds.registered) {
      return res.status(400).json({ error: 'La cuenta ya está registrada y vinculada.' });
    }

    const code = await sock.requestPairingCode(phoneNumber);
    console.log(`[Pairing Code] Generado para +${phoneNumber}: ${code}`);
    res.json({ success: true, pairingCode: code });
  } catch (err) {
    console.error('Error generando pairing code:', err);
    res.status(500).json({ error: err.message || 'Error solicitando código de emparejamiento.' });
  }
});

// Obtener configuración de respuestas
app.get('/api/config', (req, res) => {
  res.json(getRespuestas());
});

// Guardar configuración de respuestas
app.post('/api/config', (req, res) => {
  try {
    saveRespuestas(req.body);
    res.json({ success: true, message: 'Configuración actualizada con éxito.' });
  } catch (err) {
    res.status(500).json({ error: 'Error guardando configuración.' });
  }
});

// Enviar mensaje manual
app.post('/api/send', async (req, res) => {
  try {
    let { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: 'Faltan parámetros to y message.' });
    }

    if (!sock || !connectedUser) {
      return res.status(500).json({ error: 'WhatsApp no está conectado.' });
    }

    to = to.replace(/[^0-9]/g, '');
    const jid = `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: `Mensaje enviado a +${to}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Interfaz Web Dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel de Control - Servidor WhatsApp Bot</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --accent: #22c55e;
      --border: #334155;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
    }
    h1, h2, h3 { margin-top: 0; }
    .status-badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 20px;
      font-weight: bold;
      font-size: 14px;
      background: #334155;
      color: #94a3b8;
    }
    .status-connected { background: #166534; color: #4ade80; }
    .status-waiting { background: #854d0e; color: #fde047; }
    .qr-container {
      text-align: center;
      margin: 20px 0;
    }
    .qr-image {
      background: white;
      padding: 16px;
      border-radius: 8px;
      display: inline-block;
      max-width: 250px;
    }
    input, textarea, button {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #0f172a;
      color: var(--text);
      box-sizing: border-box;
      margin-top: 8px;
      font-size: 15px;
    }
    button {
      background: #2563eb;
      color: white;
      font-weight: bold;
      cursor: pointer;
      border: none;
      margin-top: 14px;
    }
    button:hover { background: #1d4ed8; }
    .rule-item {
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 10px;
      background: #0f172a;
    }
    .keywords { color: #38bdf8; font-weight: bold; }
    .response { color: #cbd5e1; margin-top: 6px; white-space: pre-wrap; }
    .row { display: flex; gap: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Servidor WhatsApp Bot</h1>
    
    <!-- Tarjeta de Estado y Vinculación -->
    <div class="card" aria-live="polite">
      <h2>Estado de la Conexión</h2>
      <p id="statusText">Cargando estado...</p>
      <div id="statusBadge" class="status-badge">Verificando...</div>

      <!-- Sección QR -->
      <div id="qrSection" style="display: none;" class="qr-container">
        <h3>Escanear Código QR</h3>
        <p>Abre WhatsApp en tu teléfono > Menú / Ajustes > <strong>Dispositivos vinculados</strong> > <strong>Vincular dispositivo</strong></p>
        <img id="qrImage" class="qr-image" alt="Código QR de WhatsApp" src="" />
      </div>

      <!-- Sección Pairing Code (Accesible) -->
      <div id="pairingSection" style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px;">
        <h3>O vincular con Código Numérico (Sin cámara)</h3>
        <p>Ingresa tu número de teléfono con código de país (Ejemplo: 5491123456789 para Argentina, 521XXXXXXXXXX para México):</p>
        <input type="text" id="phoneInput" placeholder="Ejemplo: 54911..." />
        <button onclick="requestPairingCode()">Obtener Código de 8 Dígitos</button>
        <div id="pairingCodeResult" style="margin-top: 14px; font-size: 20px; font-weight: bold; color: #22c55e;"></div>
      </div>
    </div>

    <!-- Tarjeta de Respuestas Automáticas -->
    <div class="card">
      <h2>Respuestas Automáticas</h2>
      <p>El bot responderá automáticamente cuando alguien le envíe alguna de las palabras configuradas:</p>
      
      <div id="rulesList">Cargando reglas...</div>

      <h3 style="margin-top: 24px;">Agregar nueva respuesta</h3>
      <label>Palabras clave (separadas por coma):</label>
      <input type="text" id="newKeywords" placeholder="precio, costo, cuanto cuesta" />
      
      <label style="display:block; margin-top: 10px;">Respuesta del bot:</label>
      <textarea id="newResponse" rows="3" placeholder="Escribe aquí el mensaje con el que el bot responderá..."></textarea>
      
      <button onclick="addRule()" style="background: #16a34a;">Guardar Nueva Respuesta</button>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        document.getElementById('statusText').innerText = data.status;
        const badge = document.getElementById('statusBadge');
        
        if (data.isConnected) {
          badge.className = 'status-badge status-connected';
          badge.innerText = 'CONECTADO (+ ' + data.user + ')';
          document.getElementById('qrSection').style.display = 'none';
          document.getElementById('pairingSection').style.display = 'none';
        } else if (data.hasQR) {
          badge.className = 'status-badge status-waiting';
          badge.innerText = 'ESPERANDO ESCANEO';
          document.getElementById('qrSection').style.display = 'block';
          document.getElementById('qrImage').src = data.qrDataUrl;
          document.getElementById('pairingSection').style.display = 'block';
        } else {
          badge.className = 'status-badge';
          badge.innerText = 'INICIANDO...';
          document.getElementById('qrSection').style.display = 'none';
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function requestPairingCode() {
      const phone = document.getElementById('phoneInput').value.trim();
      const resDiv = document.getElementById('pairingCodeResult');
      if (!phone) {
        alert('Por favor escribe tu número de teléfono.');
        return;
      }
      resDiv.innerText = 'Generando código...';
      try {
        const res = await fetch('/api/pairing-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: phone })
        });
        const data = await res.json();
        if (data.pairingCode) {
          resDiv.innerText = 'Tu código de WhatsApp es: ' + data.pairingCode;
        } else {
          resDiv.innerText = 'Error: ' + (data.error || 'No se pudo generar');
        }
      } catch (e) {
        resDiv.innerText = 'Error de conexión.';
      }
    }

    let currentConfig = null;

    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        currentConfig = await res.json();
        const listDiv = document.getElementById('rulesList');
        listDiv.innerHTML = '';

        if (!currentConfig.reglas || currentConfig.reglas.length === 0) {
          listDiv.innerHTML = '<p>No hay respuestas configuradas.</p>';
          return;
        }

        currentConfig.reglas.forEach((r, idx) => {
          const div = document.createElement('div');
          div.className = 'rule-item';
          div.innerHTML = '<div class="keywords">Palabras: ' + r.palabrasClave.join(', ') + '</div>' +
                          '<div class="response">' + r.respuesta + '</div>';
          listDiv.appendChild(div);
        });
      } catch (err) {
        console.error(err);
      }
    }

    async function addRule() {
      const kw = document.getElementById('newKeywords').value.trim();
      const resp = document.getElementById('newResponse').value.trim();

      if (!kw || !resp) {
        alert('Debes ingresar palabras clave y una respuesta.');
        return;
      }

      const palabras = kw.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
      currentConfig.reglas.push({ palabrasClave: palabras, respuesta: resp });

      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentConfig)
      });

      document.getElementById('newKeywords').value = '';
      document.getElementById('newResponse').value = '';
      loadConfig();
      alert('¡Respuesta guardada con éxito!');
    }

    setInterval(checkStatus, 3000);
    checkStatus();
    loadConfig();
  </script>
</body>
</html>`);
});

// Iniciar servidor Express
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🌐 SERVIDOR WEB INICIADO EN: http://localhost:${PORT}`);
  console.log('====================================================');
  connectToWhatsApp();
});
