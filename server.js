const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

// In-memory state (single shared session)
let hostId = null; // socket id of host
const players = new Map(); // socketId -> { name, index: 1..4 }
const answers = new Map(); // playerSocketId -> { text, revealed }

function broadcastRoster() {
  io.emit('roster', {
    hostPresent: !!hostId,
    players: Array.from(players.entries()).map(([id, p]) => ({ id, name: p.name, index: p.index }))
  });
}

io.on('connection', (socket) => {
  socket.data.role = 'guest';

  socket.on('join', ({ role, name }) => {
    socket.data.name = name || 'Anon';
    if (role === 'host') {
      hostId = socket.id;
      socket.data.role = 'host';
    } else {
      // assign the lowest free index from 1..4
      const used = new Set([...players.values()].map(p => p.index));
      let idx = 1;
      while (used.has(idx) && idx <= 4) idx++;
      if (idx > 4) {
        socket.emit('error-msg', 'Player limit reached (4).');
        return;
      }
      players.set(socket.id, { name: socket.data.name, index: idx });
      socket.data.role = 'player';
      socket.data.playerIndex = idx;

      // Clear any old answer for this slot
      answers.delete(socket.id);
    }

    socket.emit('you', { id: socket.id, role: socket.data.role, name: socket.data.name, index: socket.data.playerIndex });
    broadcastRoster();

    // Let others know to start WebRTC connection with this peer
    socket.broadcast.emit('peer:join', { id: socket.id, role: socket.data.role, index: socket.data.playerIndex, name: socket.data.name });
  });

  // Simple WebRTC signaling passthrough
  socket.on('signal', ({ targetId, data }) => {
    io.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  // Player submits answer (private). Only host receives all.
  socket.on('answer:submit', ({ text }) => {
    if (socket.data.role !== 'player') return;
    answers.set(socket.id, { text: String(text || '').slice(0, 280), revealed: false });
    // Send back to the player so they can see their own text
    socket.emit('answer:you', { text: answers.get(socket.id).text });
    // Send to host privately
    if (hostId) io.to(hostId).emit('answer:update', snapshotAnswers());
  });

  // Host reveal one
  socket.on('answer:revealOne', ({ playerId }) => {
    if (socket.id !== hostId) return;
    const a = answers.get(playerId);
    if (!a) return;
    a.revealed = true;
    io.emit('answer:revealed', { playerId, text: a.text });
    if (hostId) io.to(hostId).emit('answer:update', snapshotAnswers());
  });

  // Host reveal all
  socket.on('answer:revealAll', () => {
    if (socket.id !== hostId) return;
    for (const [pid, a] of answers.entries()) {
      a.revealed = true;
      io.emit('answer:revealed', { playerId: pid, text: a.text });
    }
    if (hostId) io.to(hostId).emit('answer:update', snapshotAnswers());
  });

  // Host reset answers
  socket.on('answer:reset', () => {
    if (socket.id !== hostId) return;
    for (const [pid, a] of answers.entries()) {
      a.text = '';
      a.revealed = false;
    }
    io.emit('answer:resetAll');
    if (hostId) io.to(hostId).emit('answer:update', snapshotAnswers());
  });

  socket.on('disconnect', () => {
    if (socket.id === hostId) hostId = null;
    players.delete(socket.id);
    answers.delete(socket.id);

    broadcastRoster();
    socket.broadcast.emit('peer:leave', { id: socket.id });

    if (hostId) io.to(hostId).emit('answer:update', snapshotAnswers());
  });
});

function snapshotAnswers() {
  // Returns array sorted by player index
  const arr = Array.from(answers.entries()).map(([id, a]) => ({ id, text: a.text, revealed: a.revealed, name: players.get(id)?.name || 'Player', index: players.get(id)?.index || 0 }));
  return arr.sort((x, y) => x.index - y.index);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game Show MVP running on http://localhost:${PORT}`));
