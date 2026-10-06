// Model: ubah di sini bila nama model di akunmu berbeda (harus sama dengan GEMINI_MODELS di server)
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview'];
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_BIN = 15 * 1024 * 1024;      // batas satu file PDF atau gambar (kunci sendiri)
const MAX_TOTAL = 14 * 1024 * 1024;    // batas total PDF dan gambar per analisis (kunci sendiri)
const MAX_PROXY = 4 * 1024 * 1024;     // batas total permintaan lewat kunci server (Vercel membatasi sekitar 4,5 MB)
let serverReady = false;

const CATS = [
  { id:'modul',   name:'Modul UT',  hint:'Modul atau BMP per kegiatan belajar (PDF, DOCX)', ac:'var(--c-modul)' },
  { id:'materi',  name:'Materi',    hint:'Slide dan handout dosen (PPTX, PDF)',               ac:'var(--c-materi)' },
  { id:'diskusi', name:'Diskusi',   hint:'Soal dan jawaban forum diskusi',                    ac:'var(--c-diskusi)' },
  { id:'tugas',   name:'Tugas',     hint:'Soal tugas tutorial dan tugas mandiri',             ac:'var(--c-tugas)' }
];

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const wc = t => (String(t).trim().match(/\S+/g) || []).length;
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Penyimpanan browser penuh', 'err'); } }

// STATE
let libs = lsGet('ucs_libs', []);
let activeId = null;
let files = [];
let curCat = 'modul';
let modelIdx = lsGet('ucs_model', 0) || 0;
let answered = {};
const getLib = () => libs.find(l => l.id === activeId);
const saveLibs = () => lsSet('ucs_libs', libs);

// TOAST, MODAL
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
}
const openModal = id => $(id).classList.add('show');
const closeModal = id => $(id).classList.remove('show');
document.querySelectorAll('.mbg').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => m.classList.remove('show')));
});
let confCb = null;
function confirmDlg(text, cb) { $('confText').textContent = text; confCb = cb; openModal('mConf'); }
$('confOk').addEventListener('click', () => { closeModal('mConf'); if (confCb) confCb(); });

// THEME
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
(function () {
  let t = null; try { t = localStorage.getItem('ucs_theme'); } catch (e) {}
  if (!t) t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  applyTheme(t);
})();
$('themeBtn').addEventListener('click', () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(t); try { localStorage.setItem('ucs_theme', t); } catch (e) {}
});

// API KEY
const getKey = () => { try { return localStorage.getItem('ucs_key') || ''; } catch (e) { return ''; } };
const usingOwnKey = () => !!getKey();
function refreshKeyDot() {
  $('keyDot').className = 'dot' + (getKey() || serverReady ? ' on' : '');
  $('keyStatus').textContent = getKey()
    ? 'Memakai API key milikmu yang tersimpan di browser ini.'
    : serverReady
      ? 'Kunci server aktif, kamu bisa langsung memakai AI tanpa mengisi kunci sendiri. Isi kunci sendiri bila ingin batas pemakaian terpisah dan file yang lebih besar.'
      : 'Belum ada kunci yang aktif. Ikuti langkah di bawah untuk memasang API key.';
  renderPlans();
}
async function checkServer() {
  try {
    const r = await fetch('/api/gemini', { cache: 'no-store' });
    const d = await r.json();
    serverReady = !!(r.ok && d && d.ready);
  } catch (e) { serverReady = false; }
  refreshKeyDot();
}
$('keyBtn').addEventListener('click', () => { $('keyIn').value = getKey(); openModal('mKey'); });
$('keyOk').addEventListener('click', () => {
  const v = $('keyIn').value.trim();
  try { if (v) localStorage.setItem('ucs_key', v); else localStorage.removeItem('ucs_key'); } catch (e) {}
  refreshKeyDot(); closeModal('mKey'); toast(v ? 'API key disimpan' : 'API key dihapus');
});
$('keyDel').addEventListener('click', () => {
  try { localStorage.removeItem('ucs_key'); } catch (e) {}
  $('keyIn').value = ''; refreshKeyDot(); closeModal('mKey'); toast('API key dihapus');
});

// INDEXEDDB (file disimpan di browser)
let _db;
function db() {
  return _db || (_db = new Promise((res, rej) => {
    const r = indexedDB.open('ucs_files', 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore('files', { keyPath: 'id' }); s.createIndex('lib', 'libId'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function tx(mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction('files', mode);
    const out = fn(t.objectStore('files'));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const filesOf = libId => tx('readonly', s => s.index('lib').getAll(libId));
const putFile = f => tx('readwrite', s => s.put(f));
const delFile = id => tx('readwrite', s => s.delete(id));
const delFilesOfLib = libId => tx('readwrite', s => {
  const r = s.index('lib').getAllKeys(libId);
  r.onsuccess = () => r.result.forEach(k => s.delete(k));
  return r;
});

// LIBRARY
function renderSide() {
  const el = $('libList');
  if (!libs.length) { el.innerHTML = '<div class="side-empty">Belum ada library. Tekan tombol tambah di atas.</div>'; return; }
  el.innerHTML = libs.map(l => `
    <div class="lib ${l.id === activeId ? 'on' : ''}" data-id="${l.id}">
      <div class="lib-ic">${esc((l.code || l.name).slice(0, 2).toUpperCase())}</div>
      <div class="lib-t"><b>${esc(l.name)}</b><span>${esc(l.code ? l.code + ', ' : '')}${l.n || 0} file</span></div>
      <button class="lib-del" data-del="${l.id}" aria-label="Hapus library"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
    </div>`).join('');
}
$('libList').addEventListener('click', e => {
  const d = e.target.closest('[data-del]');
  if (d) {
    e.stopPropagation();
    const id = d.getAttribute('data-del');
    confirmDlg('Hapus library ini beserta semua file, rangkuman, dan soalnya?', async () => {
      try { await delFilesOfLib(id); } catch (err) {}
      libs = libs.filter(l => l.id !== id); saveLibs();
      if (activeId === id) { activeId = null; files = []; $('libView').hidden = true; $('welcome').hidden = false; }
      renderSide();
    });
    return;
  }
  const it = e.target.closest('.lib');
  if (it) { openLib(it.getAttribute('data-id')); closeDrawer(); }
});
function showAddLib() {
  $('libName').value = ''; $('libCode').value = '';
  openModal('mLib'); setTimeout(() => $('libName').focus(), 60); closeDrawer();
}
$('addLibBtn').addEventListener('click', showAddLib);
$('welcomeAdd').addEventListener('click', showAddLib);
function createLib() {
  const name = $('libName').value.trim();
  if (!name) { $('libName').focus(); return; }
  const lib = { id: uid(), name, code: $('libCode').value.trim(), target: '', rangkuman: '', ranInfo: null, soal: [], n: 0, createdAt: Date.now() };
  libs.push(lib); saveLibs(); closeModal('mLib'); renderSide(); openLib(lib.id);
}
$('libOk').addEventListener('click', createLib);
['libName', 'libCode'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') createLib(); }));

async function openLib(id) {
  activeId = id;
  const lib = getLib();
  try { files = await filesOf(id); } catch (e) { files = []; toast('File tidak bisa dibaca dari browser ini', 'err'); }
  files.sort((a, b) => a.addedAt - b.addedAt);
  answered = {};
  $('welcome').hidden = true; $('libView').hidden = false;
  $('lvTitle').textContent = lib.name;
  $('lvMeta').textContent = (lib.code ? lib.code + ', ' : '') + 'dibuat ' + new Date(lib.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  $('targetIn').value = lib.target || '';
  renderSide(); renderAll(); switchTab('susunan');
}
function renderAll() { renderStrip(); renderCats(); renderPlans(); renderRangkuman(); renderSoal(); }

// TABS
function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + name));
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });

// DRAWER MOBILE
function closeDrawer() { $('side').classList.remove('open'); $('scrim').classList.remove('show'); }
$('menuBtn').addEventListener('click', () => { $('side').classList.toggle('open'); $('scrim').classList.toggle('show'); });
$('scrim').addEventListener('click', closeDrawer);

// SUSUNAN MATERI
const catFiles = id => files.filter(f => f.cat === id);
function renderStrip() {
  const lib = getLib();
  const items = [{ n: 'Target belajar', ok: !!(lib.target || '').trim(), t: (lib.target || '').trim() ? 'Terisi' : 'Belum diisi' }]
    .concat(CATS.map(c => { const k = catFiles(c.id).length; return { n: c.name, ok: k > 0, t: k ? k + ' file' : 'Belum ada' }; }));
  $('strip').innerHTML = items.map(i => `<div class="st ${i.ok ? 'ok' : ''}"><i></i><b>${esc(i.n)}</b><span>${esc(i.t)}</span></div>`).join('');
}
function fileRow(f) {
  const info = f.kind === 'text' ? wc(f.text).toLocaleString('id-ID') + ' kata terbaca' : (f.kind === 'pdf' ? 'Dibaca langsung oleh AI' : 'Gambar dibaca langsung oleh AI');
  return `<div class="frow">
    <span class="ext">${esc((f.ext || '').toUpperCase())}</span>
    <div class="fn"><b title="${esc(f.name)}">${esc(f.name)}</b><span>${fmtSize(f.size)}, ${info}</span></div>
    <button class="fx" data-rm="${f.id}" aria-label="Hapus file"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>`;
}
function renderCats() {
  $('cats').innerHTML = CATS.map(c => {
    const fs = catFiles(c.id);
    return `<div class="card cat" data-cat="${c.id}" style="--ac:${c.ac}">
      <div class="card-h">
        <div><h3>${c.name} <span class="cnt">${fs.length} file</span></h3><p>${c.hint}</p></div>
        <div class="acts">
          <button class="btn sm" data-paste="${c.id}">Tempel teks</button>
          <button class="btn sm pri" data-add="${c.id}">Tambah file</button>
        </div>
      </div>
      <div class="card-b">${fs.length ? fs.map(fileRow).join('') : '<div class="empty">Belum ada file. Tekan Tambah file atau seret file ke sini.</div>'}</div>
    </div>`;
  }).join('');
}
$('cats').addEventListener('click', e => {
  const a = e.target.closest('[data-add]'), p = e.target.closest('[data-paste]'), r = e.target.closest('[data-rm]');
  if (a) { curCat = a.dataset.add; $('fileIn').value = ''; $('fileIn').click(); }
  if (p) {
    curCat = p.dataset.paste;
    $('pasteTitle').textContent = 'Tempel teks ke ' + CATS.find(c => c.id === curCat).name;
    $('pasteName').value = ''; $('pasteText').value = ''; openModal('mPaste');
  }
  if (r) removeFile(r.dataset.rm);
});
['dragover', 'dragenter'].forEach(ev => $('cats').addEventListener(ev, e => { const c = e.target.closest('.cat'); if (c) { e.preventDefault(); c.classList.add('drag'); } }));
['dragleave', 'drop'].forEach(ev => $('cats').addEventListener(ev, e => { const c = e.target.closest('.cat'); if (c) c.classList.remove('drag'); }));
$('cats').addEventListener('drop', e => {
  const c = e.target.closest('.cat'); if (!c) return;
  e.preventDefault(); addFiles(c.dataset.cat, [...e.dataTransfer.files]);
});
$('fileIn').addEventListener('change', e => addFiles(curCat, [...e.target.files]));
$('pasteOk').addEventListener('click', async () => {
  const text = $('pasteText').value.trim();
  if (!text) { $('pasteText').focus(); return; }
  const n = catFiles(curCat).filter(f => f.ext === 'teks').length + 1;
  const name = $('pasteName').value.trim() || ('Teks tempel ' + n);
  const rec = { id: uid(), libId: activeId, cat: curCat, name, size: new Blob([text]).size, addedAt: Date.now(), kind: 'text', ext: 'teks', text };
  try { await putFile(rec); files.push(rec); bumpCount(); closeModal('mPaste'); renderAll(); toast('Teks ditambahkan'); }
  catch (e) { toast('Gagal menyimpan teks di browser', 'err'); }
});
$('targetIn').addEventListener('input', () => {
  const lib = getLib(); lib.target = $('targetIn').value; saveLibs(); renderStrip(); renderPlans(); renderStale();
});

function bumpCount() { const lib = getLib(); lib.n = files.length; saveLibs(); renderSide(); }
async function removeFile(id) {
  try { await delFile(id); } catch (e) {}
  files = files.filter(f => f.id !== id); bumpCount(); renderAll();
}

// Baca isi DOCX dan PPTX dengan JSZip
async function extractOffice(file, ext) {
  if (!window.JSZip) throw new Error('Pembaca file belum termuat, cek koneksi internet lalu muat ulang');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parse = x => new DOMParser().parseFromString(x, 'application/xml');
  const paras = (doc, p, t) => [...doc.getElementsByTagName(p)]
    .map(n => [...n.getElementsByTagName(t)].map(x => x.textContent).join(''))
    .filter(s => s.trim());
  const num = n => +n.match(/(\d+)\.xml$/)[1];
  if (ext === 'docx') {
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('Struktur DOCX tidak dikenali');
    return paras(parse(await f.async('string')), 'w:p', 'w:t').join('\n');
  }
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error('Struktur PPTX tidak dikenali');
  const out = [];
  for (const n of slides) {
    const i = num(n);
    const body = paras(parse(await zip.file(n).async('string')), 'a:p', 'a:t').join('\n');
    let notes = '';
    const rel = zip.file(`ppt/slides/_rels/slide${i}.xml.rels`);
    if (rel) {
      const m = (await rel.async('string')).match(/notesSlides\/(notesSlide\d+\.xml)/);
      if (m && zip.file('ppt/notesSlides/' + m[1])) {
        notes = paras(parse(await zip.file('ppt/notesSlides/' + m[1]).async('string')), 'a:p', 'a:t')
          .filter(s => !/^\d+$/.test(s.trim())).join('\n');
      }
    }
    out.push('Slide ' + i + '\n' + body + (notes ? '\nCatatan pembicara: ' + notes : ''));
  }
  return out.join('\n\n');
}

async function addFiles(cat, list) {
  if (!getLib() || !list.length) return;
  for (const file of list) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      const rec = { id: uid(), libId: activeId, cat, name: file.name, size: file.size, addedAt: Date.now() };
      if (['txt', 'md', 'csv'].includes(ext)) {
        rec.kind = 'text'; rec.ext = 'txt'; rec.text = await file.text();
      } else if (ext === 'docx' || ext === 'pptx') {
        rec.kind = 'text'; rec.ext = ext; rec.text = await extractOffice(file, ext);
      } else if (ext === 'pdf') {
        if (file.size > MAX_BIN) throw new Error('Ukuran PDF melebihi 15 MB, pecah per bab dulu');
        rec.kind = 'pdf'; rec.ext = 'pdf'; rec.mime = 'application/pdf'; rec.blob = file;
      } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        if (file.size > MAX_BIN) throw new Error('Ukuran gambar melebihi 15 MB');
        rec.kind = 'image'; rec.ext = ext === 'jpeg' ? 'jpg' : ext;
        rec.mime = file.type || ('image/' + (rec.ext === 'jpg' ? 'jpeg' : rec.ext)); rec.blob = file;
      } else if (ext === 'doc' || ext === 'ppt') {
        throw new Error('Format .' + ext + ' lama belum didukung, simpan ulang sebagai .' + ext + 'x');
      } else {
        throw new Error('Format .' + ext + ' belum didukung');
      }
      if (rec.kind === 'text' && !rec.text.trim()) throw new Error('Tidak ada teks yang terbaca di file ini');
      await putFile(rec); files.push(rec);
    } catch (e) { toast(file.name + ': ' + (e && e.message ? e.message : 'gagal dibaca'), 'err'); }
  }
  bumpCount(); renderAll();
}

// RENCANA ANALISIS (susunan sebelum dianalisis)
function binSize() { return files.filter(f => f.blob).reduce((a, f) => a + f.size, 0); }
function estBytes() { return files.reduce((a, f) => a + (f.blob ? f.size * 1.37 : (f.text || '').length * 1.1), 0) + ((getLib().target || '').length); }
function planHTML() {
  const lib = getLib();
  const rows = [];
  const t = (lib.target || '').trim();
  rows.push({ n: 'Target belajar', ok: !!t, v: t ? 'Terisi, ' + wc(t) + ' kata' : 'Belum diisi' });
  CATS.forEach(c => {
    const fs = catFiles(c.id);
    rows.push({ n: c.name, ok: fs.length > 0, v: fs.length ? fs.length + ' file: ' + fs.map(f => f.name).join(', ') : 'Belum ada' });
  });
  let h = rows.map(r => `<div class="prow ${r.ok ? '' : 'no'}"><b>${esc(r.n)}</b><span>${esc(r.v)}</span></div>`).join('');
  const hasD = catFiles('diskusi').length > 0, hasT = catFiles('tugas').length > 0;
  if (!files.length && !t) h += '<div class="warn" style="margin-top:10px">Belum ada materi. Isi target belajar atau unggah file di tab Susunan Materi dulu.</div>';
  else if (!hasD && !hasT) h += '<div class="warn" style="margin-top:10px">Belum ada diskusi dan tugas, jadi hasil hanya bersumber dari modul dan materi.</div>';
  else if (!hasD || !hasT) h += `<div class="warn" style="margin-top:10px">Belum ada ${!hasD ? 'diskusi' : 'tugas'}. Tambahkan bila ada supaya topik prioritas lebih akurat.</div>`;
  if (usingOwnKey() && binSize() > MAX_TOTAL) h += '<div class="warn" style="margin-top:10px">Total PDF dan gambar lebih dari 14 MB. Hapus sebagian atau pecah per bab, kalau tidak AI tidak bisa membacanya sekaligus.</div>';
  else if (!usingOwnKey() && estBytes() > MAX_PROXY) h += '<div class="warn" style="margin-top:10px">Total materi lebih dari sekitar 4 MB, batas kunci server. Kurangi file, atau pasang API key sendiri lewat ikon kunci agar batasnya lebih besar.</div>';
  return h;
}
function renderPlans() { if (!getLib()) return; const h = planHTML(); $('plan1').innerHTML = h; $('plan2').innerHTML = h; }

// PEMANGGILAN GEMINI
const toB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(new Error('Gagal membaca file'));
  r.readAsDataURL(blob);
});
async function buildParts(instruction) {
  const lib = getLib();
  if (usingOwnKey() && binSize() > MAX_TOTAL) throw new Error('Total PDF dan gambar lebih dari 14 MB, kurangi dulu');
  const parts = [{ text: instruction + '\n\nMata kuliah: ' + lib.name + (lib.code ? ' (' + lib.code + ')' : '') }];
  if ((lib.target || '').trim()) parts.push({ text: '[TARGET BELAJAR]\n' + lib.target.trim() });
  for (const c of CATS) {
    for (const f of catFiles(c.id)) {
      const label = '[' + c.name.toUpperCase() + ': ' + f.name + ']';
      if (f.kind === 'text') parts.push({ text: label + '\n' + f.text.slice(0, 300000) });
      else { parts.push({ text: label }); parts.push({ inline_data: { mime_type: f.mime, data: await toB64(f.blob) } }); }
    }
  }
  return parts;
}
async function callGemini(parts, json) {
  const own = getKey();
  if (!own && !serverReady) { openModal('mKey'); throw new Error('Pasang API key dulu, panduannya ada di jendela yang terbuka'); }
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: json ? 0.5 : 0.4, maxOutputTokens: 8192 } };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  if (!own && JSON.stringify(body).length > MAX_PROXY) {
    throw new Error('Materi terlalu besar untuk kunci server (maksimal sekitar 4 MB). Kurangi file, atau pasang API key sendiri lewat ikon kunci.');
  }
  let lastErr = '';
  for (let k = 0; k < MODELS.length; k++) {
    const idx = (modelIdx + k) % MODELS.length;
    const model = MODELS[idx];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
      res = own
        ? await fetch(API + '/' + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': own }, body: JSON.stringify(body), signal: ctrl.signal })
        : await fetch('/api/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, body }), signal: ctrl.signal });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError'
        ? 'Permintaan terlalu lama, coba lagi dengan materi yang lebih sedikit'
        : 'Tidak bisa terhubung ke layanan AI. Cek internet kamu.');
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (idx !== modelIdx) { modelIdx = idx; lsSet('ucs_model', idx); }
      const txt = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('');
      if (!txt) throw new Error((data.promptFeedback && data.promptFeedback.blockReason) ? 'Permintaan diblokir oleh Gemini' : 'Respons kosong, coba lagi');
      return txt;
    }
    const msg = (data.error && data.error.message) || ('Error ' + res.status);
    if (res.status === 404) { lastErr = msg; continue; }
    if (res.status === 413) throw new Error('Materi terlalu besar untuk dikirim. Kurangi file atau pasang API key sendiri lewat ikon kunci.');
    if (res.status === 429) throw new Error('Batas pemakaian gratis tercapai. Tunggu sebentar lalu coba lagi.');
    if (res.status === 503 && !own) throw new Error('Kunci server belum diatur. Pasang API key sendiri lewat ikon kunci.');
    if (res.status === 504 || res.status === 408) throw new Error('Permintaan terlalu lama, coba lagi dengan materi yang lebih sedikit');
    if ((res.status === 400 && /api key/i.test(msg)) || res.status === 401) {
      throw new Error(own
        ? 'API key ditolak oleh Google. Cek kuncinya, atau buat kunci klasik lewat Google Cloud Console (langkahnya ada di panduan ikon kunci).'
        : 'API key server ditolak oleh Google. Hubungi admin.');
    }
    if (res.status === 403) throw new Error(own ? 'API key ditolak atau belum punya akses ke model ini' : msg);
    throw new Error(msg);
  }
  throw new Error('Model Gemini 3.1 Flash Lite tidak ditemukan. Cek daftar MODELS di js/app.js dan GEMINI_MODELS di pengaturan server. ' + lastErr);
}
const cleanText = t => t.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '').replace(/^\s*[*]\s+/gm, '- ').trim();
const signature = () => files.map(f => f.id).sort().join(',') + '|' + ((getLib().target || '').trim().length);
const hasInput = () => files.length > 0 || !!(getLib().target || '').trim();

// RANGKUMAN
function renderRangkuman() {
  const lib = getLib();
  $('ranCard').hidden = !lib.rangkuman;
  if (lib.rangkuman) {
    $('ranText').textContent = lib.rangkuman;
    $('ranMeta').textContent = lib.ranInfo ? 'Dibuat ' + new Date(lib.ranInfo.at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' dari ' + lib.ranInfo.n + ' file' : '';
  }
  renderStale();
}
function renderStale() {
  const lib = getLib(); if (!lib) return;
  $('ranStale').hidden = !(lib.rangkuman && lib.ranInfo && lib.ranInfo.sig !== signature());
}
async function genRangkuman() {
  if (!hasInput()) { toast('Isi target belajar atau unggah materi dulu', 'err'); switchTab('susunan'); return; }
  const lib = getLib();
  $('ranBtn').disabled = true; $('ranLoad').hidden = false;
  const instruction = `Kamu asisten belajar untuk mahasiswa Universitas Terbuka. Di bawah ini ada materi yang diunggah mahasiswa dengan label sumber: TARGET BELAJAR, MODUL UT, MATERI, DISKUSI, dan TUGAS. Analisis semuanya sebagai satu kesatuan, lalu tulis hasilnya dengan susunan berikut.
1. Gambaran umum mata kuliah berdasarkan materi yang ada (2 sampai 3 kalimat)
2. Peta topik: daftar topik utama, tiap topik diberi keterangan muncul di sumber mana (Modul, Materi, Diskusi, Tugas)
3. Rangkuman per topik: konsep inti, definisi, rumus atau langkah penting
4. Topik prioritas: topik yang muncul di diskusi atau tugas atau sesuai target belajar, karena paling mungkin diujikan
5. Istilah penting beserta definisinya
6. Bagian yang belum tercakup: target belajar yang belum ada materinya (tulis "tidak ada" bila semua tercakup)
Aturan: gunakan teks biasa tanpa tanda bintang, tanpa tanda pagar, tanpa tabel. Penomoran memakai 1, 2, 3 lalu a, b, c. Bahasa Indonesia. Hanya gunakan isi materi, jangan mengarang di luar itu.`;
  try {
    const out = cleanText(await callGemini(await buildParts(instruction), false));
    lib.rangkuman = out; lib.ranInfo = { at: Date.now(), n: files.length, sig: signature() };
    saveLibs(); renderRangkuman(); toast('Analisis selesai');
  } catch (e) { toast(e.message, 'err'); }
  $('ranBtn').disabled = false; $('ranLoad').hidden = true;
}
$('ranBtn').addEventListener('click', () => {
  if (getLib().rangkuman) confirmDlg('Rangkuman yang tersimpan akan diganti dengan hasil analisis baru. Salin dulu kalau masih dibutuhkan. Lanjutkan?', genRangkuman);
  else genRangkuman();
});
$('ranCopy').addEventListener('click', () => {
  const t = getLib().rangkuman || '';
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Disalin'), () => toast('Salin manual dengan menahan teks', 'err'));
});

// SOAL
function parseJSON(raw) {
  let t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
async function genSoal() {
  if (!hasInput()) { toast('Isi target belajar atau unggah materi dulu', 'err'); switchTab('susunan'); return; }
  const lib = getLib();
  const jml = Math.min(20, Math.max(1, parseInt($('sJml').value) || 5));
  const tipe = $('sTipe').value, level = $('sLevel').value, fokus = $('sFokus').value;
  const tipeL = { pilgan: 'semuanya pilihan ganda dengan 4 opsi', essay: 'semuanya essay', mix: 'campuran pilihan ganda dan essay' }[tipe];
  const levelL = { mudah: 'mudah (mengingat dan memahami konsep dasar)', sedang: 'sedang (penerapan dan analisis)', sulit: 'sulit (evaluasi dan sintesis mendalam)' }[level];
  const fokusL = fokus === 'tugas' ? 'Utamakan topik yang muncul di DISKUSI dan TUGAS, karena paling mungkin diujikan.' : 'Sebarkan soal secara merata dari semua sumber yang ada.';
  $('soalBtn').disabled = true; $('soalLoad').hidden = false;
  const instruction = `Kamu dosen Universitas Terbuka yang menyusun soal latihan ujian. Buat ${jml} soal, ${tipeL}, tingkat kesulitan ${levelL}, berdasarkan gabungan semua materi di bawah (label sumber: TARGET BELAJAR, MODUL UT, MATERI, DISKUSI, TUGAS). ${fokusL}
Soal harus bisa dijawab dari isi materi, jelas, dan tidak ambigu. Opsi pengecoh harus masuk akal.
Kembalikan HANYA JSON array tanpa teks lain, dengan bentuk:
[{"tipe":"pilgan","pertanyaan":"...","opsi":["...","...","...","..."],"jawaban":"A","pembahasan":"...","sumber":"Modul"},
 {"tipe":"essay","pertanyaan":"...","jawaban":"poin kunci jawaban","sumber":"Tugas"}]
Untuk pilihan ganda, "opsi" berisi 4 teks tanpa huruf di depannya dan "jawaban" berisi satu huruf A, B, C, atau D. Untuk essay, "jawaban" berisi poin kunci yang harus ada. Isi "sumber" dengan salah satu: Target, Modul, Materi, Diskusi, Tugas, atau Gabungan. Jangan memakai format markdown di dalam teks.`;
  try {
    const arr = parseJSON(await callGemini(await buildParts(instruction), true));
    if (!Array.isArray(arr) || !arr.length) throw new Error('Format soal tidak sesuai');
    lib.soal = arr; saveLibs(); answered = {}; renderSoal(); toast('Soal siap');
  } catch (e) { toast(e instanceof SyntaxError ? 'Soal gagal dibaca, coba buat ulang' : e.message, 'err'); }
  $('soalBtn').disabled = false; $('soalLoad').hidden = true;
}
$('soalBtn').addEventListener('click', () => {
  const l = getLib();
  if (l.soal && l.soal.length) confirmDlg('Soal yang tersimpan akan diganti dengan soal baru. Unduh atau salin dulu kalau masih dibutuhkan. Lanjutkan?', genSoal);
  else genSoal();
});
const SRC_AC = { Target:'var(--sky)', Modul:'var(--c-modul)', Materi:'var(--c-materi)', Diskusi:'var(--c-diskusi)', Tugas:'var(--c-tugas)', Gabungan:'var(--mute)' };
function renderSoal() {
  const lib = getLib(); const list = (lib && lib.soal) || [];
  $('score').hidden = !list.length;
  $('soalTools').hidden = !list.length;
  if (!list.length) $('ansCard').hidden = true;
  $('ansText').textContent = list.length ? buildKey(list) : '';
  $('soalList').innerHTML = list.map((s, i) => {
    const src = SRC_AC[s.sumber] ? s.sumber : 'Gabungan';
    const head = `<div class="q-h"><span class="q-n">Soal ${i + 1}</span><span class="q-t">${s.tipe === 'essay' ? 'Essay' : 'Pilihan ganda'}</span><span class="q-s" style="--ac:${SRC_AC[src]}">Sumber: ${esc(src)}</span></div>`;
    if (s.tipe === 'essay') {
      return `<div class="card">${head}<div class="card-b"><div class="q-q">${esc(s.pertanyaan)}</div>
        <button class="btn sm" data-key="${i}">Lihat kunci jawaban</button>
        <div class="expl" id="key${i}"><b>Poin kunci:</b>\n${esc(s.jawaban)}</div></div></div>`;
    }
    const opts = (s.opsi || []).map((o, oi) =>
      `<button class="opt" data-q="${i}" data-o="${oi}"><span class="l">${String.fromCharCode(65 + oi)}.</span><span>${esc(String(o).replace(/^[A-Da-d][.)]\s*/, ''))}</span></button>`).join('');
    return `<div class="card">${head}<div class="card-b"><div class="q-q">${esc(s.pertanyaan)}</div>
      <div class="opts" id="opts${i}">${opts}</div>
      <div class="expl" id="exp${i}"><b>Pembahasan:</b>\n${esc(s.pembahasan || 'Tidak ada pembahasan.')}</div></div></div>`;
  }).join('');
  list.forEach((s, i) => { if (answered[i] != null) paintAnswer(i); });
  updateScore();
}
const optText = o => String(o).replace(/^[A-Da-d][.)]\s*/, '');
function buildKey(list) {
  return list.map((s, i) => {
    if (s.tipe === 'essay') return (i + 1) + '. Essay\nPoin kunci: ' + (s.jawaban || '');
    const ci = correctIdx(s), o = (s.opsi || [])[ci];
    return (i + 1) + '. Jawaban ' + String.fromCharCode(65 + ci) + (o ? '. ' + optText(o) : '') + '\nPembahasan: ' + (s.pembahasan || 'Tidak ada pembahasan.');
  }).join('\n\n');
}
function buildSoalText(lib) {
  const q = lib.soal.map((s, i) => {
    let t = (i + 1) + '. ' + s.pertanyaan;
    if (s.tipe !== 'essay') t += '\n' + (s.opsi || []).map((o, oi) => '   ' + String.fromCharCode(65 + oi) + '. ' + optText(o)).join('\n');
    return t;
  }).join('\n\n');
  return lib.name + (lib.code ? ' (' + lib.code + ')' : '') + '\nLatihan soal\n\nSOAL\n\n' + q + '\n\nKUNCI JAWABAN\n\n' + buildKey(lib.soal) + '\n';
}
function correctIdx(s) { return Math.max(0, 'ABCD'.indexOf(String(s.jawaban || 'A').trim().charAt(0).toUpperCase())); }
function paintAnswer(i) {
  const s = getLib().soal[i], right = correctIdx(s);
  document.querySelectorAll('#opts' + i + ' .opt').forEach((el, oi) => {
    el.classList.add('lock');
    if (oi === right) el.classList.add('right');
    else if (oi === answered[i]) el.classList.add('wrong');
  });
  const ex = $('exp' + i); if (ex) ex.classList.add('show');
}
function updateScore() {
  const lib = getLib(); if (!lib) return;
  const mc = lib.soal.map((s, i) => ({ s, i })).filter(x => x.s.tipe !== 'essay');
  const done = mc.filter(x => answered[x.i] != null).length;
  const ok = mc.filter(x => answered[x.i] != null && answered[x.i] === correctIdx(x.s)).length;
  $('score').innerHTML = mc.length ? `Pilihan ganda terjawab <b>${done}</b> dari <b>${mc.length}</b>, benar <b>${ok}</b>` : 'Semua soal berbentuk essay. Buka kunci jawaban setelah mencoba menjawab sendiri.';
}
$('soalList').addEventListener('click', e => {
  const o = e.target.closest('.opt');
  if (o) {
    const i = +o.dataset.q;
    if (answered[i] != null) return;
    answered[i] = +o.dataset.o; paintAnswer(i); updateScore(); return;
  }
  const k = e.target.closest('[data-key]');
  if (k) $('key' + k.dataset.key).classList.toggle('show');
});

$('ansToggle').addEventListener('click', () => {
  $('ansCard').hidden = !$('ansCard').hidden;
  $('ansToggle').textContent = $('ansCard').hidden ? 'Lihat kunci jawaban' : 'Sembunyikan kunci jawaban';
});
$('soalCopy').addEventListener('click', () => {
  const t = buildSoalText(getLib());
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Soal dan kunci disalin'), () => toast('Salin gagal, pakai tombol Unduh TXT', 'err'));
});
$('soalDl').addEventListener('click', () => {
  const lib = getLib();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buildSoalText(lib)], { type: 'text/plain;charset=utf-8' }));
  a.download = (lib.code || lib.name).replace(/[^\w]+/g, '_') + '_soal.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
});

// INIT
(function initLogo() {
  const img = $('logo');
  if (img.complete && img.naturalWidth === 0) img.remove();
  else img.addEventListener('error', () => img.remove());
})();
refreshKeyDot(); checkServer(); renderSide();
if (libs.length) openLib(libs[libs.length - 1].id);
