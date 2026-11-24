const el = id => document.getElementById(id);
const video = el('screenVideo');
const quality = el('quality');
const peers = new Map();
const fpsControl = el('streamFps');
const fpsProfiles = {
  30: { hint: 'detail', preference: 'maintain-resolution', bitrate: 1500000 },
  60: { hint: 'motion', preference: 'maintain-framerate', bitrate: 6000000 }
};
function selectedFps() {
  return fpsControl.value === '30' ? 30 : 60;
}
fpsControl.onchange = () => { if (isHost && isSharing) syncCapture(); };
const heights = [2160, 1440, 1080, 720, 480, 360];
let sourceHeight = 0;
let broadcastLimit = 0;
let captureUpdates = Promise.resolve();
let appliedProfile = '';
let lastViewerLimit = null;

function setPreview(enabled) {
  video.srcObject = enabled ? localStream : null;
  video.classList.toggle('active', enabled);
  el('previewNotice').hidden = enabled;
  el('preview').textContent = enabled ? 'Hide preview' : 'Show preview';
  el('preview').setAttribute('aria-pressed', String(enabled));
  el('actualSize').textContent = '';
}

el('preview').onclick = () => { if (isSharing) setPreview(!video.srcObject); };

function syncCapture() {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  captureUpdates = captureUpdates.then(async () => {
    if (track !== localStream?.getVideoTracks()[0]) return;
    const automatic = quality.value === 'auto';
    const busy = peers.size >= 3;
    const target = automatic ? (busy ? 720 : 1080) : Number(quality.value);
    const fps = selectedFps();
    const profile = target + '/' + fps;
    if (profile === appliedProfile) return;
    broadcastLimit = target;
    try {
      if ('contentHint' in track) track.contentHint = fpsProfiles[fps].hint;
      const constraints = { frameRate: { ideal: fps, max: fps } };
      if (target) constraints.height = { max: Math.min(target, sourceHeight || target) };
      await track.applyConstraints(constraints);
      if (track !== localStream?.getVideoTracks()[0]) return;
      appliedProfile = profile;
    } catch {
      if (track !== localStream?.getVideoTracks()[0]) return;
      el('statusText').textContent = 'Sharing with browser capture settings';
    }
    peers.forEach(updateQuality);
  });
}

function sendViewerLimit() {
  if (isHost || !peers.size || !video.srcObject) return;
  // Auto lets WebRTC adapt to the connection without coupling encoding to CSS size.
  const value = quality.value === 'auto' ? 0 : Number(quality.value);
  if (value === lastViewerLimit) return;
  lastViewerLimit = value;
  for (const peer of peers.values()) socket.emit('quality', { to: peer.to, session: peer.session, value });
}

function showStream(stream, host, height) {
  sourceHeight = height;
  quality.replaceChildren(new Option('Maximum', '0'), new Option('Auto', 'auto'));
  for (const h of heights.filter(h => h < height)) quality.add(new Option(h + 'p', h));
  quality.setAttribute('aria-label', host ? 'Broadcast quality limit' : 'Playback quality');
  quality.title = quality.getAttribute('aria-label');
  video.muted = host;
  document.body.classList.add('streaming');
  el('preview').hidden = !host;
  if (host) {
    quality.after(fpsControl);
    setPreview(false);
  } else {
    video.srcObject = stream;
    video.classList.add('active');
    lastViewerLimit = null;
    sendViewerLimit();
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
  if (!video.getVideoPlaybackQuality) return;
  let previous;
  playbackTimer = setInterval(() => {
    const { totalVideoFrames, droppedVideoFrames } = video.getVideoPlaybackQuality();
    const frames = totalVideoFrames - droppedVideoFrames;
    const time = performance.now();
    if (previous && frames >= previous.frames && video.videoHeight && !document.hidden) {
      const fps = Math.round((frames - previous.frames) * 1000 / (time - previous.time));
      el('actualSize').textContent = video.videoHeight + 'p · ' + fps + ' fps';
    }
    previous = document.hidden ? null : { frames, time };
  }, 1000);
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
    else await el('theater').requestFullscreen();
  } catch { el('statusText').textContent = 'Full screen unavailable'; }
};
const theater = el('theater');
let overlayTimer;
function revealOverlay() {
  if (document.fullscreenElement !== theater) return;
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
  if (peers.delete(id) && isSharing) syncCapture();
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
    const fps = selectedFps();
    const encoding = {
      scaleResolutionDownBy: Math.max(1, height / limit),
      maxFramerate: fps,
      maxBitrate: fpsProfiles[fps].bitrate
    };
    Object.assign(params.encodings[0], encoding);
    params.degradationPreference = fpsProfiles[fps].preference;
    try {
      await peer.sender.setParameters(params);
    } catch (error) {
      if (!['TypeError', 'NotSupportedError', 'InvalidModificationError'].includes(error.name)) throw error;
      const fallback = peer.sender.getParameters();
      Object.assign(fallback.encodings[0], encoding);
      await peer.sender.setParameters(fallback);
    }
    socket.emit('quality-result', { to: peer.to, session: peer.session, ok: true });
  }).catch(() => {
    if (peers.get(peer.to) !== peer) return;
    el('statusText').textContent = 'Quality setting unavailable';
    socket.emit('quality-result', { to: peer.to, session: peer.session, ok: false });
  });
}

quality.onchange = () => {
  if (isHost) syncCapture();
  else sendViewerLimit();
};

function preferH264(pc) {
  const capabilities = globalThis.RTCRtpReceiver?.getCapabilities?.('video');
  if (!capabilities?.codecs) return;
  const h264 = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return;
  // Preserve the browser's order among the H.264 profiles it supports.
  const ordered = [...h264, ...capabilities.codecs.filter(codec => !h264.includes(codec))];
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track.kind !== 'video') continue;
    try {
      transceiver.setCodecPreferences?.(ordered);
    } catch (error) {
      console.debug('Using browser codec order', error.name);
    }
  }
}

async function offerTo(id) {
  if (!isSharing || peers.has(id)) return;
  const peer = createPeer(id, crypto.randomUUID());
  syncCapture();
  try {
    for (const track of localStream.getTracks()) {
      const sender = peer.pc.addTrack(track, localStream);
      if (track.kind === 'video') peer.sender = sender;
    }
    preferH264(peer.pc);
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
    preferH264(peer.pc);
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
    updateQuality(peer);
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
    const fps = selectedFps();
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps }, displaySurface: 'browser' },
      audio: true
    });
    const track = localStream.getVideoTracks()[0];
    if ('contentHint' in track) track.contentHint = fpsProfiles[fps].hint;
    isSharing = true;
    showStream(localStream, true, track.getSettings().height);
    syncCapture();
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
  if (document.fullscreenElement === el('theater')) document.exitFullscreen().catch(() => {});
  el('fpsBeforeShare').append(fpsControl);
  clearInterval(playbackTimer);
  isSharing = false;
  for (const id of peers.keys()) closePeer(id);
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  broadcastLimit = 0;
  appliedProfile = '';
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
