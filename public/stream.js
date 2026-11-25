const el = id => document.getElementById(id);
const video = el('screenVideo');
const peers = new Map();
const videoKbps = 8000;
let captureCheck;
const sourceWarning = 'Choose a screen or 16:9 window that supports 1920 × 1080.';

function isFullHD(track) {
  const { width, height } = track.getSettings();
  return width === 1920 && height === 1080;
}

// Set the media bandwidth on the signaled description, leaving other sections intact.
function videoDescription(pc) {
  const { type, sdp } = pc.localDescription;
  const sections = sdp.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=video ')) return section;
    const lines = section.split(/\r?\n/).filter(line => !/^b=AS:/.test(line));
    let i = 1;
    while (/^[ic]=/.test(lines[i])) i++;
    lines.splice(i, 0, 'b=AS:' + videoKbps);
    return lines.join('\r\n');
  });
  return { type, sdp: sections.join('') };
}

let previewRequested = false;
function setPreview(requested) {
  previewRequested = requested;
  const enabled = requested && !document.hidden;
  if (!enabled) video.pause();
  video.srcObject = enabled ? localStream : null;
  video.classList.toggle('active', enabled);
  el('previewNotice').hidden = enabled;
  el('preview').textContent = enabled ? 'Hide preview' : 'Show preview';
  el('preview').setAttribute('aria-pressed', String(enabled));
  el('actualSize').textContent = '';
}

el('preview').onclick = () => { if (isSharing) setPreview(!previewRequested); };

function showStream(stream, host) {
  video.muted = host;
  document.body.classList.add('streaming');
  el('preview').hidden = !host;
  if (host) {
    setPreview(false);
  } else {
    video.srcObject = stream;
    video.classList.add('active');
    startPlaybackMeter();
  }
  el('playerTools').hidden = false;
  el('sound').hidden = host || !stream.getAudioTracks().length;
  el('sound').textContent = 'Mute';
  el('full').hidden = !document.fullscreenEnabled;
  el('screenPlaceholder').style.display = 'none';
  el(host ? 'hostBadge' : 'viewerBadge').classList.add('active');
  el('statusBadge').className = 'status-badge ' + (host ? 'active' : 'viewing');
  el('statusText').textContent = host ? 'Sharing' : 'Viewing';
}

let playbackTimer;
function startPlaybackMeter() {
  clearInterval(playbackTimer);
  if (document.hidden || !video.getVideoPlaybackQuality) return;
  let previous;
  playbackTimer = setInterval(() => {
    const { totalVideoFrames, droppedVideoFrames } = video.getVideoPlaybackQuality();
    const frames = totalVideoFrames - droppedVideoFrames;
    const time = performance.now();
    if (previous && frames >= previous.frames && video.videoHeight && !document.hidden) {
      const fps = Math.round((frames - previous.frames) * 1000 / (time - previous.time));
      el('actualSize').textContent = 'Playing ' + video.videoHeight + 'p · ' + fps + ' fps';
    }
    previous = document.hidden ? null : { frames, time };
  }, 1000);
}

function updateVisibility() {
  document.body.classList.toggle('page-hidden', document.hidden);
  if (isSharing) setPreview(previewRequested);
  else if (video.srcObject) startPlaybackMeter();
  if (document.hidden) clearTimeout(overlayTimer);
  else revealOverlay();
}
document.addEventListener('visibilitychange', updateVisibility);

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
video.onloadedmetadata = () => {
  const stream = video.srcObject;
  if (!stream || (isSharing && document.hidden)) return;
  video.play().catch(() => {
    if (stream !== video.srcObject || isSharing) return;
    el('sound').hidden = false;
    el('sound').textContent = 'Play';
  });
};
el('full').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el('theater').requestFullscreen();
  } catch { el('statusText').textContent = 'Full screen unavailable'; }
};
const theater = el('theater');
let overlayTimer;
updateVisibility();
function revealOverlay() {
  if (document.hidden || document.fullscreenElement !== theater) return;
  theater.classList.remove('overlay-idle');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => theater.classList.add('overlay-idle'), 5500);
}
for (const event of ['pointermove', 'pointerdown', 'keydown', 'input', 'focusin', 'wheel']) {
  theater.addEventListener(event, revealOverlay, { passive: true });
}
socket.on('chat-message', revealOverlay);
socket.on('receive-voice', revealOverlay);

document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === el('theater');
  el('full').textContent = active ? 'Exit full screen' : 'Full screen';
  el('overlayToggle').hidden = !active;
  clearTimeout(overlayTimer);
  theater.classList.remove('overlay-idle');
  setChatVisible(true);
  if (active) revealOverlay();
});

function setChatVisible(visible) {
  el('chatPanel').hidden = !visible;
  el('overlayToggle').textContent = visible ? 'Hide chat' : 'Show chat';
  el('overlayToggle').setAttribute('aria-expanded', String(visible));
}
el('overlayToggle').onclick = () => setChatVisible(el('chatPanel').hidden);

function closePeer(id) {
  peers.get(id)?.pc.close();
  peers.delete(id);
}

function createPeer(id, session) {
  const pc = new RTCPeerConnection(configuration);
  const peer = { pc, session, pending: [] };
  peers.set(id, peer);
  pc.onicecandidate = ({candidate}) => {
    if (candidate) socket.emit('webrtc-ice', { to: id, session, candidate: candidate.toJSON() });
  };
  return peer;
}

async function setRemote(peer, sdp) {
  await peer.pc.setRemoteDescription(sdp);
  for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate);
}

async function offerTo(id) {
  if (!isSharing || peers.has(id)) return;
  const peer = createPeer(id, crypto.randomUUID());
  try {
    let videoSender;
    for (const track of localStream.getTracks()) {
      const sender = peer.pc.addTrack(track, localStream);
      if (track.kind === 'video') videoSender = sender;
    }
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    const params = videoSender.getParameters();
    for (const encoding of params.encodings) {
      encoding.scaleResolutionDownBy = 1;
      encoding.maxBitrate = videoKbps * 1000;
    }
    params.degradationPreference = 'maintain-resolution';
    await videoSender.setParameters(params);
    if (peers.get(id) !== peer) return;
    socket.emit('webrtc-offer', { to: id, session: peer.session, sdp: videoDescription(peer.pc) });
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

socket.on('webrtc-offer', async ({from, session, sdp}) => {
  if (isHost) return;
  closePeer(from);
  const peer = createPeer(from, session);
  peer.pc.ontrack = ({streams}) => {
    if (video.srcObject !== streams[0]) showStream(streams[0], false);
  };
  try {
    await setRemote(peer, sdp);
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    socket.emit('webrtc-answer', { to: from, session, sdp: videoDescription(peer.pc) });
  } catch {
    if (peers.get(from) === peer) el('statusText').textContent = 'Connection failed';
  }
});
socket.on('webrtc-answer', async ({from, session, sdp}) => {
  const peer = peers.get(from);
  if (peer?.session !== session) return;
  try {
    await setRemote(peer, sdp);
  } catch { el('statusText').textContent = 'Connection failed'; }
});
socket.on('webrtc-ice', async ({from, session, candidate}) => {
  const peer = peers.get(from);
  if (!peer || peer.session !== session) return;
  if (!peer.pc.remoteDescription) peer.pending.push(candidate);
  else await peer.pc.addIceCandidate(candidate).catch(console.warn);
});
async function toggleScreenShare() {
  if (!isHost) return;
  if (isSharing) return stopScreenShare();
  el('shareBtn').disabled = true;
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: true
    });
    const track = localStream.getVideoTracks()[0];
    await track.applyConstraints({
      width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { ideal: 60 }
    });
    if (!isFullHD(track)) throw new DOMException(sourceWarning, 'OverconstrainedError');
    if ('contentHint' in track) track.contentHint = 'motion';
    isSharing = true;
    showStream(localStream, true);
    track.onended = stopScreenShare;
    captureCheck = setInterval(() => {
      if (isFullHD(track)) return;
      stopScreenShare();
      el('statusText').textContent = sourceWarning;
    }, 1000);
    el('shareBtn').classList.add('recording');
    el('shareBtnText').textContent = 'Stop Sharing';
    socket.emit('list-viewers');
  } catch (error) {
    resetStream();
    const message = error.name === 'NotAllowedError' ? 'Sharing cancelled' : 'Screen sharing unavailable';
    el('statusText').textContent = error.name === 'OverconstrainedError' ? sourceWarning : message;
  } finally { el('shareBtn').disabled = false; }
}

function resetStream() {
  clearInterval(captureCheck);
  if (document.fullscreenElement === el('theater')) document.exitFullscreen().catch(() => {});
  clearInterval(playbackTimer);
  isSharing = false;
  previewRequested = false;
  for (const id of peers.keys()) closePeer(id);
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  document.body.classList.remove('streaming');
  el('previewNotice').hidden = true;
  el('preview').hidden = true;
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
