const el = id => document.getElementById(id);
const video = el('screenVideo');
const peers = new Map();
const videoKbps = 8000;
const noH264 = 'H.264 video is unavailable for this connection.';

function forceH264(sdp) {
  const sections = sdp.split(/(?=^m=)/m);
  return sections.map(section => {
    if (!section.startsWith('m=video ')) return section;
    const lines = section.split(/\r?\n/);
    const [media, port, protocol, ...formats] = lines.shift().split(/\s+/);
    const ids = lines.flatMap(line =>
      /^a=rtpmap:(\d+) H264\/90000\s*$/i.exec(line)?.slice(1) || []);
    const keep = formats.filter(id => ids.includes(id));
    if (!keep.length || (port === '0' && !lines.includes('a=bundle-only'))) throw new Error(noH264);

    const body = lines.filter(line => {
      const attr = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/i.exec(line);
      return !/^b=AS:/i.test(line) && (!attr || keep.includes(attr[1]));
    });
    let i = 0;
    while (/^[ic]=/.test(body[i])) i++;
    body.splice(i, 0, 'b=AS:' + videoKbps);
    return [[media, port, protocol, ...keep].join(' '), ...body].join('\r\n');
  }).join('');
}

async function preferH264(transceiver, capabilities, captureSettings) {
  if (!transceiver.setCodecPreferences || !capabilities) return;
  const codecs = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
  if (!codecs.length) throw new Error(noH264);
  if (captureSettings && navigator.mediaCapabilities?.encodingInfo) {
    const { width, height, frameRate } = captureSettings;
    const ranked = await Promise.all(codecs.map(async codec => {
      let efficient = false;
      try {
        const contentType = [codec.mimeType, codec.sdpFmtpLine].filter(Boolean).join(';');
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType, width, height, framerate: frameRate || 60, bitrate: videoKbps * 1000 }
        });
        efficient = info.supported && info.powerEfficient;
      } catch {
        // Capability queries are optional; retain the browser order for unknown profiles.
      }
      return { codec, efficient };
    }));
    ranked.sort((a, b) => Number(b.efficient) - Number(a.efficient));
    transceiver.setCodecPreferences(ranked.map(entry => entry.codec));
  } else {
    transceiver.setCodecPreferences(codecs);
  }
}

async function setLocalH264(pc, description) {
  const strict = { type: description.type, sdp: forceH264(description.sdp) };
  try {
    await pc.setLocalDescription(strict);
  } catch (error) {
    // Some engines require their unmodified local SDP. Signal only H.264 in either case.
    if (strict.sdp === description.sdp) throw error;
    await pc.setLocalDescription(description);
  }
  return { type: description.type, sdp: forceH264(pc.localDescription.sdp) };
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
    for (const track of localStream.getTracks()) {
      if (track.kind === 'video') {
        const transceiver = peer.pc.addTransceiver(track, { direction: 'sendonly', streams: [localStream] });
        await preferH264(transceiver, RTCRtpSender.getCapabilities?.('video'), track.getSettings());
        if (peers.get(id) !== peer) return;
        peer.videoSender = transceiver.sender;
      } else {
        peer.pc.addTrack(track, localStream);
      }
    }
    const offer = await setLocalH264(peer.pc, await peer.pc.createOffer());
    if (peers.get(id) !== peer) return;
    socket.emit('webrtc-offer', { to: id, session: peer.session, sdp: offer });
  } catch (error) {
    if (peers.get(id) === peer) {
      closePeer(id);
      el('statusText').textContent = error.message === noH264 ? noH264 : 'Viewer connection failed';
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
    // Keep the sender's H.264 profile order when answering a H.264-only offer.
    if (forceH264(sdp.sdp) !== sdp.sdp) {
      for (const transceiver of peer.pc.getTransceivers()) {
        if (transceiver.receiver.track.kind === 'video') {
          await preferH264(transceiver, RTCRtpReceiver.getCapabilities?.('video'));
        }
      }
    }
    const answer = await setLocalH264(peer.pc, await peer.pc.createAnswer());
    socket.emit('webrtc-answer', { to: from, session, sdp: answer });
  } catch (error) {
    if (peers.get(from) === peer) {
      closePeer(from);
      el('statusText').textContent = error.message === noH264 ? noH264 : 'Connection failed';
    }
  }
});
socket.on('webrtc-answer', async ({from, session, sdp}) => {
  const peer = peers.get(from);
  if (peer?.session !== session) return;
  try {
    await setRemote(peer, sdp);
  } catch { el('statusText').textContent = 'Connection failed'; return; }
  try {
    const params = peer.videoSender.getParameters();
    for (const encoding of params.encodings) {
      encoding.scaleResolutionDownBy = 1;
      encoding.maxBitrate = videoKbps * 1000;
    }
    params.degradationPreference = 'maintain-resolution';
    await peer.videoSender.setParameters(params);
  } catch (error) {
    console.debug('Using negotiated video settings', error.name);
  }
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
      video: { resizeMode: { ideal: 'none' }, frameRate: { ideal: 60 } },
      audio: true
    });
    const track = localStream.getVideoTracks()[0];
    if ('contentHint' in track) track.contentHint = 'motion';
    isSharing = true;
    showStream(localStream, true);
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
