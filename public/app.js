'use strict';

const $ = (id) => document.getElementById(id);
const state = { roomId: null, ttlChoices: [], limits: {} };

// ---- helpers --------------------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtWhen(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60000);
  if (min < 60) return `in ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr} h`;
  return `in ${Math.round(hr / 24)} d`;
}
function show(el, yes) { el.hidden = !yes; }

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- room rendering -------------------------------------------------------
function fillTtlSelect() {
  const sel = $('ttlSelect');
  sel.innerHTML = '';
  for (const h of state.ttlChoices) {
    const label = h < 24 ? `${h} hour${h > 1 ? 's' : ''}` : `${h / 24} day${h / 24 > 1 ? 's' : ''}`;
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

function renderRoom(room, isCreator) {
  state.roomId = room.roomId;
  state.ttlChoices = room.fileTtlChoicesHours || [];
  state.limits = room.limits || {};

  show($('home'), false);
  show($('room'), true);
  show($('uploadArea'), isCreator);

  $('roomExpiry').textContent = `Room expires ${fmtWhen(room.expiresAt)}`;
  if (typeof room.usedBytes === 'number' && state.limits.maxRoomMb) {
    $('roomUsage').textContent = `${fmtBytes(room.usedBytes)} / ${state.limits.maxRoomMb} MB used`;
  }
  if (isCreator) fillTtlSelect();
  $('btnZip').href = `/api/rooms/${room.roomId}/zip`;
  renderFiles(room.files || []);
}

function renderFiles(files) {
  const list = $('fileList');
  list.innerHTML = '';
  show($('emptyHint'), files.length === 0);
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file';
    const isImg = (f.mimeType || '').startsWith('image/');
    const dlUrl = `/api/rooms/${state.roomId}/files/${f.id}`;
    const thumb = isImg
      ? `<img class="thumb" src="${dlUrl}" alt="" loading="lazy" />`
      : `<div class="thumb">📄</div>`;
    li.innerHTML = `
      ${thumb}
      <div class="info">
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="sub">${fmtBytes(f.size)} · expires ${fmtWhen(f.expiresAt)}</div>
      </div>
      <a class="dl" href="${dlUrl}" download>⬇</a>
      <button class="del" title="Delete" data-id="${f.id}">✕</button>`;
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshRoom() {
  if (!state.roomId) return;
  try {
    const room = await api(`/api/rooms/${state.roomId}`);
    $('roomExpiry').textContent = `Room expires ${fmtWhen(room.expiresAt)}`;
    if (state.limits.maxRoomMb)
      $('roomUsage').textContent = `${fmtBytes(room.usedBytes)} / ${state.limits.maxRoomMb} MB used`;
    renderFiles(room.files || []);
  } catch (e) {
    alert(e.message);
    leaveRoom();
  }
}

function leaveRoom() {
  state.roomId = null;
  $('pinInput').value = '';
  show($('room'), false);
  show($('home'), true);
}

// ---- upload (XHR for progress) -------------------------------------------
function uploadFiles(fileList) {
  const ttl = $('ttlSelect').value;
  const form = new FormData();
  let tooBig = null;
  for (const file of fileList) {
    if (state.limits.maxFileMb && file.size > state.limits.maxFileMb * 1024 * 1024) {
      tooBig = file.name;
      continue;
    }
    form.append('files', file, file.name);
  }
  if (tooBig) {
    $('uploadStatus').textContent = `Skipped "${tooBig}" (over ${state.limits.maxFileMb} MB).`;
  }
  if (![...form.keys()].length) return;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${state.roomId}/files?ttlHours=${ttl}`);
  show($('uploadProgress'), true);
  $('uploadProgress').value = 0;
  $('uploadStatus').textContent = 'Uploading…';

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) $('uploadProgress').value = (e.loaded / e.total) * 100;
  };
  xhr.onload = () => {
    show($('uploadProgress'), false);
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        $('uploadStatus').textContent = `Uploaded ${data.uploaded} file(s).`;
        refreshRoom();
      } else {
        $('uploadStatus').textContent = data.error || 'Upload failed.';
      }
    } catch {
      $('uploadStatus').textContent = 'Upload failed.';
    }
  };
  xhr.onerror = () => {
    show($('uploadProgress'), false);
    $('uploadStatus').textContent = 'Network error during upload.';
  };
  xhr.send(form);
}

// ---- wire up --------------------------------------------------------------
$('btnCreate').addEventListener('click', async () => {
  try {
    const room = await api('/api/rooms', { method: 'POST' });
    $('roomPin').textContent = room.pin;
    renderRoom({ ...room, files: [], usedBytes: 0 }, true);
  } catch (e) {
    alert(e.message);
  }
});

$('accessForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('pinInput').value.trim();
  show($('accessError'), false);
  try {
    const { roomId } = await api('/api/rooms/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const room = await api(`/api/rooms/${roomId}`);
    $('roomPin').textContent = pin;
    renderRoom(room, false);
  } catch (err) {
    $('accessError').textContent = err.message;
    show($('accessError'), true);
  }
});

$('fileInput').addEventListener('change', (e) => {
  if (e.target.files.length) uploadFiles(e.target.files);
  e.target.value = '';
});

$('fileList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.del');
  if (!btn) return;
  if (!confirm('Delete this file?')) return;
  try {
    await api(`/api/rooms/${state.roomId}/files/${btn.dataset.id}`, { method: 'DELETE' });
    refreshRoom();
  } catch (err) {
    alert(err.message);
  }
});

$('btnRefresh').addEventListener('click', refreshRoom);
$('btnLeave').addEventListener('click', leaveRoom);

$('serverHint').textContent = `Connected to ${location.host}`;

// Keep relative times + listing fresh while a room is open.
setInterval(() => { if (state.roomId) refreshRoom(); }, 15000);
