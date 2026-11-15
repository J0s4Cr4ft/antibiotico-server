// Servidor de Antibiótico 3D
// - Sirve el juego (antibiotico.html)
// - Grupos de hasta 4 con PIN, nombres y dificultad
// - Amigos (presencia en línea e invitaciones), chat global y de grupo
// - Ranking de puntuaciones (se guarda en scores.json si el disco lo permite)
// El navegador del admin ejecuta la partida; el servidor solo reparte mensajes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX = 4;
const SC_FILE = path.join(__dirname, 'scores.json');
let scores = [];
try { scores = JSON.parse(fs.readFileSync(SC_FILE, 'utf8')); } catch { /* aún no hay datos */ }
const saveScores = () => fs.writeFile(SC_FILE, JSON.stringify(scores), () => {});
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const cleanName = (s, fb) =>
  String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || fb;

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url === '/health') { res.writeHead(200, CORS); return res.end('ok'); }
  if (url === '/scores' && req.method === 'GET') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(scores.slice(0, 20)));
  }
  if (url === '/score' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const o = JSON.parse(body);
        const s = Math.floor(Number(o.s)), w = Math.floor(Number(o.w)), d = Math.floor(Number(o.d));
        if (!(s > 0 && s <= 5e6 && w >= 1 && w <= 10 && d >= 0 && d <= 3)) throw new Error('bad');
        scores.push({ n: cleanName(o.n, 'Jugador'), s, w, d, m: o.m === 'coop' ? 'coop' : 'solo', t: Date.now() });
        scores.sort((a, b) => b.s - a.s);
        scores = scores.slice(0, 100);
        saveScores();
        res.writeHead(200, CORS); res.end('ok');
      } catch { res.writeHead(400, CORS); res.end('bad'); }
    });
    return;
  }
  fs.readFile(path.join(__dirname, 'antibiotico.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Falta antibiotico.html junto a server.js'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = {};
const byCode = {};
const hist = [];
let nextId = 1;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const clampDf = (v) => (v == null ? 1 : Math.min(3, Math.max(0, v | 0)));

function sendLobby(room) {
  const ps = room.members.map((m) => m.id);
  const ns = room.members.map((m) => m.name);
  room.members.forEach((m) =>
    send(m.ws, { t: 'lobby', pin: room.pin, host: room.members[0].id, you: m.id, ps, ns, df: room.df }));
}

function leaveRoom(me) {
  const room = me.room;
  if (!room) return;
  me.room = null;
  if (room.members[0] === me) {
    room.members.forEach((x) => { if (x !== me) { send(x.ws, { t: 'closed' }); x.room = null; } });
    delete rooms[room.pin];
  } else {
    room.members = room.members.filter((x) => x !== me);
    if (room.started) send(room.members[0].ws, { t: 'left', id: me.id });
    else sendLobby(room);
  }
}

wss.on('connection', (ws) => {
  const me = { id: nextId++, ws, room: null, name: 'Jugador', code: '', lc: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const room = me.room;

    if (m.t === 'hi') {
      if (/^[A-Z2-9]{6}$/.test(String(m.code))) { me.code = m.code; byCode[me.code] = me; }
      me.name = cleanName(m.name, 'Jugador');
      if (!me.greeted) { me.greeted = true; send(ws, { t: 'hist', a: hist }); }
    } else if (m.t === 'create' && !room) {
      let pin = /^\d{4}$/.test(String(m.pin || '')) ? String(m.pin) : '';
      if (pin && rooms[pin]) return send(ws, { t: 'err', m: 'Ese PIN ya está en uso.' });
      if (!pin) do { pin = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms[pin]);
      me.name = cleanName(m.name, 'Jugador 1');
      me.room = rooms[pin] = { pin, members: [me], started: false, df: clampDf(m.df) };
      sendLobby(me.room);
    } else if (m.t === 'join' && !room) {
      const r = rooms[String(m.pin || '').trim()];
      if (!r) return send(ws, { t: 'err', m: 'PIN incorrecto.' });
      if (r.started) return send(ws, { t: 'err', m: 'Esa partida ya empezó.' });
      if (r.members.length >= MAX) return send(ws, { t: 'err', m: 'El grupo está lleno (máx. 4).' });
      me.name = cleanName(m.name, 'Jugador ' + (r.members.length + 1));
      r.members.push(me);
      me.room = r;
      sendLobby(r);
    } else if (room && m.t === 'cfg' && room.members[0] === me && !room.started) {
      room.df = clampDf(m.df);
      sendLobby(room);
    } else if (room && m.t === 'start' && room.members[0] === me && !room.started) {
      room.started = true;
      const ps = room.members.map((x) => x.id);
      const ns = room.members.map((x) => x.name);
      room.members.forEach((x) => send(x.ws, { t: 'start', ps, ns, df: room.df }));
    } else if (m.t === 'leave') {
      leaveRoom(me);
    } else if (room && room.started && m.t === 'h') {
      send(room.members[0].ws, { t: 'm', from: me.id, d: m.d }); // jugador -> admin
    } else if (room && room.started && m.t === 'a' && room.members[0] === me) {
      room.members.forEach((x) => { if (x !== me) send(x.ws, { t: 'm', from: me.id, d: m.d }); }); // admin -> resto
    } else if (m.t === 'chat') {
      const x = String(m.x || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
      const now = Date.now();
      if (!x || now - me.lc < 600) return;
      me.lc = now;
      const o = { t: 'chat', s: m.s === 'r' ? 'r' : 'g', n: me.name, x };
      if (o.s === 'r') {
        if (room) room.members.forEach((y) => send(y.ws, o));
      } else {
        hist.push([o.n, x]);
        if (hist.length > 30) hist.shift();
        wss.clients.forEach((c) => send(c, o));
      }
    } else if (m.t === 'pres' && Array.isArray(m.codes)) {
      const on = {};
      m.codes.slice(0, 50).forEach((c) => {
        const o = byCode[c];
        if (o) on[c] = { n: o.name, st: o.room ? (o.room.started ? 'game' : 'lobby') : 'menu' };
      });
      send(ws, { t: 'pres', on });
    } else if (m.t === 'freq' && me.code) {
      const to = byCode[String(m.to)];
      if (!to || to === me) return send(ws, { t: 'ferr', m: 'Ese jugador no está en línea ahora mismo.' });
      send(to.ws, { t: 'freq', from: me.code, name: me.name });
    } else if (m.t === 'facc' && me.code) {
      const to = byCode[String(m.to)];
      if (to) send(to.ws, { t: 'facc', from: me.code, name: me.name });
    } else if (m.t === 'inv' && room && !room.started) {
      const to = byCode[String(m.to)];
      if (to && !to.room && room.pin === String(m.pin)) send(to.ws, { t: 'inv', from: me.name, pin: room.pin });
    }
  });

  ws.on('close', () => {
    leaveRoom(me);
    if (me.code && byCode[me.code] === me) delete byCode[me.code];
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
