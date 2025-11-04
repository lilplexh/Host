// Basic globals
const socket = io();
let me = { id: null, role: 'guest', name: '', index: null };
let localStream = null;
const peers = new Map(); // peerId -> SimplePeer instance

// UI elements
const joinScreen = document.getElementById('join-screen');
const nameInput = document.getElementById('name');
const btnHost = document.getElementById('btn-host');
const btnPlayer = document.getElementById('btn-player');
const app = document.getElementById('app');
const roleBadge = document.getElementById('role-badge');
const youName = document.getElementById('you-name');
const hostControls = document.getElementById('host-controls');
const hostPanel = document.getElementById('host-panel');
const answersList = document.getElementById('answers-list');

const tiles = {
  host: document.getElementById('host-video'),
  p1: document.querySelector('#p1 video'),
  p2: document.querySelector('#p2 video'),
  p3: document.querySelector('#p3 video'),
  p4: document.querySelector('#p4 video'),
};

const answerInputs = {
  1: document.querySelector('#p1 .answer-input'),
  2: document.querySelector('#p2 .answer-input'),
  3: document.querySelector('#p3 .answer-input'),
  4: document.querySelector('#p4 .answer-input'),
};
const answerButtons = {
  1: document.querySelector('#p1 .answer-send'),
  2: document.querySelector('#p2 .answer-send'),
  3: document.querySelector('#p3 .answer-send'),
  4: document.querySelector('#p4 .answer-send'),
};
const revealedBoxes = {
  1: document.querySelector('#p1 .answer-revealed'),
  2: document.querySelector('#p2 .answer-revealed'),
  3: document.querySelector('#p3 .answer-revealed'),
  4: document.querySelector('#p4 .answer-revealed'),
};

// Join flow
btnHost.onclick = () => join('host');
btnPlayer.onclick = () => join('player');

async function join(role) {
  const name = (nameInput.value || '').trim() || (role === 'host' ? 'Host' : 'Player');
  me.role = role;
  me.name = name;
  roleBadge.textContent = role === 'host' ? 'You are the HOST' : 'You are a PLAYER';
  youName.textContent = name;

  joinScreen.classList.add('hidden');
  app.classList.remove('hidden');

  // Host controls visible only for host
  if (role === 'host') {
    hostControls.classList.remove('hidden');
    hostPanel.classList.remove('hidden');
  }

  // Get media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (role === 'host') tiles.host.srcObject = localStream;
  } catch (e) {
    alert('Could not access camera/mic: ' + e.message);
    return;
  }

  // Tell server we joined
  socket.emit('join', { role, name });
}

// Receive your identity
socket.on('you', ({ id, role, name, index }) => {
  me.id = id; me.role = role; me.name = name; me.index = index || null;
  // If player, show own video in our assigned tile
  if (role === 'player' && index) {
    tiles[`p${index}`].srcObject = localStream;
    setupPlayerAnswerUI(index);
  }
});

// Roster updates (for labels)
socket.on('roster', ({ hostPresent, players }) => {
  // Update player tile labels
  ['p1','p2','p3','p4'].forEach((id) => {
    const el = document.querySelector(`#${id} .label`);
    const pl = players.find(p => `p${p.index}` === id);
    el.textContent = pl ? `${pl.name}` : id.toUpperCase();
  });
});

// Handle new peer join -> if we are already in, we initiate a connection to them
socket.on('peer:join', async ({ id, role, index }) => {
  if (id === me.id) return;
  startPeerConnection(id, true);
});

// Handle peer leaving
socket.on('peer:leave', ({ id }) => {
  const p = peers.get(id);
  if (p) { p.destroy(); peers.delete(id); }
});

// Signaling pass-through
socket.on('signal', ({ fromId, data }) => {
  let p = peers.get(fromId);
  if (!p) p = startPeerConnection(fromId, false); // we are the responder
  p.signal(data);
});

function startPeerConnection(peerId, initiator) {
  const p = new SimplePeer({ initiator, trickle: true, stream: localStream });

  p.on('signal', data => {
    socket.emit('signal', { targetId: peerId, data });
  });

  p.on('stream', stream => {
    // We don't know which tile yet; attach where appropriate by role index if available from roster
    attachIncomingStream(peerId, stream);
  });

  p.on('close', () => { /* handle if needed */ });
  p.on('error', (err) => console.warn('Peer error', err));

  peers.set(peerId, p);
  return p;
}

function attachIncomingStream(peerId, stream) {
  // We need to know if this peer is host or player -> infer from labels updated by roster
  // We'll match by socket id in label map from last roster; request roster is broadcasted often.
  // Simplify: try to find free tile without your own.
  const labelMap = {};
  // Read labels to figure names
  ['p1','p2','p3','p4'].forEach(id => { labelMap[id] = document.querySelector(`#${id} .label`).textContent; });

  // If we are host, we want to place players in their index tiles (matches labels)
  for (let i = 1; i <= 4; i++) {
    const v = tiles[`p${i}`];
    if (!v.srcObject) { v.srcObject = stream; return; }
  }

  // If all filled, do nothing
}

// === Answer logic ===
function setupPlayerAnswerUI(index) {
  const input = answerInputs[index];
  const btn = answerButtons[index];
  btn.onclick = () => {
    const text = input.value.trim();
    socket.emit('answer:submit', { text });
  };
}

// Player receives back their own answer (confirm saved)
socket.on('answer:you', ({ text }) => {
  if (me.role !== 'player') return;
  const idx = me.index;
  if (!idx) return;
  const box = revealedBoxes[idx];
  // Keep their typed text private (not revealed). We could show nothing here by design.
});

// Host receives full answers snapshot
socket.on('answer:update', (list) => {
  if (me.role !== 'host') return;
  answersList.innerHTML = '';
  list.forEach(({ id, name, index, text, revealed }) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="name">P${index} ${name}</span>
      <span class="text">${text || '<i>(no answer)</i>'}</span>
    `;
    const btn = document.createElement('button');
    btn.textContent = revealed ? 'Revealed' : 'Reveal';
    btn.disabled = revealed || !text;
    btn.onclick = () => socket.emit('answer:revealOne', { playerId: id });
    li.appendChild(btn);
    answersList.appendChild(li);
  });
});

// Revealed answer appears in that player tile for everyone
socket.on('answer:revealed', ({ playerId, text }) => {
  // Find index by label match in roster UI; simpler: try to place into the first matching non-empty revealed box
  // For MVP we broadcast to all four boxes and let the correct one stick if matching by name label later.
  // Here we just show on all until roster sorts it; improved version would map socketId -> index via roster events.
});

// Reset answers (all hidden)
socket.on('answer:resetAll', () => {
  Object.values(revealedBoxes).forEach(box => { box.classList.remove('show'); box.textContent = ''; });
});

// Host buttons
const btnRevealAll = document.getElementById('btn-reveal-all');
const btnReset = document.getElementById('btn-reset');
btnRevealAll.onclick = () => socket.emit('answer:revealAll');
btnReset.onclick = () => socket.emit('answer:reset');
