const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

// ---------------------------------------------------------------- config ---
const PORT = process.env.PORT || 3000;          // Render injects PORT
const START_ELO = 500;                          // điểm Elo khởi điểm
const K_FACTOR = 32;                            // hệ số K của công thức Elo
const MATCH_SPOTS = 3;                          // số chấm của ván "Tìm trận nhanh"
const MATCH_MINUTES = 5;                        // phút / người của ván "Tìm trận nhanh"
const LEADERBOARD_SIZE = 10;
const REPORT_GRACE_MS = 8000;                   // chờ báo cáo kết quả của bên còn lại
const PID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ------------------------------------------------------------------ http ---
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

// Chỉ phục vụ index.html (và thư mục public/ nếu có) để KHÔNG lộ server.js / package.json.
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------- socket.io ---
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],         // WebSocket trước, tự fallback sang long-polling
  pingInterval: 25000,                          // giữ kết nối sống qua proxy của Render
  pingTimeout: 30000,
  connectTimeout: 45000,
  maxHttpBufferSize: 5e6                        // gói 'state' chứa toàn bộ đường vẽ
});

// ------------------------------------------------------------------ state ---
const ratings = new Map();   // pid -> { pub, name, elo, games, wins }   (giữ trong RAM khi server còn chạy)
let waitingPlayer = null;    // socket đang chờ ghép trận
let rooms = {};              // socketId -> room (hai người cùng trỏ vào 1 object room)
let users = {};              // socketId -> { pid }

const cleanName = (x) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) || 'Player';

function identify(socket, data) {
  const d = data && typeof data === 'object' ? data : {};
  let u = users[socket.id];
  if (!u) {
    const pid = typeof d.pid === 'string' && PID_RE.test(d.pid) ? d.pid : 'anon_' + socket.id;
    u = users[socket.id] = { pid };
  }
  let rec = ratings.get(u.pid);
  if (!rec) {
    rec = { pub: crypto.randomBytes(4).toString('hex'), name: 'Player', elo: START_ELO, games: 0, wins: 0 };
    ratings.set(u.pid, rec);
  }
  if (d.name !== undefined) rec.name = cleanName(d.name);
  return rec;
}

const recOf = (socketId) => (users[socketId] ? ratings.get(users[socketId].pid) : null);
const profileOf = (rec) => ({ pub: rec.pub, name: rec.name, elo: rec.elo, games: rec.games });

function getLeaderboard() {
  const online = new Set(Object.values(users).map((u) => u.pid));
  return [...ratings.entries()]
    .filter(([pid, r]) => r.games > 0 || online.has(pid))
    .map(([pid, r]) => ({ pub: r.pub, name: r.name, elo: r.elo, games: r.games, online: online.has(pid) }))
    .sort((a, b) => b.elo - a.elo || b.games - a.games)
    .slice(0, LEADERBOARD_SIZE);
}
const broadcastLeaderboard = () => io.emit('leaderboard_update', getLeaderboard());

// Sinh tọa độ các chấm ngẫu nhiên (cùng thuật toán với client)
function generateSpots(n = MATCH_SPOTS) {
  const spots = [];
  const W = 900, H = 600;
  for (let t = 0; spots.length < n && t < 2000; t++) {
    const p = { x: (Math.random() - 0.5) * (W - 140), y: (Math.random() - 0.5) * (H - 140), d: 0 };
    if (spots.every((s) => Math.hypot(s.x - p.x, s.y - p.y) > (t > 1000 ? 70 : 130))) spots.push(p);
  }
  return spots;
}

// ------------------------------------------------------------ Elo & rooms ---
// Chấm kết quả: người thắng được cộng, người thua bị trừ theo công thức Elo chuẩn (K = 32).
// Hai người cùng 500 điểm => +16 / -16. Điểm không xuống dưới 0.
function finishRoom(room, winnerRole, reason) {
  if (room.finished) return;
  room.finished = true;
  clearTimeout(room.timer);

  const W = recOf(winnerRole === 0 ? room.p1 : room.p2);
  const L = recOf(winnerRole === 0 ? room.p2 : room.p1);
  if (!W || !L) return;

  const expected = 1 / (1 + Math.pow(10, (L.elo - W.elo) / 400));
  const gain = Math.max(1, Math.round(K_FACTOR * (1 - expected)));
  const newL = Math.max(0, L.elo - gain);
  const loss = L.elo - newL;
  W.elo += gain; W.games++; W.wins++;
  L.elo = newL; L.games++;

  const elo = [0, 0], delta = [0, 0];
  elo[winnerRole] = W.elo;      delta[winnerRole] = gain;
  elo[winnerRole ^ 1] = L.elo;  delta[winnerRole ^ 1] = -loss;

  io.to(room.id).emit('elo_result', { winner: winnerRole, reason, elo, delta });
  [room.p1, room.p2].forEach((id) => {
    const s = io.sockets.sockets.get(id), r = recOf(id);
    if (s && r) s.emit('profile', profileOf(r));
  });
  broadcastLeaderboard();
}

function voidRoom(room) {
  if (room.finished) return;
  room.finished = true;
  clearTimeout(room.timer);
  io.to(room.id).emit('elo_result', { void: true });
}

function leaveRoom(socket) {
  const room = rooms[socket.id];
  if (!room) return;
  const role = room.p1 === socket.id ? 0 : 1;
  const otherId = role === 0 ? room.p2 : room.p1;

  if (!room.finished) {
    // Rời giữa ván = xử thua, trừ khi một bên đã báo kết quả ván trước khi thoát.
    const rep = room.reports[role] !== null ? room.reports[role] : room.reports[role ^ 1];
    if (rep !== null) finishRoom(room, rep, 'normal');
    else finishRoom(room, role ^ 1, 'forfeit');
    room.finished = true;
  }
  delete rooms[room.p1];
  delete rooms[room.p2];
  socket.leave(room.id);
  const other = io.sockets.sockets.get(otherId);
  if (other) { other.leave(room.id); other.emit('opponent_left'); }
}

// ------------------------------------------------------------ connections ---
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  socket.emit('leaderboard_update', getLeaderboard());

  socket.on('set_name', (data) => {
    const rec = identify(socket, data);
    socket.emit('profile', profileOf(rec));
    broadcastLeaderboard();
  });

  socket.on('find_match', (data) => {
    const rec = identify(socket, data);
    socket.emit('profile', profileOf(rec));

    if (rooms[socket.id]) {
      if (rooms[socket.id].finished) leaveRoom(socket);
      else return socket.emit('match_error', { msg: 'Bạn đang trong một ván đấu.' });
    }
    if (waitingPlayer && waitingPlayer.id === socket.id) return;
    if (waitingPlayer && !waitingPlayer.connected) waitingPlayer = null;

    if (waitingPlayer) {
      const p1 = waitingPlayer;
      const p2 = socket;
      if (users[p1.id] && users[p1.id].pid === users[p2.id].pid) {
        return socket.emit('match_error', { msg: 'Tài khoản này đang tìm trận ở một tab khác.' });
      }
      waitingPlayer = null;

      const roomId = 'room_' + p1.id + '_' + p2.id;
      p1.join(roomId);
      p2.join(roomId);
      const room = { id: roomId, p1: p1.id, p2: p2.id, finished: false, reports: [null, null], timer: null, reason: 'normal' };
      rooms[p1.id] = room;
      rooms[p2.id] = room;

      const r1 = recOf(p1.id), r2 = recOf(p2.id);
      const matchData = {
        roomId,
        spots: generateSpots(MATCH_SPOTS),
        lines: [],
        turn: Math.random() < 0.5 ? 0 : 1,
        tm: MATCH_MINUTES,
        p1Name: r1.name,
        p2Name: r2.name,
        elo: [r1.elo, r2.elo]
      };
      p1.emit('match_start', { ...matchData, role: 0, opponent: r2.name });
      p2.emit('match_start', { ...matchData, role: 1, opponent: r1.name });
    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_match');
    }
  });

  socket.on('cancel_match', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
  });

  // Relay các thao tác ván đấu (state / resign / ...) tới đối thủ trong phòng
  socket.on('game_action', (data) => {
    const room = rooms[socket.id];
    if (room && data && typeof data === 'object') socket.to(room.id).emit('game_action', data);
  });

  // Mỗi client báo kết quả; server chỉ tính Elo khi hai bên khớp nhau
  // (hoặc chỉ một bên báo và bên kia im lặng quá REPORT_GRACE_MS).
  socket.on('game_over', (data) => {
    const room = rooms[socket.id];
    if (!room || room.finished || !data) return;
    const w = data.winner;
    if (w !== 0 && w !== 1) return;
    const role = room.p1 === socket.id ? 0 : 1;
    room.reports[role] = w;
    if (['resign', 'timeout', 'nomoves'].includes(data.reason)) room.reason = data.reason;

    const [a, b] = room.reports;
    if (a !== null && b !== null) {
      if (a === b) finishRoom(room, a, room.reason);
      else voidRoom(room);
    } else if (!room.timer) {
      room.timer = setTimeout(() => {
        const only = room.reports[0] !== null ? room.reports[0] : room.reports[1];
        if (only !== null) finishRoom(room, only, room.reason);
      }, REPORT_GRACE_MS);
    }
  });

  // Bấm "Back to lobby" sau ván: rời phòng để có thể tìm trận mới
  socket.on('leave_match', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    leaveRoom(socket);

    const u = users[socket.id];
    delete users[socket.id];
    if (u) {
      const stillOnline = Object.values(users).some((x) => x.pid === u.pid);
      const r = ratings.get(u.pid);
      // Người chưa đánh ván nào (hoặc không có định danh) không cần giữ lại
      if (r && !stillOnline && (r.games === 0 || u.pid.startsWith('anon_'))) ratings.delete(u.pid);
    }
    broadcastLeaderboard();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

process.on('SIGTERM', () => {
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
