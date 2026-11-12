const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: '*' }));
app.get('/', (req, res) => res.send('Floor Is Lava server is awake 🔥'));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const rooms = {};
const COLORS = ['#ff4d6d', '#3fa7ff', '#ffd23f', '#5cff7a'];
const WIN_SCORE = 3;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

function newCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]; } while (rooms[c]);
  return c;
}
function lobbyInfo(r) {
  io.to(r.code).emit('lobby', {
    code: r.code, host: r.host, phase: r.phase,
    players: Object.values(r.players).map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }))
  });
}
function startRound(r) {
  r.round++;
  r.phase = 'play';
  const ids = Object.keys(r.players);
  r.startCount = ids.length;
  const spawns = {};
  ids.forEach((id, i) => {
    const p = r.players[id];
    p.alive = true;
    const a = (i / ids.length) * Math.PI * 2 + 0.5;
    spawns[id] = [Math.cos(a) * 2.2, Math.sin(a) * 2.2];
  });
  r.roundStart = Date.now() + 3500;
  io.to(r.code).emit('begin', { serverNow: Date.now(), roundStart: r.roundStart, round: r.round, spawns, scores: scoreMap(r) });
}
function scoreMap(r) {
  const o = {};
  for (const id in r.players) o[id] = r.players[id].score;
  return o;
}
function checkEnd(r) {
  if (r.phase !== 'play' || r.startCount < 2) return;
  const alive = Object.values(r.players).filter((p) => p.alive);
  if (alive.length > 1) return;
  const winner = alive[0] || null;
  if (winner) winner.score++;
  const matchOver = !!winner && winner.score >= WIN_SCORE;
  r.phase = matchOver ? 'over' : 'between';
  io.to(r.code).emit('roundEnd', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    scores: scoreMap(r), matchOver,
    standings: Object.values(r.players).map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score })).sort((a, b) => b.score - a.score)
  });
  lobbyInfo(r);
  if (!matchOver) {
    r.timer = setTimeout(() => { if (rooms[r.code] && r.phase === 'between') startRound(r); }, 4500);
  }
}
function leave(socket) {
  const code = socket.data.room;
  const r = rooms[code];
  if (!r) return;
  delete r.players[socket.id];
  socket.leave(code);
  socket.data.room = null;
  const ids = Object.keys(r.players);
  if (!ids.length) { clearTimeout(r.timer); delete rooms[code]; return; }
  if (r.host === socket.id) r.host = ids[0];
  if (r.phase !== 'lobby' && ids.length < 2) {
    clearTimeout(r.timer);
    r.phase = 'lobby';
    for (const id in r.players) r.players[id].score = 0;
    io.to(code).emit('toLobby', 'Everyone else fled the living room. Back to the lobby!');
  } else if (r.phase === 'play') checkEnd(r);
  lobbyInfo(r);
}

io.on('connection', (socket) => {
  const enter = (r, name) => {
    const used = Object.values(r.players).map((p) => p.color);
    const color = COLORS.find((c) => !used.includes(c)) || COLORS[0];
    r.players[socket.id] = { id: socket.id, name: String(name || 'Bean').slice(0, 12), color, score: 0, alive: false, x: 0, y: 0, z: 0, ry: 0, tilt: 0 };
    socket.join(r.code);
    socket.data.room = r.code;
    lobbyInfo(r);
  };
  socket.on('create', ({ name }) => {
    leave(socket);
    const code = newCode();
    rooms[code] = { code, host: socket.id, phase: 'lobby', players: {}, round: 0, startCount: 0, timer: null, roundStart: 0 };
    enter(rooms[code], name);
  });
  socket.on('join', ({ code, name }) => {
    const r = rooms[String(code || '').toUpperCase().trim()];
    if (!r) return socket.emit('err', 'Room not found. Check the code!');
    if (r.phase !== 'lobby') return socket.emit('err', 'That game already started.');
    if (Object.keys(r.players).length >= 4) return socket.emit('err', 'Room is full (4 max).');
    leave(socket);
    enter(r, name);
  });
  socket.on('start', () => {
    const r = rooms[socket.data.room];
    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;
    if (Object.keys(r.players).length < 2) return socket.emit('err', 'Need at least 2 players.');
    for (const id in r.players) r.players[id].score = 0;
    startRound(r);
  });
  socket.on('again', () => {
    const r = rooms[socket.data.room];
    if (!r || r.phase !== 'over') return;
    for (const id in r.players) r.players[id].score = 0;
    startRound(r);
  });
  socket.on('state', (s) => {
    const r = rooms[socket.data.room];
    const p = r && r.players[socket.id];
    if (!p || !s) return;
    p.x = num(s.x); p.y = num(s.y); p.z = num(s.z); p.ry = num(s.ry); p.tilt = num(s.tilt);
  });
  socket.on('shove', (d) => {
    const r = rooms[socket.data.room];
    if (!r || r.phase !== 'play' || !d) return;
    socket.to(r.code).emit('shoveFx', socket.id);
    (Array.isArray(d.targets) ? d.targets : []).slice(0, 3).forEach((t) => {
      if (r.players[t] && r.players[t].alive) io.to(t).emit('hit', { from: socket.id, dx: num(d.dx), dz: num(d.dz) });
    });
  });
  socket.on('died', (d) => {
    const r = rooms[socket.data.room];
    const p = r && r.players[socket.id];
    if (!r || !p || !p.alive || r.phase !== 'play') return;
    p.alive = false;
    const killer = d && d.by && r.players[d.by] ? r.players[d.by] : null;
    const v = p.name;
    let msg;
    if (killer && killer.id !== p.id) {
      const k = killer.name;
      const t = [`${v} was shoved into the spicy soup by ${k}`, `${k} gave ${v} a free lava bath`, `${v} got yeeted into the hot tub by ${k}`, `${k} sent ${v} to the shadow realm (it's lava)`];
      msg = t[Math.floor(Math.random() * t.length)];
    } else {
      const t = [`${v} tried to walk on lava. Bold.`, `${v} auditioned as a marshmallow`, `${v} missed the couch. Tragic.`, `${v} forgot how jumping works`];
      msg = t[Math.floor(Math.random() * t.length)];
    }
    io.to(r.code).emit('kill', { victim: p.id, msg });
    checkEnd(r);
  });
  socket.on('disconnect', () => leave(socket));
});

setInterval(() => {
  for (const code in rooms) {
    const r = rooms[code];
    if (r.phase !== 'play') continue;
    io.to(code).emit('st', Object.values(r.players).map((p) => [p.id, p.x, p.y, p.z, p.ry, p.tilt, p.alive ? 1 : 0]));
  }
}, 66);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Floor Is Lava server listening on ' + PORT));
