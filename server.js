const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/:room", (req, res) => {
  const room = req.params.room;
  if (room === "favicon.ico" || room.startsWith("socket.io")) {
    return res.status(404).end();
  }
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

const rooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId, username) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || "Guest";

    if (!rooms[roomId]) {
      rooms[roomId] = { users: [], hostId: null };
    }
    rooms[roomId].users.push({ id: socket.id, name: socket.username });

    const isFirst = rooms[roomId].users.length === 1;
    const isHost = rooms[roomId].hostId === socket.id || isFirst;
    if (isFirst) {
      rooms[roomId].hostId = socket.id;
    }

    io.to(roomId).emit("user-list", rooms[roomId].users.map(u => u.name));
    socket.emit("host-status", isHost);

    socket.to(roomId).emit("chat-message", {
      user: "System",
      text: `${socket.username} joined the room`,
      system: true,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });

    const existingPeers = rooms[roomId].users.filter(u => u.id !== socket.id);
    if (existingPeers.length > 0) {
      socket.emit("existing-peers", existingPeers.map(u => u.id));
    }
  });

  socket.on("chat-message", (data) => {
    io.to(socket.roomId).emit("chat-message", {
      user: socket.username,
      text: data.text,
      system: false,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  });

  socket.on("typing", (isTyping) => {
    socket.to(socket.roomId).emit("typing", { user: socket.username, isTyping });
  });

  socket.on("send-voice", (data) => {
    io.to(socket.roomId).emit("receive-voice", {
      user: socket.username,
      audio: data.audio,
      duration: data.duration,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  });

  // WebRTC signaling
  socket.on("webrtc-offer", (data) => {
    socket.to(socket.roomId).emit("webrtc-offer", { sdp: data.sdp, from: socket.id });
  });

  socket.on("webrtc-answer", (data) => {
    socket.to(socket.roomId).emit("webrtc-answer", { sdp: data.sdp, from: socket.id });
  });

  socket.on("webrtc-ice", (data) => {
    socket.to(socket.roomId).emit("webrtc-ice", { candidate: data.candidate, from: socket.id });
  });

  socket.on("stop-screen-share", () => {
    socket.to(socket.roomId).emit("stop-screen-share");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (socket.roomId && rooms[socket.roomId]) {
      const room = rooms[socket.roomId];
      room.users = room.users.filter(u => u.id !== socket.id);

      if (room.hostId === socket.id) {
        room.hostId = room.users[0] ? room.users[0].id : null;
        if (room.hostId) {
          io.to(room.hostId).emit("host-status", true);
        }
      }

      io.to(socket.roomId).emit("user-list", room.users.map(u => u.name));
      socket.to(socket.roomId).emit("chat-message", {
        user: "System",
        text: `${socket.username} left the room`,
        system: true,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
      socket.to(socket.roomId).emit("stop-screen-share");

      if (room.users.length === 0) {
        delete rooms[socket.roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
