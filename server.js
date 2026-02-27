const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/room/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId }) => {
    socket.join(roomId);

    // 新規参加者へ既存メンバー一覧
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const others = clients.filter((id) => id !== socket.id);
    socket.emit("room-users", { users: others });

    // 既存メンバーへ入室通知
    socket.to(roomId).emit("user-joined", { userId: socket.id });

    // WebRTCシグナリング（offer/answer/ice）
    socket.on("signal", ({ to, data }) => {
      io.to(to).emit("signal", { from: socket.id, data });
    });

    // チャット
    socket.on("chat-message", ({ text }) => {
      const t = String(text ?? "").slice(0, 500);
      if (!t.trim()) return;
      io.to(roomId).emit("chat-message", { from: socket.id, text: t, ts: Date.now() });
    });

    socket.on("disconnect", () => {
      socket.to(roomId).emit("user-left", { userId: socket.id });
    });
  });
});

// ★公開用：PORT環境変数に対応（重要）
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log("listening on", PORT));