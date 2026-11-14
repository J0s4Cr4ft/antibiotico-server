// Servidor de Antibiótico 3D: sirve el juego y gestiona grupos (máx. 4) con PIN y nombres.
// El navegador del admin ejecuta la partida; este servidor solo reparte mensajes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX = 4;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  fs.readFile(path.join(__dirname, 'antibiotico.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Falta antibiotico.html junto a server.js'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = {};
let nextId = 1;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const cleanName = (s, n) =>
  String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Jugador ' + n;

function sendLobby(room) {
  const ps = room.members.map((m) => m.id);
  const ns = room.members.map((m) => m.name);
  room.members.forEach((m) =>
    send(m.ws, { t: 'lobby', pin: room.pin, host: room.members[0].id, you: m.id, ps, ns }));
}

wss.on('connection', (ws) => {
  const me = { id: nextId++, ws, room: null, name: '' };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const room = me.room;

    if (m.t === 'create' && !room) {
      let pin = /^\d{4}$/.test(String(m.pin || '')) ? String(m.pin) : '';
      if (pin && rooms[pin]) return send(ws, { t: 'err', m: 'Ese PIN ya está en uso.' });
      if (!pin) do { pin = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms[pin]);
      me.name = cleanName(m.name, 1);
      me.room = rooms[pin] = { pin, members: [me], started: false };
      sendLobby(me.room);
    } else if (m.t === 'join' && !room) {
      const r = rooms[String(m.pin || '').trim()];
      if (!r) return send(ws, { t: 'err', m: 'PIN incorrecto.' });
      if (r.started) return send(ws, { t: 'err', m: 'Esa partida ya empezó.' });
      if (r.members.length >= MAX) return send(ws, { t: 'err', m: 'El grupo está lleno (máx. 4).' });
      me.name = cleanName(m.name, r.members.length + 1);
      r.members.push(me);
      me.room = r;
      sendLobby(r);
    } else if (room && m.t === 'start' && room.members[0] === me && !room.started) {
      room.started = true;
      const ps = room.members.map((x) => x.id);
      const ns = room.members.map((x) => x.name);
      room.members.forEach((x) => send(x.ws, { t: 'start', ps, ns }));
    } else if (room && room.started && m.t === 'h') {
      send(room.members[0].ws, { t: 'm', from: me.id, d: m.d }); // jugador -> admin
    } else if (room && room.started && m.t === 'a' && room.members[0] === me) {
      room.members.forEach((x) => { if (x !== me) send(x.ws, { t: 'm', from: me.id, d: m.d }); }); // admin -> todos
    }
  });

  ws.on('close', () => {
    const room = me.room;
    if (!room) return;
    if (room.members[0] === me) {
      room.members.forEach((x) => { if (x !== me) { send(x.ws, { t: 'closed' }); x.room = null; } });
      delete rooms[room.pin];
    } else {
      room.members = room.members.filter((x) => x !== me);
      if (room.started) send(room.members[0].ws, { t: 'left', id: me.id });
      else sendLobby(room);
    }
  });
});

// Mantiene viva la conexión (Railway y otros proxies cierran las conexiones inactivas)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log('Servidor listo en el puerto ' + PORT));
