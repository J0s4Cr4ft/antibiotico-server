const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/antibiotico.html') {
    const filePath = path.join(__dirname, 'antibiotico.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error al cargar antibiotico.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('No encontrado');
  }
});

const wss = new WebSocket.Server({ server });
const players = {};
let nextId = 1;

wss.on('connection', (ws) => {
  const id = String(nextId++);
  players[id] = { id, x: 0, y: 0, angle: 0 };

  ws.send(JSON.stringify({ type: 'init', id }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (players[id]) {
        if (typeof data.x === 'number') players[id].x = data.x;
        if (typeof data.y === 'number') players[id].y = data.y;
        if (typeof data.angle === 'number') players[id].angle = data.angle;
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    delete players[id];
  });
});

setInterval(() => {
  const state = JSON.stringify({ type: 'state', players });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}, 50);

server.listen(PORT, () => {
  console.log(`Servidor listo en el puerto ${PORT}`);
});
