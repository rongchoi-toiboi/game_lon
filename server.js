const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname)));

let waitingPlayer = null;
let rooms = {};
// Bảng xếp hạng Elo lưu trữ theo tên người chơi (mặc định 1200 Elo)
let leaderboard = {};

function calculateElo(ratingA, ratingB, actualScoreA, K = 32) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K * (actualScoreA - expectedA));
}

io.on('connection', (socket) => {
  // Gửi Bảng xếp hạng ngay khi có kết nối
  socket.emit('leaderboard_data', getSortedLeaderboard());

  socket.on('find_match', (data) => {
    const pName = (data && data.name) ? data.name.trim() : 'Player';
    socket.playerName = pName;
    if (!leaderboard[pName]) leaderboard[pName] = 1200; // Khởi tạo 1200 điểm nếu mới

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const roomId = 'room_' + waitingPlayer.id + '_' + socket.id;
      const p1 = waitingPlayer;
      const p2 = socket;

      waitingPlayer = null;

      p1.join(roomId);
      p2.join(roomId);

      rooms[p1.id] = { roomId, opponent: p2, role: 0 };
      rooms[p2.id] = { roomId, opponent: p1, role: 1 };

      p1.emit('match_found', { role: 0, roomId, opponentName: p2.playerName, opponentElo: leaderboard[p2.playerName] });
      p2.emit('match_found', { role: 1, roomId, opponentName: p1.playerName, opponentElo: leaderboard[p1.playerName] });
    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_match');
    }
  });

  socket.on('game_action', (data) => {
    const rInfo = rooms[socket.id];
    if (rInfo) {
      socket.to(rInfo.roomId).emit('game_action', data);
    }
  });

  // Xử lý cập nhật Elo khi trận đấu kết thúc
  socket.on('game_over', (data) => {
    const rInfo = rooms[socket.id];
    if (rInfo && rInfo.opponent) {
      const p1Name = socket.playerName;
      const p2Name = rInfo.opponent.playerName;

      if (p1Name && p2Name) {
        const elo1 = leaderboard[p1Name] || 1200;
        const elo2 = leaderboard[p2Name] || 1200;

        // winnerRole === socket's role ? 1 : 0
        const score1 = data.winnerRole === rInfo.role ? 1 : 0;
        const score2 = 1 - score1;

        const newElo1 = calculateElo(elo1, elo2, score1);
        const newElo2 = calculateElo(elo2, elo1, score2);

        leaderboard[p1Name] = newElo1;
        leaderboard[p2Name] = newElo2;

        io.emit('leaderboard_data', getSortedLeaderboard());
      }
    }
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    const rInfo = rooms[socket.id];
    if (rInfo) {
      socket.to(rInfo.roomId).emit('opponent_left');
      delete rooms[socket.id];
    }
  });
});

function getSortedLeaderboard() {
  return Object.keys(leaderboard)
    .map(name => ({ name, elo: leaderboard[name] }))
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 10); // Top 10
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
