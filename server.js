const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Phục vụ các file tĩnh trong cùng thư mục
app.use(express.static(__dirname));

let waitingPlayer = null; // Lưu người chơi đang chờ tìm trận

io.on('connection', (socket) => {
    console.log('Có người chơi kết nối:', socket.id);

    // Khi người chơi bấm tìm trận ngẫu nhiên
    socket.on('find_match', () => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
            
            socket.join(roomId);
            waitingPlayer.join(roomId);

            // Báo cho cả 2 máy tìm thấy đối thủ
            io.to(roomId).emit('match_found', { roomId, p1: waitingPlayer.id, p2: socket.id });

            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
            socket.emit('waiting', { message: 'Đang tìm kiếm đối thủ ngẫu nhiên...' });
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
        console.log('Người chơi ngắt kết nối:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server đang chạy tại cổng ${PORT}`);
});