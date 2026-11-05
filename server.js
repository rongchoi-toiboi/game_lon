const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname)));

let waitingPlayer = null;
let rooms = {};
let users = {}; // { socketId: { name, elo } }

// Hàm sinh tọa độ các chấm ngẫu nhiên chuẩn từ Server
function generateSpots(n = 3) {
  const spots = [];
  const W = 900, H = 600;
  for (let t = 0; spots.length < n && t < 2000; t++) {
    const p = { x: (Math.random() - .5) * (W - 140), y: (Math.random() - .5) * (H - 140), d: 0 };
    if (spots.every(s => Math.hypot(s.x - p.x, s.y - p.y) > 100)) spots.push(p);
  }
  return spots;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('set_name', (data) => {
    const name = data && data.name ? String(data.name).trim().slice(0, 16) : 'Player';
    if (!users[socket.id]) {
      users[socket.id] = { name, elo: 1000 };
    } else {
      users[socket.id].name = name;
    }
    io.emit('leaderboard_update', getLeaderboard());
  });

  socket.on('find_match', (data) => {
    const playerName = data && data.name ? String(data.name).trim().slice(0, 16) : 'Player';
    if (!users[socket.id]) {
      users[socket.id] = { name: playerName, elo: 1000 };
    } else {
      users[socket.id].name = playerName;
    }

    if (waitingPlayer && waitingPlayer.id === socket.id) return;

    if (waitingPlayer && waitingPlayer.connected) {
      const p1 = waitingPlayer;
      const p2 = socket;
      waitingPlayer = null;

      const roomId = 'room_' + p1.id + '_' + p2.id;
      p1.join(roomId);
      p2.join(roomId);

      rooms[p1.id] = { id: roomId, p1: p1.id, p2: p2.id };
      rooms[p2.id] = { id: roomId, p1: p1.id, p2: p2.id };

      // Tạo sẵn bàn cờ và lượt đi ngẫu nhiên ngay khi vừa ghép đôi thành công
      const initialSpots = generateSpots(3);
      const initialTurn = Math.random() < 0.5 ? 0 : 1;

      const matchData = {
        roomId,
        spots: initialSpots,
        lines: [],
        turn: initialTurn,
        p1Name: users[p1.id].name,
        p2Name: users[p2.id].name
      };

      // Gửi thẳng gói tin bắt đầu trận kèm bàn cờ về cho cả 2 máy
      p1.emit('match_start', { ...matchData, role: 0, opponent: users[p2.id].name });
      p2.emit('match_start', { ...matchData, role: 1, opponent: users[p1.id].name });
    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_match');
    }
  });

  socket.on('cancel_match', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
  });

  socket.on('game_action', (data) => {
    const room = rooms[socket.id];
    if (room) {
      socket.to(room.id).emit('game_action', data);
    }
  });

  socket.on('game_over', (data) => {
    const room = rooms[socket.id];
    if (room && data && data.winner !== undefined) {
      const winnerId = data.winner === 0 ? room.p1 : room.p2;
      const loserId = data.winner === 0 ? room.p2 : room.p1;

      if (users[winnerId] && users[loserId]) {
        users[winnerId].elo += 16;
        users[loserId].elo = Math.max(0, users[loserId].elo - 16);
        io.emit('leaderboard_update', getLeaderboard());
      }
    }
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    const room = rooms[socket.id];
    if (room) {
      socket.to(room.id).emit('opponent_left');
      delete rooms[room.p1];
      delete rooms[room.p2];
    }
    delete users[socket.id];
    io.emit('leaderboard_update', getLeaderboard());
  });
});

function getLeaderboard() {
  return Object.values(users)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 10);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
