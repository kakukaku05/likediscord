const socket = io();

const roomId = location.pathname.split("/").pop();
document.getElementById("room").textContent = roomId;

const statusEl = document.getElementById("status");
const membersEl = document.getElementById("members");
const videosEl = document.getElementById("videos");

const btnJoin = document.getElementById("btnJoin");
const btnMute = document.getElementById("btnMute");
const btnShare = document.getElementById("btnShare");

const messagesEl = document.getElementById("messages");
const msgInput = document.getElementById("msgInput");
const btnSend = document.getElementById("btnSend");

const localVideo = document.getElementById("localVideo");

let localAudioStream = null;
let screenStream = null;
let isMuted = false;
let isSharing = false;

// peerId -> { pc, audioEl, videoEl }
const peers = new Map();

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setStatus(s) { statusEl.textContent = s; }

function renderMembers() {
  membersEl.innerHTML = "";
  const ids = ["me", ...peers.keys()];
  ids.forEach((id) => {
    const li = document.createElement("li");
    li.textContent = id === "me" ? "自分" : `参加者: ${id}`;
    membersEl.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function appendMsg({ from, text, ts }) {
  const div = document.createElement("div");
  div.className = "msg";
  const time = new Date(ts).toLocaleTimeString();
  div.innerHTML = `<div><strong>${from === "me" ? "自分" : from}</strong> <small>${time}</small></div>
                   <div>${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function makeMediaEls(peerId) {
  const wrap = document.createElement("div");
  wrap.id = `wrap-${peerId}`;
  wrap.innerHTML = `<div><small>${peerId}</small></div>`;

  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.playsInline = true;
  audioEl.style.display = "none";
  wrap.appendChild(audioEl);

  const videoEl = document.createElement("video");
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  wrap.appendChild(videoEl);

  videosEl.appendChild(wrap);
  return { audioEl, videoEl };
}

function removeMediaEls(peerId) {
  const wrap = document.getElementById(`wrap-${peerId}`);
  if (wrap) wrap.remove();
}

async function getOrCreatePeer(peerId) {
  const existing = peers.get(peerId);
  if (existing) return existing.pc;

  const pc = new RTCPeerConnection(rtcConfig);

  // 自分の音声を送る
  localAudioStream.getTracks().forEach((t) => pc.addTrack(t, localAudioStream));

  const { audioEl, videoEl } = makeMediaEls(peerId);

  // 受信音声/映像
  pc.ontrack = (ev) => {
    if (ev.track.kind === "audio") audioEl.srcObject = ev.streams[0];
    if (ev.track.kind === "video") videoEl.srcObject = ev.streams[0];
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit("signal", { to: peerId, data: { type: "ice", candidate: ev.candidate } });
    }
  };

  peers.set(peerId, { pc, audioEl, videoEl });
  renderMembers();
  return pc;
}

async function makeOffer(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  const offer = await p.pc.createOffer();
  await p.pc.setLocalDescription(offer);
  socket.emit("signal", { to: peerId, data: { type: "offer", sdp: offer } });
}

async function callPeer(peerId) {
  const pc = await getOrCreatePeer(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { to: peerId, data: { type: "offer", sdp: offer } });
}

async function handleOffer(from, sdp) {
  const pc = await getOrCreatePeer(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("signal", { to: from, data: { type: "answer", sdp: answer } });
}

async function handleAnswer(from, sdp) {
  const p = peers.get(from);
  if (!p) return;
  await p.pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleIce(from, candidate) {
  const p = peers.get(from);
  if (!p) return;
  try { await p.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

function removePeer(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  p.pc.close();
  removeMediaEls(peerId);
  peers.delete(peerId);
  renderMembers();
}

function getVideoSender(pc) {
  return pc.getSenders().find((s) => s.track && s.track.kind === "video");
}

async function startShare() {
  // 画面共有はHTTPS（またはlocalhost）で動く仕様 :contentReference[oaicite:0]{index=0}
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = screenStream.getVideoTracks()[0];

  localVideo.srcObject = screenStream;
  isSharing = true;
  btnShare.textContent = "共有停止";

  for (const [peerId, { pc }] of peers.entries()) {
    const sender = getVideoSender(pc);
    if (sender) await sender.replaceTrack(track);
    else pc.addTrack(track, screenStream);
    await makeOffer(peerId);
  }

  track.onended = () => stopShare().catch(() => {});
}

async function stopShare() {
  if (!screenStream) return;

  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  localVideo.srcObject = null;

  for (const [peerId, { pc }] of peers.entries()) {
    const sender = getVideoSender(pc);
    if (sender) {
      try { await sender.replaceTrack(null); } catch {}
      await makeOffer(peerId);
    }
  }

  isSharing = false;
  btnShare.textContent = "画面共有";
}

btnJoin.onclick = async () => {
  btnJoin.disabled = true;
  setStatus("マイク取得中…");

  // マイクはHTTPS（またはlocalhost）で動く仕様 :contentReference[oaicite:1]{index=1}
  localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  setStatus("入室中…");
  socket.emit("join-room", { roomId });

  btnMute.disabled = false;
  btnShare.disabled = false;
  setStatus("入室済み");
  renderMembers();
};

btnMute.onclick = () => {
  if (!localAudioStream) return;
  isMuted = !isMuted;
  localAudioStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  btnMute.textContent = isMuted ? "ミュート解除" : "ミュート";
};

btnShare.onclick = async () => {
  try {
    if (!isSharing) await startShare();
    else await stopShare();
  } catch (e) {
    console.error(e);
    alert("画面共有できない：HTTPS/許可設定を確認してね");
  }
};

function sendChat() {
  const text = msgInput.value;
  msgInput.value = "";
  socket.emit("chat-message", { text });
  appendMsg({ from: "me", text, ts: Date.now() });
}
btnSend.onclick = sendChat;
msgInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

// --- Socket events ---
socket.on("room-users", async ({ users }) => {
  for (const uid of users) await callPeer(uid);
});

socket.on("user-joined", ({ userId }) => {
  renderMembers();
  appendMsg({ from: "system", text: `${userId} が入室`, ts: Date.now() });
});

socket.on("user-left", ({ userId }) => {
  removePeer(userId);
  appendMsg({ from: "system", text: `${userId} が退出`, ts: Date.now() });
});

socket.on("chat-message", ({ from, text, ts }) => {
  appendMsg({ from, text, ts });
});

socket.on("signal", async ({ from, data }) => {
  if (data.type === "offer") return handleOffer(from, data.sdp);
  if (data.type === "answer") return handleAnswer(from, data.sdp);
  if (data.type === "ice") return handleIce(from, data.candidate);
});