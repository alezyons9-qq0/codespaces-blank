const el = id => document.getElementById(id);
const video = el('screenVideo');
const quality = el('quality');
const peers = new Map();
const heights = [2160, 1440, 1080, 720, 480, 360];
let sourceHeight = 0;
let broadcastLimit = 0;

function showStream(stream, host, height) {
  sourceHeight = height;
  quality.replaceChildren(new Option('Maximum', '0'));
  for (const h of heights.filter(h => h < height)) quality.add(new Option(h + 'p', h));
  quality.setAttribute('aria-label', host ? 'Broadcast quality limit' : 'Playback quality');
  quality.title = quality.getAttribute('aria-label');
  video.muted = host;
  video.srcObject = stream;
  video.classList.add('active');
  el('playerTools').hidden = false;
  el('sound').hidden = host || !stream.getAudioTracks().length;
  el('sound').textContent = 'Mute';
  el('full').hidden = !document.fullscreenEnabled;
  el('screenPlaceholder').style.display = 'none';
  el(host ? 'hostBadge' : 'viewerBadge').classList.add('active');
  el('statusBadge').className = 'status-badge ' + (host ? 'active' : 'viewing');
  el('statusText').textContent = host ? 'Sharing' : 'Viewing';
}

video.onresize = () => {
  if (video.videoHeight) el('actualSize').textContent = (isSharing ? 'Preview ' : '') + video.videoHeight + 'p';
};
el('sound').onclick = () => {
  if (video.paused) {
    video.play().catch(() => { el('statusText').textContent = 'Playback unavailable'; });
  } else {
    video.muted = !video.muted;
  }
  el('sound').textContent = video.muted ? 'Unmute' : 'Mute';
};
video.onloadedmetadata = () => video.play().catch(() => {
  el('sound').hidden = false;
  el('sound').textContent = 'Play';
});
el('full').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el('screenDisplay').requestFullscreen();
  } catch { el('statusText').textContent = 'Full screen unavailable'; }
};
document.addEventListener('fullscreenchange', () => {
  el('full').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});

function closePeer(id) {
  peers.get(id)?.pc.close();
  peers.delete(id);
}

function createPeer(id, session) {
  const pc = new RTCPeerConnection(configuration);
  const peer = { pc, session, to: id, pending: [], requested: 0, updates: Promise.resolve() };
  peers.set(id, peer);
  pc.onicecandidate = ({candidate}) => {
    if (candidate) socket.emit('webrtc-ice', { to: id, session, candidate });
  };
  return peer;
}

async function setRemote(peer, sdp) {
  await peer.pc.setRemoteDescription(sdp);
  for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate);
}

function updateQuality(peer) {
  peer.updates = peer.updates.then(async () => {
    if (peers.get(peer.to) !== peer || !peer.pc.remoteDescription) return;
    const params = peer.sender.getParameters();
    const height = peer.sender.track.getSettings().height || sourceHeight;
    const limit = Math.min(broadcastLimit || height, peer.requested || height);
    if (!params.encodings?.length) throw new Error('Encoding unavailable');
    params.encodings[0].scaleResolutionDownBy = Math.max(1, height / limit);
    await peer.sender.setParameters(params);
    socket.emit('quality-result', { to: peer.to, session: peer.session, ok: true });
  }).catch(() => {
    if (peers.get(peer.to) !== peer) return;
    el('statusText').textContent = 'Quality setting unavailable';
    socket.emit('quality-result', { to: peer.to, session: peer.session, ok: false });
  });
}

quality.onchange = () => {
  const value = Number(quality.value);
  if (isHost) {
    broadcastLimit = value;
    peers.forEach(updateQuality);
  } else {
    for (const peer of peers.values()) socket.emit('quality', { to: peer.to, session: peer.session, value });
  }
};

async function offerTo(id) {
  if (!isSharing || peers.has(id)) return;
  const peer = createPeer(id, crypto.randomUUID());
  try {
    for (const track of localStream.getTracks()) {
      const sender = peer.pc.addTrack(track, localStream);
      if (track.kind === 'video') peer.sender = sender;
    }
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    socket.emit('webrtc-offer', { to: id, session: peer.session, height: sourceHeight, sdp: peer.pc.localDescription });
  } catch {
    if (peers.get(id) === peer) {
      closePeer(id);
      el('statusText').textContent = 'Viewer connection failed';
    }
  }
}
socket.on('viewers', ids => ids.forEach(offerTo));
socket.on('viewer-joined', offerTo);
socket.on('viewer-left', closePeer);

socket.on('webrtc-offer', async ({from, session, height, sdp}) => {
  if (isHost) return;
  closePeer(from);
  const peer = createPeer(from, session);
  peer.pc.ontrack = ({streams}) => {
    if (video.srcObject !== streams[0]) showStream(streams[0], false, height);
  };
  try {
    await setRemote(peer, sdp);
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    socket.emit('webrtc-answer', { to: from, session, sdp: peer.pc.localDescription });
  } catch {
    if (peers.get(from) === peer) el('statusText').textContent = 'Connection failed';
  }
});
socket.on('webrtc-answer', async ({from, session, sdp}) => {
  const peer = peers.get(from);
  if (peer?.session !== session) return;
  try {
    await setRemote(peer, sdp);
    if (broadcastLimit || peer.requested) updateQuality(peer);
  } catch { el('statusText').textContent = 'Connection failed'; }
});
socket.on('webrtc-ice', async ({from, session, candidate}) => {
  const peer = peers.get(from);
  if (!peer || peer.session !== session) return;
  if (!peer.pc.remoteDescription) peer.pending.push(candidate);
  else await peer.pc.addIceCandidate(candidate).catch(console.warn);
});
socket.on('quality', ({from, session, value}) => {
  const peer = peers.get(from);
  if (!peer || peer.session !== session || ![0, ...heights].includes(value)) return;
  peer.requested = value;
  updateQuality(peer);
});
socket.on('quality-result', ({from, session, ok}) => {
  if (peers.get(from)?.session === session) el('statusText').textContent = ok ? 'Viewing' : 'Quality setting unavailable';
});

async function toggleScreenShare() {
  if (!isHost) return;
  if (isSharing) return stopScreenShare();
  el('shareBtn').disabled = true;
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, displaySurface: 'browser' },
      audio: true
    });
    const track = localStream.getVideoTracks()[0];
    isSharing = true;
    showStream(localStream, true, track.getSettings().height);
    track.onended = stopScreenShare;
    el('shareBtn').classList.add('recording');
    el('shareBtnText').textContent = 'Stop Sharing';
    socket.emit('list-viewers');
  } catch (error) {
    resetStream();
    el('statusText').textContent = error.name === 'NotAllowedError' ? 'Sharing cancelled' : 'Screen sharing unavailable';
  } finally { el('shareBtn').disabled = false; }
}

function resetStream() {
  for (const id of peers.keys()) closePeer(id);
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  broadcastLimit = 0;
  isSharing = false;
  video.srcObject = null;
  video.classList.remove('active');
  el('actualSize').textContent = '';
  el('playerTools').hidden = true;
  el('shareBtn').classList.remove('recording');
  el('shareBtnText').textContent = 'Share Screen';
  el('hostBadge').classList.remove('active');
  el('viewerBadge').classList.remove('active');
  el('screenPlaceholder').style.display = 'block';
  el('statusBadge').className = 'status-badge';
  el('statusText').textContent = 'Idle';
}
function stopScreenShare() {
  resetStream();
  socket.emit('stop-screen-share');
}
socket.on('stop-screen-share', resetStream);
socket.on('disconnect', () => { resetStream(); isHost = false; });
socket.on('connect', () => { if (username) socket.emit('join-room', roomCode, username); });
