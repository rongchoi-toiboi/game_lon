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

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Người dùng bấm nút Tìm trận tự động
  socket.on('find_match', () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      // Đã có 1 người đang chờ -> Ghép 2 người vào 1 phòng
      const roomId = 'room_' + waitingPlayer.id + '_' + socket.id;
      const p1 = waitingPlayer;
      const p2 = socket;

      waitingPlayer = null;

      p1.join(roomId);
      p2.join(roomId);

      rooms[p1.id] = roomId;
      rooms[p2.id] = roomId;

      // Báo cho 2 máy biết đã tìm thấy đối thủ
      p1.emit('match_found', { role: 0, roomId }); // Player 1 (Red)
      p2.emit('match_found', { role: 1, roomId }); // Player 2 (Blue)
    } else {
      // Chưa có ai -> Đưa người này vào danh sách chờ
      waitingPlayer = socket;
      socket.emit('waiting_for_match');
    }
  });

  // Truyền trạng thái bàn cờ giữa 2 máy
  socket.on('game_action', (data) => {
    const roomId = rooms[socket.id];
    if (roomId) {
      socket.to(roomId).emit('game_action', data);
    }
  });

  // Xử lý khi ngắt kết nối
  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    const roomId = rooms[socket.id];
    if (roomId) {
      socket.to(roomId).emit('opponent_left');
      delete rooms[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
