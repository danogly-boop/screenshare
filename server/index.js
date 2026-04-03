const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ══════════════════════════════════════════════
// СТРУКТУРЫ ДАННЫХ
// ══════════════════════════════════════════════
// rooms: roomId → {
//   host: ws | null,          — хост (шарит экран)
//   extension: ws | null,     — расширение Chrome на ПК хоста
//   guests: Set<ws>,          — гости (смотрят и управляют)
// }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { host: null, extension: null, guests: new Set() });
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.host && !room.extension && room.guests.size === 0) {
    rooms.delete(roomId);
  }
}

// ══════════════════════════════════════════════
// WEBSOCKET СЕРВЕР — один для всех
// ══════════════════════════════════════════════
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.roomId = null;
  ws.guestId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', (e) => console.error('ws error:', e.message));
});

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

// ══════════════════════════════════════════════
// ОБРАБОТКА СООБЩЕНИЙ
// ══════════════════════════════════════════════
async function handleMessage(ws, msg) {

  // ── HOST создаёт комнату ──
  if (msg.type === 'host-create') {
    const roomId = crypto.randomBytes(4).toString('hex').toUpperCase();
    const room = getOrCreateRoom(roomId);
    room.host = ws;
    ws.role = 'host';
    ws.roomId = roomId;
    send(ws, { type: 'room-created', roomId });
    console.log(`[${roomId}] Host created room`);
    return;
  }

  // ── РАСШИРЕНИЕ подключается к комнате ──
  if (msg.type === 'extension-join') {
    const roomId = (msg.roomId || '').toUpperCase().trim();
    const room = getOrCreateRoom(roomId);
    room.extension = ws;
    ws.role = 'extension';
    ws.roomId = roomId;
    send(ws, { type: 'joined-ack', roomId });
    // Уведомить хоста и гостей что расширение подключено
    if (room.host) send(room.host, { type: 'extension-connected' });
    room.guests.forEach(g => send(g, { type: 'extension-connected' }));
    console.log(`[${roomId}] Extension connected`);
    return;
  }

  // ── ГОСТЬ входит в комнату ──
  if (msg.type === 'guest-join') {
    const roomId = (msg.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room) {
      send(ws, { type: 'error', message: 'Комната не найдена' });
      return;
    }
    if (!room.host || room.host.readyState !== 1) {
      send(ws, { type: 'error', message: 'Хост не подключён' });
      return;
    }
    room.guests.add(ws);
    ws.role = 'guest';
    ws.roomId = roomId;
    ws.guestId = crypto.randomBytes(2).toString('hex');

    send(ws, {
      type: 'joined',
      roomId,
      extensionConnected: !!(room.extension && room.extension.readyState === 1),
    });
    send(room.host, { type: 'guest-joined', guestId: ws.guestId });
    console.log(`[${roomId}] Guest joined (${ws.guestId})`);
    return;
  }

  // ── WebRTC сигнализация (host ↔ guest) ──
  if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (ws.role === 'host') {
      const target = msg.guestId
        ? [...room.guests].find(g => g.guestId === msg.guestId)
        : null;
      const targets = target ? [target] : [...room.guests];
      targets.forEach(g => send(g, { ...msg, from: 'host' }));
    } else if (ws.role === 'guest') {
      send(room.host, { ...msg, guestId: ws.guestId, from: 'guest' });
    }
    return;
  }

  // ── УПРАВЛЕНИЕ: гость → расширение ──
  // Гость отправляет события мыши/клавиатуры
  if (['mousemove','mousedown','mouseup','click','dblclick',
       'contextmenu','wheel','keydown','keyup'].includes(msg.type)) {
    const room = rooms.get(ws.roomId);
    if (!room || ws.role !== 'guest') return;

    if (room.extension && room.extension.readyState === 1) {
      // Пересылаем в расширение
      send(room.extension, msg);
    }
    return;
  }

  // ── PONG от расширения ──
  if (msg.type === 'pong') return;
}

// ══════════════════════════════════════════════
// ОБРАБОТКА ОТКЛЮЧЕНИЯ
// ══════════════════════════════════════════════
function handleClose(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  if (ws.role === 'host') {
    room.guests.forEach(g => send(g, { type: 'host-disconnected' }));
    if (room.extension) send(room.extension, { type: 'host-disconnected' });
    rooms.delete(roomId);
    console.log(`[${roomId}] Host disconnected — room destroyed`);

  } else if (ws.role === 'extension') {
    room.extension = null;
    if (room.host) send(room.host, { type: 'extension-disconnected' });
    room.guests.forEach(g => send(g, { type: 'extension-disconnected' }));
    console.log(`[${roomId}] Extension disconnected`);
    cleanupRoom(roomId);

  } else if (ws.role === 'guest') {
    room.guests.delete(ws);
    if (room.host) send(room.host, { type: 'guest-left', guestId: ws.guestId });
    console.log(`[${roomId}] Guest left (${ws.guestId})`);
    cleanupRoom(roomId);
  }
}

// ── Ping расширений каждые 30с ──
setInterval(() => {
  rooms.forEach((room) => {
    if (room.extension && room.extension.readyState === 1) {
      send(room.extension, { type: 'ping' });
    }
  });
}, 30000);

// ── Status API ──
app.get('/api/status', (req, res) => {
  const data = {};
  rooms.forEach((room, id) => {
    data[id] = {
      host: room.host ? 'connected' : 'offline',
      extension: room.extension ? 'connected' : 'offline',
      guests: room.guests.size,
    };
  });
  res.json({ rooms: data, total: rooms.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ ScreenShare relay on :${PORT}\n`);
});
