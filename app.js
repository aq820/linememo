'use strict';
/* ===== Notion Chat Memo ===== */
const NOTION_VERSION = '2022-06-28';
const SINGLE_LIMIT = 20 * 1024 * 1024;   // 20MB以下は1回で送信
const PART_SIZE = 10 * 1024 * 1024;      // それ以上は10MBずつ分割
const LS = {
  settings: 'ncm.settings',
  rooms: 'ncm.rooms',
  current: 'ncm.currentRoom',
  msgs: id => 'ncm.messages.' + id,
};

const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');

let settings = Object.assign({ token: '', proxyUrl: '', databases: [], defaultDb: '' }, load(LS.settings, {}));
let rooms = load(LS.rooms, []);
let currentId = localStorage.getItem(LS.current) || '';
let pending = [];                 // 送信前の添付 File[]
const fileCache = new Map();      // msgId -> File[]（再送・プレビュー用、セッション内のみ）
const previewCache = new Map();   // File -> objectURL
const schemaCache = new Map();    // dbId -> {title, properties}

/* ---------- 日付 ---------- */
function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${todayStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function nowText(d = new Date()) { return `${todayStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/* ---------- ユーティリティ ---------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2500);
}
function normalizeDbId(input) {
  const s = String(input || '').trim().split('?')[0].split('#')[0];
  let m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0].toLowerCase();
  m = s.match(/[0-9a-f]{32}/ig);
  if (m) {
    const h = m[m.length - 1].toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return '';
}
function getRoom(id = currentId) { return rooms.find(r => r.id === id); }
function resolveDb(room) {
  const dbs = settings.databases.filter(d => d.dbId);
  return dbs.find(d => d.id === room?.dbRef) || dbs.find(d => d.id === settings.defaultDb) || dbs[0] || null;
}
function dbLabel(room) {
  const db = resolveDb(room);
  if (!db) return 'データベース未設定';
  const isDefault = !room.dbRef || !settings.databases.some(d => d.id === room.dbRef);
  return (db.name || db.dbId) + (isDefault ? '（デフォルト）' : '');
}
function guessType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })[ext] || '';
}
function fileUrl(f) {
  if (!previewCache.has(f)) previewCache.set(f, URL.createObjectURL(f));
  return previewCache.get(f);
}

/* ---------- Notion API ---------- */
async function api(path, { method = 'GET', json, form } = {}) {
  if (!settings.token) throw new Error('Notionトークンが未設定です（共通設定）');
  const base = (settings.proxyUrl || 'https://api.notion.com').trim().replace(/\/+$/, '');
  const headers = { 'Authorization': 'Bearer ' + settings.token, 'Notion-Version': NOTION_VERSION };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;
  let res;
  try { res = await fetch(base + path, { method, headers, body }); }
  catch (e) { throw new Error('通信できませんでした。API中継URL（CORSプロキシ）を確認してください。'); }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${data.message || text || res.statusText}`);
  return data;
}

async function getSchema(dbId, force = false) {
  if (!force && schemaCache.has(dbId)) return schemaCache.get(dbId);
  const d = await api(`/v1/databases/${dbId}`);
  const s = { title: (d.title || []).map(t => t.plain_text).join('') || '(無題)', properties: d.properties || {} };
  schemaCache.set(dbId, s);
  return s;
}

/** 2000文字（UTF-16）ごとにrich_textへ分割（サロゲートペアを壊さない） */
function richText(str) {
  const out = []; let i = 0;
  while (i < str.length) {
    let end = Math.min(i + 2000, str.length);
    if (end < str.length && /[\uD800-\uDBFF]/.test(str[end - 1])) end--;
    out.push({ type: 'text', text: { content: str.slice(i, end) } });
    i = end;
  }
  return out;
}
function textBlocks(text) {
  if (!text.trim()) return [];
  const rt = richText(text), blocks = [];
  for (let i = 0; i < rt.length; i += 100)
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt.slice(i, i + 100) } });
  return blocks;
}
function attachmentBlock(contentType, uploadId) {
  const kind = contentType.startsWith('image/') ? 'image'
    : contentType === 'application/pdf' ? 'pdf'
    : contentType.startsWith('video/') ? 'video'
    : contentType.startsWith('audio/') ? 'audio' : 'file';
  return { object: 'block', type: kind, [kind]: { type: 'file_upload', file_upload: { id: uploadId } } };
}

async function uploadFile(file) {
  const name = file.name || 'file';
  const contentType = file.type || guessType(name) || 'application/octet-stream';
  if (file.size <= SINGLE_LIMIT) {
    const up = await api('/v1/file_uploads', { method: 'POST', json: { filename: name, content_type: contentType } });
    const fd = new FormData();
    fd.append('file', new Blob([file], { type: contentType }), name);
    await api(`/v1/file_uploads/${up.id}/send`, { method: 'POST', form: fd });
    return { id: up.id, contentType };
  }
  const parts = Math.ceil(file.size / PART_SIZE);
  const up = await api('/v1/file_uploads', { method: 'POST', json: { mode: 'multi_part', number_of_parts: parts, filename: name, content_type: contentType } });
  for (let p = 0; p < parts; p++) {
    const fd = new FormData();
    fd.append('file', new Blob([file.slice(p * PART_SIZE, (p + 1) * PART_SIZE)], { type: contentType }), name);
    fd.append('part_number', String(p + 1));
    await api(`/v1/file_uploads/${up.id}/send`, { method: 'POST', form: fd });
  }
  await api(`/v1/file_uploads/${up.id}/complete`, { method: 'POST', json: {} });
  return { id: up.id, contentType };
}

function buildPropertyValue(type, p, propName) {
  const mode = p.mode || 'fixed';
  const fixed = () => String(p.value ?? '').replace(/\{\{today\}\}/g, todayStr()).replace(/\{\{now\}\}/g, nowText());
  const textVal = () => mode === 'today' ? todayStr() : mode === 'now' ? nowText() : fixed();
  const list = v => v.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
  switch (type) {
    case 'rich_text': return { rich_text: richText(textVal()) };
    case 'number': {
      const n = Number(textVal().replace(/,/g, ''));
      if (Number.isNaN(n)) throw new Error(`「${propName}」は数値プロパティです`);
      return { number: n };
    }
    case 'select': return { select: textVal() ? { name: textVal() } : null };
    case 'status': return { status: { name: textVal() } };
    case 'multi_select': return { multi_select: list(textVal()).map(name => ({ name })) };
    case 'date': {
      if (mode === 'today') return { date: { start: todayStr() } };
      if (mode === 'now') return { date: { start: nowIso() } };
      const v = String(p.value ?? '').trim()
        .replace(/\{\{today\}\}/g, todayStr()).replace(/\{\{now\}\}/g, nowIso());
      if (!v) return { date: null };
      const [start, end] = v.split(/\s*(?:→|~|〜)\s*/);
      return { date: end ? { start, end } : { start } };
    }
    case 'checkbox': return { checkbox: /^(true|1|yes|on|はい|✓|✔|済)$/i.test(textVal().trim()) };
    case 'url': return { url: textVal() || null };
    case 'email': return { email: textVal() || null };
    case 'phone_number': return { phone_number: textVal() || null };
    case 'relation': return { relation: list(textVal()).map(v => ({ id: normalizeDbId(v) || v })) };
    case 'people': return { people: list(textVal()).map(id => ({ object: 'user', id })) };
    default: throw new Error(`「${propName}」（${type}）への書き込みは未対応です`);
  }
}

async function createNotionPage(room, text, files, onProgress) {
  const db = resolveDb(room);
  if (!db) throw new Error('書き込み先データベースが未設定です（共通設定）');
  onProgress?.('データベース情報を取得中…');
  const schema = await getSchema(db.dbId);
  const titleProp = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title');
  if (!titleProp) throw new Error('タイトルプロパティが見つかりません');

  const lines = text.split(/\r?\n/);
  let title = (lines[0] || '').trim() || (lines.find(l => l.trim()) || '').trim();
  if (!title) title = files[0]?.name || nowText();

  const properties = { [titleProp]: { title: richText(title) } };
  if (room.propsEnabled) {
    for (const p of room.props || []) {
      const name = (p.name || '').trim();
      if (!name || name === titleProp) continue;
      const def = schema.properties[name];
      if (!def) throw new Error(`プロパティ「${name}」がデータベース「${schema.title}」にありません`);
      properties[name] = buildPropertyValue(def.type, p, name);
    }
  }

  const children = textBlocks(text);
  for (let i = 0; i < files.length; i++) {
    onProgress?.(`添付をアップロード中 (${i + 1}/${files.length}) ${files[i].name}`);
    const up = await uploadFile(files[i]);
    children.push(attachmentBlock(up.contentType, up.id));
  }

  onProgress?.('ページを作成中…');
  const page = await api('/v1/pages', {
    method: 'POST',
    json: { parent: { database_id: db.dbId }, properties, children: children.slice(0, 100) },
  });
  for (let i = 100; i < children.length; i += 100)
    await api(`/v1/blocks/${page.id}/children`, { method: 'PATCH', json: { children: children.slice(i, i + 100) } });
  return page.url;
}

/* ---------- メッセージ ---------- */
function getMsgs(roomId) { return load(LS.msgs(roomId), []); }
function updateMsg(roomId, msgId, patch) {
  const list = getMsgs(roomId);
  const m = list.find(x => x.id === msgId);
  if (!m) return;
  Object.assign(m, patch);
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete m[k];
  save(LS.msgs(roomId), list);
  if (roomId === currentId) renderMessages();
}
async function deliver(roomId, msgId) {
  const room = getRoom(roomId);
  const msg = getMsgs(roomId).find(m => m.id === msgId);
  if (!room || !msg) return;
  const files = fileCache.get(msgId) || [];
  updateMsg(roomId, msgId, { status: 'sending', error: undefined, progress: '送信中…' });
  try {
    const url = await createNotionPage(room, msg.text, files, p => updateMsg(roomId, msgId, { progress: p }));
    updateMsg(roomId, msgId, { status: 'ok', pageUrl: url, progress: undefined });
  } catch (e) {
    console.error(e);
    updateMsg(roomId, msgId, { status: 'error', error: e.message, progress: undefined });
  }
}
function send() {
  const room = getRoom();
  if (!room) { toast('先にルームを作成してください'); return; }
  const input = $('#input');
  const text = input.value;
  if (!text.trim() && !pending.length) return;
  const files = pending.slice();
  const msg = { id: uid(), text, ts: Date.now(), status: 'sending', files: files.map(f => ({ name: f.name, type: f.type, size: f.size })) };
  fileCache.set(msg.id, files);
  const list = getMsgs(room.id); list.push(msg); save(LS.msgs(room.id), list);
  input.value = ''; autoGrow(); pending = []; renderPending();
  renderMessages();
  deliver(room.id, msg.id);
}

/* ---------- 描画 ---------- */
function renderRooms() {
  const ul = $('#roomList');
  ul.innerHTML = rooms.map(r => `
    <li data-id="${r.id}" class="${r.id === currentId ? 'active' : ''}">
      <span class="rn">${esc(r.name || '無題のルーム')}</span>
      <span class="rd">${esc(dbLabel(r))}</span>
    </li>`).join('');
}
function renderHeader() {
  const r = getRoom();
  $('#roomName').textContent = r ? (r.name || '無題のルーム') : 'ルーム未選択';
  $('#roomDb').textContent = r ? '→ ' + dbLabel(r) + (r.propsEnabled && r.props?.length ? `　/ プロパティ ${r.props.length}件` : '') : '';
  $('#roomSettingsBtn').disabled = !r;
}
function renderMessages() {
  const box = $('#messages');
  const r = getRoom();
  if (!r) {
    box.innerHTML = `<div class="empty">左の「＋ 新しいルーム」からルームを作成してください。<br>初回は「⚙️ 共通設定」でトークンとデータベースを登録します。</div>`;
    return;
  }
  const list = getMsgs(r.id);
  if (!list.length) {
    box.innerHTML = `<div class="empty">メッセージを送ると、Notionに新しいページが作成されます。<br>1行目がタイトル、全文が本文になります。</div>`;
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = list.map(m => {
    const [first, ...rest] = (m.text || '').split('\n');
    const cached = fileCache.get(m.id) || [];
    const atts = (m.files || []).map((f, i) => {
      const file = cached[i];
      if (file && (file.type || '').startsWith('image/')) return `<img src="${fileUrl(file)}" alt="${esc(f.name)}">`;
      return `<span class="chip">📎 ${esc(f.name)}</span>`;
    }).join('');
    const time = new Date(m.ts);
    let status = '';
    if (m.status === 'sending') status = `<span>⏳ ${esc(m.progress || '送信中…')}</span>`;
    else if (m.status === 'ok') status = `<span class="ok">✓ 保存済み</span>${m.pageUrl ? `<a href="${esc(m.pageUrl)}" target="_blank" rel="noopener">Notionで開く ↗</a>` : ''}`;
    else if (m.status === 'error') {
      const canRetry = !(m.files?.length) || fileCache.has(m.id);
      status = `<span class="err">⚠ ${esc(m.error)}</span>` +
        (canRetry ? `<button class="linkbtn" data-retry="${m.id}">再送</button>` : '<span>（添付があるため再送不可）</span>') +
        `<button class="linkbtn" data-del="${m.id}">削除</button>`;
    }
    return `<div class="msg">
      ${m.text?.trim() ? `<div class="bubble"><span class="t1">${esc(first)}</span>${rest.length ? '\n' + esc(rest.join('\n')) : ''}</div>` : ''}
      ${atts ? `<div class="atts">${atts}</div>` : ''}
      <div class="meta"><span>${todayStr(time) === todayStr() ? '' : todayStr(time) + ' '}${pad(time.getHours())}:${pad(time.getMinutes())}</span>${status}</div>
    </div>`;
  }).join('');
  if (atBottom || list[list.length - 1].status === 'sending') box.scrollTop = box.scrollHeight;
}
function renderPending() {
  $('#pendingFiles').innerHTML = pending.map((f, i) => `
    <div class="pf">${(f.type || '').startsWith('image/') ? `<img src="${fileUrl(f)}" alt="">` : '📎'}
      <span>${esc(f.name)}</span><button type="button" data-rm="${i}" title="外す">×</button></div>`).join('');
}
function renderAll() { renderRooms(); renderHeader(); renderMessages(); }
function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px'; }

function selectRoom(id) {
  currentId = id; localStorage.setItem(LS.current, id);
  $('#app').classList.remove('side-open');
  renderAll();
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

/* ---------- 共通設定ダイアログ ---------- */
let draftDbs = [], draftDefault = '';
function renderDbRows() {
  $('#dbList').innerHTML = draftDbs.map(d => `
    <div class="row" data-id="${d.id}">
      <input type="radio" name="defaultDb" value="${d.id}" ${d.id === draftDefault ? 'checked' : ''} title="デフォルトにする">
      <input class="grow db-name" type="text" placeholder="表示名（例：メモ）" value="${esc(d.name)}">
      <input class="grow db-id" type="text" placeholder="データベースID または URL" value="${esc(d.dbId)}">
      <button type="button" class="btn small db-test">確認</button>
      <button type="button" class="rm" title="削除">×</button>
      <span class="st"></span>
    </div>`).join('') || '<div class="hint">まだ登録がありません。</div>';
}
function collectDbRows() {
  draftDbs = [...document.querySelectorAll('#dbList .row')].map(row => ({
    id: row.dataset.id,
    name: row.querySelector('.db-name').value.trim(),
    dbId: normalizeDbId(row.querySelector('.db-id').value) || row.querySelector('.db-id').value.trim(),
  }));
  const r = document.querySelector('#dbList input[name=defaultDb]:checked');
  draftDefault = r ? r.value : (draftDbs[0]?.id || '');
}
function openSettings() {
  $('#tokenInput').value = settings.token;
  $('#tokenInput').type = 'password'; $('#toggleToken').textContent = '表示';
  $('#proxyInput').value = settings.proxyUrl;
  draftDbs = settings.databases.map(d => ({ ...d }));
  draftDefault = settings.defaultDb;
  renderDbRows();
  $('#settingsDialog').showModal();
}

/* ---------- ルーム設定ダイアログ ---------- */
let editingRoomId = '';
function propRowHtml(p = {}) {
  const mode = p.mode || 'fixed';
  return `<div class="row prop-row">
    <input class="grow p-name" type="text" list="propNames" placeholder="プロパティ名" value="${esc(p.name)}">
    <select class="p-mode">
      <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>固定値</option>
      <option value="today" ${mode === 'today' ? 'selected' : ''}>今日の日付</option>
      <option value="now" ${mode === 'now' ? 'selected' : ''}>現在の日時</option>
    </select>
    <input class="grow p-value" type="text" placeholder="値" value="${esc(p.value)}" ${mode === 'fixed' ? '' : 'disabled'}>
    <button type="button" class="rm" title="削除">×</button>
  </div>`;
}
function openRoomSettings(id) {
  const r = getRoom(id); if (!r) return;
  editingRoomId = id;
  $('#roomNameInput').value = r.name || '';
  const def = settings.databases.find(d => d.id === settings.defaultDb) || settings.databases[0];
  $('#roomDbSelect').innerHTML =
    `<option value="">デフォルトを使用${def ? `（${esc(def.name || def.dbId)}）` : ''}</option>` +
    settings.databases.map(d => `<option value="${d.id}" ${d.id === r.dbRef ? 'selected' : ''}>${esc(d.name || d.dbId)}</option>`).join('');
  $('#propsEnabled').checked = !!r.propsEnabled;
  $('#propList').innerHTML = (r.props || []).map(propRowHtml).join('');
  $('#propNames').innerHTML = '';
  togglePropsArea();
  $('#roomDialog').showModal();
}
function togglePropsArea() { $('#propsArea').classList.toggle('disabled', !$('#propsEnabled').checked); }

/* ---------- イベント ---------- */
function bind() {
  $('#composer').addEventListener('submit', e => { e.preventDefault(); send(); });
  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#input').addEventListener('input', autoGrow);
  $('#input').addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addPending(files); }
  });
  $('#fileInput').addEventListener('change', e => { addPending([...e.target.files]); e.target.value = ''; });
  const comp = $('#composer');
  comp.addEventListener('dragover', e => { e.preventDefault(); comp.classList.add('drag'); });
  comp.addEventListener('dragleave', () => comp.classList.remove('drag'));
  comp.addEventListener('drop', e => { e.preventDefault(); comp.classList.remove('drag'); addPending([...e.dataTransfer.files]); });
  $('#pendingFiles').addEventListener('click', e => {
    const i = e.target.dataset.rm; if (i === undefined) return;
    pending.splice(Number(i), 1); renderPending();
  });

  $('#messages').addEventListener('click', e => {
    const r = e.target.dataset.retry, d = e.target.dataset.del;
    if (r) deliver(currentId, r);
    if (d) { save(LS.msgs(currentId), getMsgs(currentId).filter(m => m.id !== d)); fileCache.delete(d); renderMessages(); }
  });

  $('#roomList').addEventListener('click', e => { const li = e.target.closest('li'); if (li) selectRoom(li.dataset.id); });
  $('#addRoomBtn').addEventListener('click', () => {
    const r = { id: uid(), name: `ルーム ${rooms.length + 1}`, dbRef: '', propsEnabled: false, props: [] };
    rooms.push(r); save(LS.rooms, rooms); selectRoom(r.id); openRoomSettings(r.id);
  });
  $('#menuBtn').addEventListener('click', () => $('#app').classList.toggle('side-open'));
  $('#backdrop').addEventListener('click', () => $('#app').classList.remove('side-open'));

  // 共通設定
  $('#openSettingsBtn').addEventListener('click', openSettings);
  $('#toggleToken').addEventListener('click', () => {
    const t = $('#tokenInput'); t.type = t.type === 'password' ? 'text' : 'password';
    $('#toggleToken').textContent = t.type === 'password' ? '表示' : '隠す';
  });
  $('#addDbBtn').addEventListener('click', () => {
    collectDbRows();
    const d = { id: uid(), name: '', dbId: '' };
    draftDbs.push(d); if (!draftDefault) draftDefault = d.id;
    renderDbRows();
  });
  $('#dbList').addEventListener('click', async e => {
    const row = e.target.closest('.row'); if (!row) return;
    if (e.target.classList.contains('rm')) { collectDbRows(); draftDbs = draftDbs.filter(d => d.id !== row.dataset.id); if (draftDefault === row.dataset.id) draftDefault = draftDbs[0]?.id || ''; renderDbRows(); }
    if (e.target.classList.contains('db-test')) {
      const st = row.querySelector('.st');
      const id = normalizeDbId(row.querySelector('.db-id').value);
      if (!id) { st.textContent = '⚠ IDの形式が正しくありません'; return; }
      row.querySelector('.db-id').value = id;
      const prev = { token: settings.token, proxyUrl: settings.proxyUrl };
      settings.token = $('#tokenInput').value.trim(); settings.proxyUrl = $('#proxyInput').value.trim();
      st.textContent = '確認中…';
      try {
        const s = await getSchema(id, true);
        st.textContent = `✓ 接続OK：「${s.title}」 プロパティ ${Object.keys(s.properties).length}件`;
        const nm = row.querySelector('.db-name'); if (!nm.value.trim()) nm.value = s.title;
      } catch (err) { st.textContent = '⚠ ' + err.message; }
      finally { Object.assign(settings, prev); }
    }
  });
  $('#saveSettingsBtn').addEventListener('click', e => {
    collectDbRows();
    const bad = draftDbs.find(d => d.dbId && !normalizeDbId(d.dbId));
    if (bad) { e.preventDefault(); toast(`IDの形式が正しくありません：${bad.dbId}`); return; }
    settings = {
      token: $('#tokenInput').value.trim(),
      proxyUrl: $('#proxyInput').value.trim(),
      databases: draftDbs.filter(d => d.dbId),
      defaultDb: draftDefault,
    };
    if (!settings.databases.some(d => d.id === settings.defaultDb)) settings.defaultDb = settings.databases[0]?.id || '';
    save(LS.settings, settings); schemaCache.clear();
    renderAll(); toast('共通設定を保存しました');
  });
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ settings, rooms }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `notion-chat-memo-${todayStr()}.json`; a.click();
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.settings || !Array.isArray(data.rooms)) throw new Error();
      if (!confirm('現在の設定とルームを置き換えます。よろしいですか？')) return;
      settings = Object.assign({ token: '', proxyUrl: '', databases: [], defaultDb: '' }, data.settings);
      rooms = data.rooms; save(LS.settings, settings); save(LS.rooms, rooms);
      $('#settingsDialog').close(); currentId = rooms[0]?.id || ''; selectRoom(currentId); toast('読み込みました');
    } catch { toast('読み込めないファイルです'); }
  });

  // ルーム設定
  $('#roomSettingsBtn').addEventListener('click', () => openRoomSettings(currentId));
  $('#propsEnabled').addEventListener('change', togglePropsArea);
  $('#addPropBtn').addEventListener('click', () => $('#propList').insertAdjacentHTML('beforeend', propRowHtml()));
  $('#propList').addEventListener('click', e => { if (e.target.classList.contains('rm')) e.target.closest('.row').remove(); });
  $('#propList').addEventListener('change', e => {
    if (!e.target.classList.contains('p-mode')) return;
    const v = e.target.closest('.row').querySelector('.p-value');
    v.disabled = e.target.value !== 'fixed';
  });
  $('#loadPropsBtn').addEventListener('click', async () => {
    const ref = $('#roomDbSelect').value;
    const db = resolveDb({ dbRef: ref });
    if (!db) { toast('データベースが未設定です'); return; }
    try {
      const s = await getSchema(db.dbId, true);
      const entries = Object.entries(s.properties).filter(([, p]) => p.type !== 'title');
      $('#propNames').innerHTML = entries.map(([n, p]) => `<option value="${esc(n)}">${esc(p.type)}</option>`).join('');
      toast(`「${s.title}」のプロパティ ${entries.length}件を候補に追加しました`);
    } catch (err) { toast(err.message); }
  });
  $('#saveRoomBtn').addEventListener('click', () => {
    const r = getRoom(editingRoomId); if (!r) return;
    r.name = $('#roomNameInput').value.trim() || '無題のルーム';
    r.dbRef = $('#roomDbSelect').value;
    r.propsEnabled = $('#propsEnabled').checked;
    r.props = [...document.querySelectorAll('#propList .prop-row')].map(row => ({
      name: row.querySelector('.p-name').value.trim(),
      mode: row.querySelector('.p-mode').value,
      value: row.querySelector('.p-value').value,
    })).filter(p => p.name);
    save(LS.rooms, rooms); renderAll(); toast('ルーム設定を保存しました');
  });
  $('#deleteRoomBtn').addEventListener('click', () => {
    const r = getRoom(editingRoomId); if (!r) return;
    if (!confirm(`ルーム「${r.name}」を削除しますか？（Notionのページは削除されません）`)) return;
    rooms = rooms.filter(x => x.id !== r.id); save(LS.rooms, rooms); localStorage.removeItem(LS.msgs(r.id));
    $('#roomDialog').close(); selectRoom(rooms[0]?.id || '');
  });
  $('#clearHistoryBtn').addEventListener('click', () => {
    if (!confirm('このルームのチャット履歴（ブラウザ上の表示）を消去しますか？\nNotionのページは削除されません。')) return;
    localStorage.removeItem(LS.msgs(editingRoomId)); renderMessages(); toast('履歴を消去しました');
  });
}
function addPending(files) { if (!files.length) return; pending.push(...files); renderPending(); }

/* ---------- 起動 ---------- */
(function init() {
  // 前回送信中のまま閉じたメッセージはエラー扱いに
  for (const r of rooms) {
    const list = getMsgs(r.id); let changed = false;
    for (const m of list) if (m.status === 'sending') { m.status = 'error'; m.error = '送信が中断されました'; delete m.progress; changed = true; }
    if (changed) save(LS.msgs(r.id), list);
  }
  if (!getRoom(currentId)) currentId = rooms[0]?.id || '';
  bind(); renderAll();
  $('#messages').scrollTop = $('#messages').scrollHeight;
  if (!settings.token) setTimeout(openSettings, 300);
})();
