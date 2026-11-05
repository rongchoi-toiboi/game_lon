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
// Cấu trúc users: { socketId: { name, elo } }
let users = {};

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Đăng ký tên và khởi tạo Elo
  socket.on('set_name', (data) => {
    const name = data && data.name ? String(data.name).trim().slice(0, 16) : 'Player';
    if (!users[socket.id]) {
      users[socket.id] = { name, elo: 1000 };
    } else {
      users[socket.id].name = name;
    }
    io.emit('leaderboard_update', getLeaderboard());
  });

  // Xử lý Tìm trận
  socket.on('find_match', (data) => {
    const playerName = data && data.name ? String(data.name).trim().slice(0, 16) : 'Player';
    if (!users[socket.id]) {
      users[socket.id] = { name: playerName, elo: 1000 };
    } else {
      users[socket.id].name = playerName;
    }

    // Nếu người chơi bấm lại khi đang chờ thì không xử lý trùng
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

      p1.emit('match_found', { role: 0, roomId, opponent: users[p2.id].name, opponentElo: users[p2.id].elo });
      p2.emit('match_found', { role: 1, roomId, opponent: users[p1.id].name, opponentElo: users[p1.id].elo });
    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_match');
    }
  });

  // Hủy tìm trận
  socket.on('cancel_match', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
  });

  // Truyền nước đi
  socket.on('game_action', (data) => {
    const room = rooms[socket.id];
    if (room) {
      socket.to(room.id).emit('game_action', data);
    }
  });

  // Tính toán Elo khi ván đấu kết thúc
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

  // Xử lý ngắt kết nối
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
