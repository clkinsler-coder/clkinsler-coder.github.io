// CK Drive for the browser: the owner's Google Drive through the Drive REST API, plus duplicate checks.
"use strict";

const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,md5Checksum,modifiedTime,parents,starred,trashed,shared,ownedByMe," +
  "owners(displayName),webViewLink,thumbnailLink,iconLink";
const ROOT = { id: "root", name: "My Drive" };

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("ckdrive." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ckdrive." + k, JSON.stringify(v)); } catch { } },
};

// ---------- Sign-in ----------

let token = null, tokenExpires = 0, tokenClient = null, tokenWaiters = [];

function loadSavedToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem("ckdrive.token") || "null");
    if (t && t.exp > Date.now() + 60000) { token = t.token; tokenExpires = t.exp; }
  } catch { }
}

function initGoogle() {
  if (!window.CKDRIVE_CLIENT_ID) {
    showSignIn("CK Drive isn't connected to Google yet. Put the Web client ID in config.js (see \"Google Cloud setup.txt\").");
    $("#signin-btn").disabled = true;
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.CKDRIVE_CLIENT_ID,
    scope: SCOPE,
    callback: r => {
      const waiters = tokenWaiters; tokenWaiters = [];
      if (r.error) { waiters.forEach(w => w.reject(new Error(r.error_description || r.error))); return; }
      token = r.access_token;
      tokenExpires = Date.now() + (Number(r.expires_in) || 3600) * 1000;
      try { sessionStorage.setItem("ckdrive.token", JSON.stringify({ token, exp: tokenExpires })); } catch { }
      store.set("signedIn", true);
      waiters.forEach(w => w.resolve(token));
    },
    error_callback: e => {
      // Browsers block Google's sign-in popup unless it follows a click; ask for one instead of failing.
      if (e.type === "popup_failed_to_open") { showReconnect(); return; }
      const waiters = tokenWaiters; tokenWaiters = [];
      waiters.forEach(w => w.reject(new Error(e.message || e.type || "Sign-in was closed")));
    },
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenWaiters.push({ resolve, reject });
    if (tokenWaiters.length === 1) tokenClient.requestAccessToken({ prompt });
  });
}

let reconnectShown = false;
function showReconnect() {
  if (reconnectShown) return;
  reconnectShown = true;
  modal({
    title: "Reconnect to Google",
    body: "<p>CK Drive's sign-in ran out (Google ends it every hour). Click Reconnect to carry on.</p>",
    actions: [{ label: "Reconnect", primary: true, run: () => tokenClient.requestAccessToken({ prompt: "" }) }],
    onClose: () => { reconnectShown = false; },
  });
}

async function getToken() {
  if (token && tokenExpires > Date.now() + 60000) return token;
  token = null;
  return requestToken("");
}

function signOut() {
  if (token) google.accounts.oauth2.revoke(token, () => { });
  token = null;
  sessionStorage.removeItem("ckdrive.token");
  store.set("signedIn", false);
  const r = indexedDB.deleteDatabase("ckdrive");
  r.onsuccess = r.onerror = r.onblocked = () => location.reload();
}

// ---------- Drive API ----------

class DriveError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function call(url, opts = {}, retried = false) {
  const t = await getToken();
  const headers = Object.assign({ Authorization: "Bearer " + t }, opts.headers || {});
  let body = opts.body;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json; charset=UTF-8"; body = JSON.stringify(opts.json); }
  const r = await fetch(url.startsWith("http") ? url : API + url, { method: opts.method || "GET", headers, body });
  if (r.status === 401 && !retried) { token = null; return call(url, opts, true); }
  if (!r.ok) {
    let msg = "Drive error " + r.status;
    try { msg = (await r.json()).error.message || msg; } catch { }
    throw new DriveError(r.status, msg);
  }
  if (opts.raw) return r;
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

const qs = o => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
const quote = s => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

const drive = {
  list: (q, orderBy, pageToken, pageSize = 100, fields = FIELDS) =>
    call("/files?" + qs({ q, orderBy, pageToken, pageSize, fields: `nextPageToken,files(${fields})` })),
  get: id => call(`/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}`),
  about: () => call("/about?fields=" + encodeURIComponent("user(displayName,emailAddress,photoLink),storageQuota(limit,usage)")),
  patch: (id, json, extra = {}) => call(`/files/${encodeURIComponent(id)}?` + qs({ fields: FIELDS, ...extra }), { method: "PATCH", json }),
  copy: f => call(`/files/${encodeURIComponent(f.id)}/copy?fields=${encodeURIComponent(FIELDS)}`, { method: "POST", json: { name: "Copy of " + f.name } }),
  folder: (name, parent) => call(`/files?fields=${encodeURIComponent(FIELDS)}`, { method: "POST", json: { name, mimeType: FOLDER, parents: [parent] } }),
  deleteForever: id => call(`/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
  emptyTrash: () => call("/files/trash", { method: "DELETE" }),
  perms: id => call(`/files/${encodeURIComponent(id)}/permissions?fields=${encodeURIComponent("permissions(id,role,type,emailAddress,displayName)")}`),
  share: (id, json, notify) => call(`/files/${encodeURIComponent(id)}/permissions?` + qs({ sendNotificationEmail: json.type === "user" ? notify : undefined }), { method: "POST", json }),
  unshare: (id, pid) => call(`/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(pid)}`, { method: "DELETE" }),
  startToken: () => call("/changes/startPageToken"),
  changes: (pageToken, fields) => call("/changes?" + qs({ pageToken, pageSize: 1000, includeRemoved: true, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))` })),
};

/** Resumable upload with progress (XHR, since fetch has no upload progress). */
async function uploadFile(file, name, parent, onProgress) {
  const t = await getToken();
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?" + qs({ uploadType: "resumable", fields: FIELDS }), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + t,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": file.type || "application/octet-stream",
      "X-Upload-Content-Length": String(file.size),
    },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  if (!start.ok) throw new DriveError(start.status, "Drive didn't start the upload (" + start.status + ")");
  const session = start.headers.get("Location");
  if (!session) throw new Error("Drive didn't return an upload address");
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", session);
    x.upload.onprogress = e => onProgress(e.loaded);
    x.onload = () => x.status >= 200 && x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error("Upload failed (" + x.status + ")"));
    x.onerror = () => reject(new Error("Network error"));
    x.send(file);
  });
}

// ---------- Duplicate index ----------
// The fingerprint (MD5) of every file the owner owns, kept in IndexedDB and refreshed from Drive's changes feed.

const IDX_FIELDS = "id,name,mimeType,size,md5Checksum,modifiedTime,parents,trashed,ownedByMe";
const index = {
  files: new Map(),   // id -> {id,name,md5,size,parents,modified}
  folders: new Map(), // id -> {name,parents}
  token: null,
  updated: 0,
  state: "notbuilt",  // notbuilt | scanning | ready | failed
  found: 0,
  loaded: false,
  busy: null,
  listeners: new Set(),

  emit() { this.listeners.forEach(f => f()); },

  db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("ckdrive", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const db = await this.db();
      const v = await new Promise((res, rej) => {
        const q = db.transaction("kv").objectStore("kv").get("index");
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      if (v && v.token) {
        this.token = v.token; this.updated = v.updated;
        v.files.forEach(f => this.files.set(f.id, f));
        v.folders.forEach(([id, name, parents]) => this.folders.set(id, { name, parents }));
        this.state = "ready";
      }
    } catch (e) { console.warn("index load", e); }
    this.emit();
  },

  async save() {
    try {
      const db = await this.db();
      const v = { token: this.token, updated: this.updated, files: [...this.files.values()], folders: [...this.folders].map(([id, f]) => [id, f.name, f.parents]) };
      await new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(v, "index");
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { console.warn("index save", e); }
  },

  apply(f) {
    if (f.mimeType === FOLDER) {
      if (f.trashed || !f.ownedByMe) this.folders.delete(f.id); else this.folders.set(f.id, { name: f.name, parents: f.parents || [] });
      return;
    }
    if (f.trashed || !f.ownedByMe || !f.md5Checksum) { this.files.delete(f.id); return; }
    this.files.set(f.id, {
      id: f.id, name: f.name, md5: f.md5Checksum, size: Number(f.size || 0), parents: f.parents || [],
      modified: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    });
  },

  /** Serializes scans and syncs. */
  run(fn) {
    const p = (this.busy || Promise.resolve()).catch(() => { }).then(fn);
    this.busy = p;
    return p;
  },

  rebuild() {
    return this.run(async () => {
      await this.load();
      this.state = "scanning"; this.found = 0; this.emit();
      try {
        const start = (await drive.startToken()).startPageToken;
        this.files.clear(); this.folders.clear();
        for (const op of ["=", "!="]) {
          let page = null;
          do {
            const r = await drive.list(`'me' in owners and trashed=false and mimeType${op}${quote(FOLDER)}`, null, page, 1000, IDX_FIELDS);
            (r.files || []).forEach(f => this.apply(f));
            this.found = this.files.size + this.folders.size; this.emit();
            page = r.nextPageToken;
          } while (page);
        }
        this.token = start; this.updated = Date.now(); this.state = "ready";
        await this.save();
      } catch (e) {
        this.state = "failed"; this.error = e.message;
        throw e;
      } finally { this.emit(); }
    });
  },

  async sync() {
    await this.load();
    if (!this.token) return this.rebuild();
    return this.run(async () => {
      let t = this.token;
      for (; ;) {
        const r = await drive.changes(t, IDX_FIELDS);
        for (const c of r.changes || []) {
          if (c.removed || !c.file) { this.files.delete(c.fileId); this.folders.delete(c.fileId); }
          else this.apply(c.file);
        }
        if (r.nextPageToken) t = r.nextPageToken; else { t = r.newStartPageToken || t; break; }
      }
      this.token = t; this.updated = Date.now(); this.state = "ready";
      await this.save(); this.emit();
    });
  },

  matches(md5, size) { return [...this.files.values()].filter(f => f.md5 === md5 && f.size === size); },

  groups() {
    const by = new Map();
    for (const f of this.files.values()) {
      const k = f.md5 + ":" + f.size;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(f);
    }
    return [...by.values()].filter(g => g.length > 1)
      .map(g => ({ key: g[0].md5 + ":" + g[0].size, size: g[0].size, copies: g.sort((a, b) => a.modified - b.modified) }))
      .map(g => ({ ...g, wasted: g.size * (g.copies.length - 1) }))
      .sort((a, b) => b.wasted - a.wasted);
  },

  path(parents) {
    const parts = [];
    let cur = parents && parents[0], guard = 0;
    while (cur && guard++ < 30) {
      const f = this.folders.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parents[0];
    }
    return ["My Drive", ...parts].join(" / ");
  },
};

// ---------- Helpers ----------

function fmtSize(b) {
  if (b == null || b === "") return "";
  b = Number(b);
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return i === 0 ? b + " B" : b.toFixed(1) + " " + u[i];
}

function fmtWhen(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const opts = { month: "short", day: "numeric" };
  if (now - d > 300 * 864e5) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

const NATIVE = "application/vnd.google-apps.";
function typeIcon(f) {
  const m = f.mimeType || "";
  if (m === FOLDER) return ["folder", "#5f6368"];
  if (m === NATIVE + "document") return ["description", "#4285f4"];
  if (m === NATIVE + "spreadsheet") return ["table_chart", "#0f9d58"];
  if (m === NATIVE + "presentation") return ["slideshow", "#f4b400"];
  if (m === NATIVE + "form") return ["list_alt", "#7248b9"];
  if (m === "application/pdf") return ["picture_as_pdf", "#db4437"];
  if (m.startsWith("image/")) return ["image", "#db4437"];
  if (m.startsWith("video/")) return ["movie", "#db4437"];
  if (m.startsWith("audio/")) return ["music_note", "#8e24aa"];
  if (/zip|compressed|tar|rar/.test(m)) return ["folder_zip", "#5f6368"];
  if (/word/.test(m)) return ["description", "#4285f4"];
  if (/sheet|excel/.test(m)) return ["table_chart", "#0f9d58"];
  if (/presentation|powerpoint/.test(m)) return ["slideshow", "#f4b400"];
  return ["draft", "#5f6368"];
}
const iconHtml = f => { const [i, c] = typeIcon(f); return `<span class="ms" style="color:${c}">${i}</span>`; };
const isNative = f => (f.mimeType || "").startsWith(NATIVE) && f.mimeType !== FOLDER;
const linkFor = f => f.webViewLink || "https://drive.google.com/open?id=" + f.id;

function exportFor(f) {
  const m = {
    [NATIVE + "document"]: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    [NATIVE + "spreadsheet"]: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
    [NATIVE + "presentation"]: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
    [NATIVE + "drawing"]: ["image/png", "png"],
  }[f.mimeType];
  return m || (isNative(f) ? ["application/pdf", "pdf"] : null);
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}

async function guard(label, fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(label + ": " + (e.message || "failed")); }
}

// ---------- Modals ----------

function modal({ title, body, actions, wide, onClose }) {
  const root = document.createElement("div");
  root.className = "scrim";
  root.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog"><h2>${esc(title)}</h2><div class="body"></div><div class="actions"></div></div>`;
  const b = $(".body", root);
  if (typeof body === "string") b.innerHTML = body; else if (body) b.append(body);
  const close = () => { root.remove(); document.removeEventListener("keydown", onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.addEventListener("mousedown", e => { if (e.target === root) close(); });
  const a = $(".actions", root);
  (actions || [{ label: "Close" }]).forEach(x => {
    if (x.text != null) { const s = document.createElement("span"); s.className = "grow"; s.textContent = x.text; a.append(s); return; }
    const btn = document.createElement("button");
    btn.className = "btn " + (x.primary ? "primary" : "") + (x.danger ? " danger" : "");
    btn.textContent = x.label;
    btn.onclick = async () => { if (x.run) { const keep = await x.run(btn); if (keep === true) return; } close(); };
    a.append(btn);
  });
  $("#modal-root").append(root);
  return { root, body: b, actions: a, close };
}

function ask(title, initial, confirm) {
  return new Promise(res => {
    const input = document.createElement("input");
    input.type = "text"; input.value = initial;
    let done = false;
    const m = modal({
      title, body: input,
      actions: [{ label: "Cancel" }, { label: confirm, primary: true, run: () => { done = true; res(input.value.trim() || null); } }],
      onClose: () => { if (!done) res(null); },
    });
    input.addEventListener("keydown", e => { if (e.key === "Enter") { done = true; res(input.value.trim() || null); m.close(); } });
    setTimeout(() => { input.focus(); const dot = initial.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : initial.length); }, 0);
  });
}

function confirmBox(title, text, label, danger = true) {
  return new Promise(res => {
    let done = false;
    modal({
      title, body: `<p>${esc(text)}</p>`,
      actions: [{ label: "Cancel" }, { label, primary: !danger, danger, run: () => { done = true; res(true); } }],
      onClose: () => { if (!done) res(false); },
    });
  });
}

/** Browse folders and pick one. */
function pickFolder(title, confirm, exclude) {
  return new Promise(res => {
    let trail = [ROOT], done = false;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="picker-path"></div><div class="folder-list"></div>`;
    const draw = async () => {
      const path = $(".picker-path", wrap);
      path.innerHTML = (trail.length > 1 ? `<button class="icon-btn" data-up title="Up"><span class="ms">arrow_back</span></button>` : "") +
        esc(trail.map(t => t.name).join(" / "));
      const up = $("[data-up]", path);
      if (up) up.onclick = () => { trail = trail.slice(0, -1); draw(); };
      const list = $(".folder-list", wrap);
      list.innerHTML = `<div class="empty" style="padding:40px">Loading…</div>`;
      try {
        const r = await drive.list(`${quote(trail.at(-1).id)} in parents and trashed=false and mimeType=${quote(FOLDER)}`, "name_natural", null, 500);
        const fs = (r.files || []).filter(f => f.id !== exclude);
        list.innerHTML = fs.length ? "" : `<div class="empty" style="padding:40px">No folders inside</div>`;
        fs.forEach(f => {
          const b = document.createElement("button");
          b.innerHTML = `<span class="ms">folder</span>${esc(f.name)}`;
          b.onclick = () => { trail = [...trail, { id: f.id, name: f.name }]; draw(); };
          list.append(b);
        });
      } catch (e) { list.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; }
    };
    modal({
      title, body: wrap,
      actions: [{ label: "Cancel" }, { label: confirm, primary: true, run: () => { done = true; res(trail.at(-1)); } }],
      onClose: () => { if (!done) res(null); },
    });
    draw();
  });
}

// ---------- App state ----------

const state = {
  view: "files",        // files | recent | starred | shared | search | trash | duplicates
  trail: [ROOT],        // folders opened, for files/starred/shared
  query: "",
  items: [],
  next: null,
  loading: false,
  error: null,
  sort: store.get("sort", "name"),
  grid: store.get("grid", false),
  account: null,
  seq: 0,
};

const SORTS = { name: "folder,name_natural", modified: "folder,modifiedTime desc", size: "folder,quotaBytesUsed desc" };

function currentFolder() {
  if (state.view === "files" || ((state.view === "starred" || state.view === "shared") && state.trail.length)) {
    const t = state.trail.at(-1);
    if (t) return t;
  }
  return ROOT;
}

function queryFor() {
  const inside = state.trail.at(-1);
  switch (state.view) {
    case "files": return [`${quote(inside.id)} in parents and trashed=false`, SORTS[state.sort]];
    case "starred":
    case "shared":
      if (state.trail.length) return [`${quote(inside.id)} in parents and trashed=false`, SORTS[state.sort]];
      return state.view === "starred"
        ? ["starred=true and trashed=false", "folder,name_natural"]
        : ["sharedWithMe=true and trashed=false", "sharedWithMeTime desc"];
    case "recent": return [`trashed=false and mimeType!=${quote(FOLDER)}`, "recency desc"];
    case "search": return [`(name contains ${quote(state.query)} or fullText contains ${quote(state.query)}) and trashed=false`, null];
    case "trash": return ["trashed=true and 'me' in owners", "recency desc"];
  }
}

function go(view, opts = {}) {
  state.view = view;
  state.trail = opts.trail || (view === "files" ? [ROOT] : []);
  if (view === "search") state.query = opts.query;
  else $("#search-input").value = "";
  const h = view === "files" && state.trail.length > 1 ? "#folder/" + state.trail.at(-1).id : "#" + view;
  if (location.hash !== h) history.pushState({ view, trail: state.trail, query: state.query }, "", h);
  $(".side").classList.remove("open");
  load();
}

window.addEventListener("popstate", e => {
  const s = e.state;
  if (!s) { state.view = "files"; state.trail = [ROOT]; }
  else { state.view = s.view; state.trail = s.trail || []; state.query = s.query || ""; }
  load();
});

async function load() {
  const seq = ++state.seq;
  renderChrome();
  if (state.view === "duplicates") { renderDuplicates(); guard("Couldn't check Drive", () => index.sync()); return; }
  state.items = []; state.next = null; state.loading = true; state.error = null;
  renderList();
  try {
    const [q, order] = queryFor();
    const r = await drive.list(q, order);
    if (seq !== state.seq) return;
    state.items = r.files || []; state.next = r.nextPageToken || null;
  } catch (e) {
    if (seq !== state.seq) return;
    state.error = e.message;
  }
  state.loading = false;
  renderList();
}

async function loadMore() {
  if (!state.next || state.loading) return;
  const seq = state.seq;
  state.loading = true;
  try {
    const [q, order] = queryFor();
    const r = await drive.list(q, order, state.next);
    if (seq !== state.seq) return;
    state.items = state.items.concat(r.files || []); state.next = r.nextPageToken || null;
  } catch (e) { toast(e.message); }
  state.loading = false;
  renderList();
}

function reloadQuiet() {
  if (state.view === "duplicates") return;
  const seq = state.seq;
  const [q, order] = queryFor();
  drive.list(q, order).then(r => {
    if (seq !== state.seq) return;
    state.items = r.files || []; state.next = r.nextPageToken || null; renderList();
  }).catch(() => { });
}

// ---------- Rendering ----------

function renderChrome() {
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === state.view));
  const crumbs = $("#crumbs");
  const titles = { recent: "Recent", starred: "Starred", shared: "Shared with me", trash: "Trash", duplicates: "Duplicates" };
  let trail;
  if (state.view === "files") trail = state.trail;
  else if (state.view === "search") trail = [{ name: `Results for "${state.query}"` }];
  else trail = [{ name: titles[state.view], id: "" }, ...state.trail];
  crumbs.innerHTML = "";
  trail.forEach((t, i) => {
    if (i) crumbs.insertAdjacentHTML("beforeend", `<span class="ms sep">chevron_right</span>`);
    const a = document.createElement("a");
    a.textContent = t.name;
    a.onclick = () => {
      if (state.view === "search") return;
      if (state.view === "files") go("files", { trail: state.trail.slice(0, i + 1) });
      else go(state.view, { trail: state.trail.slice(0, i) });
    };
    crumbs.append(a);
  });
  const listy = !["duplicates", "trash"].includes(state.view);
  $("#sort").classList.toggle("hidden", !(state.view === "files" || state.trail.length));
  $("#view-toggle").classList.toggle("hidden", !listy);
  $("#empty-trash").classList.toggle("hidden", state.view !== "trash");
  $("#rescan").classList.toggle("hidden", state.view !== "duplicates");
  $("#view-toggle .ms").textContent = state.grid ? "view_list" : "grid_view";
  $("#sort").value = state.sort;
}

function emptyText() {
  if (state.view === "search") return ["search_off", `No results for "${state.query}"`];
  if (state.view === "trash") return ["delete", "Trash is empty"];
  if (state.trail.length > 1 || (state.view !== "files" && state.trail.length)) return ["folder_open", "This folder is empty"];
  if (state.view === "starred") return ["star", "Nothing starred yet"];
  if (state.view === "shared") return ["group", "Nothing shared with you"];
  return ["cloud_upload", "Drop files here, or use New → Upload files"];
}

function renderList() {
  const c = $("#content");
  if (state.view === "duplicates") return;
  if (state.loading && !state.items.length) { c.innerHTML = `<div class="empty">Loading…</div>`; return; }
  if (state.error && !state.items.length) {
    c.innerHTML = `<div class="empty"><span class="ms">error</span>${esc(state.error)}<br><br><button class="btn" id="retry">Try again</button></div>`;
    $("#retry").onclick = load;
    return;
  }
  if (!state.items.length) {
    const [i, t] = emptyText();
    c.innerHTML = `<div class="empty"><span class="ms">${i}</span>${esc(t)}</div>`;
    return;
  }
  const trash = state.view === "trash";
  if (state.grid && !trash) {
    c.innerHTML = `<div class="grid">${state.items.map(f => `
      <div class="card" data-id="${esc(f.id)}">
        <div class="head">${iconHtml(f)}<span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
          <button class="icon-btn" data-more title="More"><span class="ms">more_vert</span></button></div>
        <div class="thumb" ${f.thumbnailLink && !isNative(f) ? `data-thumb="${esc(f.id)}"` : ""}>${iconHtml(f)}</div>
      </div>`).join("")}</div>`;
    loadThumbs(c);
  } else {
    c.innerHTML = `<table class="files"><thead><tr><th>Name</th><th class="col-owner">Owner</th>
      <th class="col-mod">${trash ? "Trashed from" : "Last modified"}</th><th class="col-size">Size</th><th class="col-act"></th></tr></thead>
      <tbody>${state.items.map(f => `
      <tr class="row" data-id="${esc(f.id)}">
        <td><div class="name-cell">${iconHtml(f)}<span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
          ${f.shared ? `<span class="ms tag" title="Shared">group</span>` : ""}${f.starred ? `<span class="ms tag" title="Starred">star</span>` : ""}</div></td>
        <td class="c-owner">${f.ownedByMe ? "me" : esc(f.owners?.[0]?.displayName || "")}</td>
        <td>${fmtWhen(f.modifiedTime)}</td>
        <td class="c-size">${f.mimeType === FOLDER ? "—" : fmtSize(f.size)}</td>
        <td><button class="icon-btn" data-more title="More"><span class="ms">more_vert</span></button></td>
      </tr>`).join("")}</tbody></table>`;
  }
  if (state.next) {
    c.insertAdjacentHTML("beforeend", `<div class="empty" id="more" style="padding:24px">Loading more…</div>`);
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); loadMore(); } });
    io.observe($("#more"));
  }
}

const thumbCache = new Map();
function loadThumbs(root) {
  const io = new IntersectionObserver(es => es.forEach(async e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    const id = e.target.dataset.thumb;
    const f = state.items.find(x => x.id === id);
    if (!f) return;
    try {
      let url = thumbCache.get(id);
      if (!url) {
        const r = await fetch(f.thumbnailLink.replace(/=s\d+$/, "=s400"), { headers: { Authorization: "Bearer " + await getToken() } });
        if (!r.ok) return;
        url = URL.createObjectURL(await r.blob());
        thumbCache.set(id, url);
      }
      e.target.innerHTML = `<img src="${url}" alt="">`;
    } catch { }
  }), { rootMargin: "200px" });
  root.querySelectorAll("[data-thumb]").forEach(el => io.observe(el));
}

function renderStorage() {
  const a = state.account;
  if (!a) return;
  const used = Number(a.storageQuota?.usage || 0), lim = Number(a.storageQuota?.limit || 0);
  $("#storage").innerHTML = lim
    ? `<div class="bar"><i style="width:${Math.min(100, used / lim * 100)}%"></i></div>${fmtSize(used)} of ${fmtSize(lim)} used`
    : `${fmtSize(used)} used`;
  const u = a.user || {};
  const btn = $("#account-btn");
  btn.innerHTML = u.photoLink ? `<img src="${esc(u.photoLink)}" alt="" referrerpolicy="no-referrer">` : esc((u.displayName || "?")[0]);
  $("#account-info").innerHTML = `<div><b>${esc(u.displayName)}</b></div><div class="email">${esc(u.emailAddress)}</div>`;
}

function renderDupBadge() {
  const b = $("#dup-badge");
  if (index.state === "scanning") b.textContent = "checking…";
  else if (index.state === "ready") { const n = index.groups().length; b.textContent = n ? n : ""; }
  else b.textContent = "";
}

// ---------- File actions ----------

const byId = id => state.items.find(f => f.id === id);
const replaceItem = f => { state.items = state.items.map(x => x.id === f.id ? f : x); renderList(); };
const dropItem = id => { state.items = state.items.filter(x => x.id !== id); renderList(); };

function openItem(f) {
  if (f.mimeType === FOLDER) {
    if (state.view === "files") go("files", { trail: [...state.trail, { id: f.id, name: f.name }] });
    else go(state.view === "search" || state.view === "recent" ? "files" : state.view,
      { trail: state.view === "search" || state.view === "recent" ? [ROOT, { id: f.id, name: f.name }] : [...state.trail, { id: f.id, name: f.name }] });
    return;
  }
  window.open(linkFor(f), "_blank", "noopener");
}

async function download(f) {
  const ex = exportFor(f);
  toast("Downloading " + f.name + "…");
  const url = ex ? `/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(ex[0])}` : `/files/${encodeURIComponent(f.id)}?alt=media`;
  const r = await call(url, { raw: true });
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = ex && !f.name.endsWith("." + ex[1]) ? f.name + "." + ex[1] : f.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function details(f) {
  const m = modal({ title: f.name, body: "" });
  const kv = (k, v) => v ? `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>` : "";
  const draw = where => m.body.innerHTML =
    kv("Type", f.mimeType === FOLDER ? "Folder" : f.mimeType) + kv("Size", fmtSize(f.size)) + kv("Location", where) +
    kv("Owner", f.ownedByMe ? "Me" : f.owners?.[0]?.displayName) + kv("Modified", f.modifiedTime && new Date(f.modifiedTime).toLocaleString()) +
    kv("Shared", f.shared ? "Yes" : "No") + kv("Fingerprint (MD5)", f.md5Checksum) + kv("Link", linkFor(f));
  draw("…");
  const parts = [];
  let p = f.parents?.[0], n = 0;
  try {
    while (p && n++ < 20) {
      const x = await drive.get(p);
      if (!x.parents?.length) { parts.unshift(x.ownedByMe ? "My Drive" : x.name); break; }
      parts.unshift(x.name); p = x.parents[0];
    }
  } catch { }
  draw(parts.join(" / ") || (f.ownedByMe ? "My Drive" : "Shared with me"));
}

const ROLE = { owner: "Owner", writer: "Editor", commenter: "Commenter", reader: "Viewer" };

function shareDialog(f) {
  const wrap = document.createElement("div");
  let role = "reader";
  wrap.innerHTML = `
    <div class="field"><input type="email" id="sh-email" placeholder="Add people by email"></div>
    <div class="chips">${["reader", "commenter", "writer"].map(r => `<button class="chip ${r === role ? "on" : ""}" data-role="${r}">${ROLE[r]}</button>`).join("")}</div>
    <label class="switch"><input type="checkbox" id="sh-notify" checked> Email them a notice</label>
    <div style="margin:10px 0"><button class="btn primary" id="sh-add">Share</button></div>
    <h3 style="font-weight:500;margin:16px 0 4px">People with access</h3><div id="sh-people">Loading…</div>
    <h3 style="font-weight:500;margin:16px 0 4px">General access</h3><div id="sh-link"></div>
    <p class="error" id="sh-err"></p>`;
  modal({ title: `Share "${f.name}"`, body: wrap, actions: [{ label: "Copy link", run: () => { navigator.clipboard.writeText(linkFor(f)); toast("Link copied"); return true; } }, { label: "Done", primary: true }] });
  wrap.querySelectorAll("[data-role]").forEach(b => b.onclick = () => {
    role = b.dataset.role; wrap.querySelectorAll("[data-role]").forEach(x => x.classList.toggle("on", x === b));
  });
  const err = $("#sh-err", wrap);
  const run = async fn => { err.textContent = ""; try { await fn(); await draw(); } catch (e) { err.textContent = e.message; } };
  const draw = async () => {
    const ps = (await drive.perms(f.id)).permissions || [];
    const people = $("#sh-people", wrap);
    people.innerHTML = "";
    ps.filter(p => p.type !== "anyone").forEach(p => {
      const row = document.createElement("div");
      row.className = "person";
      row.innerHTML = `<span class="ms">person</span><div class="who">${esc(p.displayName || p.emailAddress || p.type)}
        <small>${esc([p.displayName ? p.emailAddress : null, ROLE[p.role] || p.role].filter(Boolean).join(" · "))}</small></div>`;
      if (p.role !== "owner") {
        const x = document.createElement("button");
        x.className = "icon-btn"; x.title = "Remove access"; x.innerHTML = `<span class="ms">close</span>`;
        x.onclick = () => run(() => drive.unshare(f.id, p.id));
        row.append(x);
      }
      people.append(row);
    });
    const anyone = ps.find(p => p.type === "anyone");
    const link = $("#sh-link", wrap);
    link.innerHTML = `<div class="person"><span class="ms">${anyone ? "public" : "lock"}</span><div class="who">
      ${anyone ? "Anyone with the link" : "Restricted"}<small>${anyone ? ROLE[anyone.role] : "Only people added above can open it"}</small></div></div>`;
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = anyone ? "Make restricted" : "Anyone with the link can view";
    b.onclick = () => run(() => anyone ? drive.unshare(f.id, anyone.id) : drive.share(f.id, { type: "anyone", role: "reader" }));
    link.append(b);
  };
  $("#sh-add", wrap).onclick = () => {
    const email = $("#sh-email", wrap).value.trim();
    if (!email.includes("@")) { err.textContent = "Enter an email address"; return; }
    run(async () => { await drive.share(f.id, { type: "user", role, emailAddress: email }, $("#sh-notify", wrap).checked); $("#sh-email", wrap).value = ""; });
  };
  draw().catch(e => { err.textContent = e.message; });
}

function showMenu(f, x, y) {
  const m = $("#ctx-menu");
  const trash = state.view === "trash";
  const items = trash ? [
    ["restore_from_trash", "Restore", async () => { await drive.patch(f.id, { trashed: false }); dropItem(f.id); toast(f.name + " restored"); index.sync().catch(() => { }); }],
    ["delete_forever", "Delete forever", async () => {
      if (!await confirmBox("Delete forever?", `"${f.name}" will be deleted forever. This can't be undone.`, "Delete forever")) return;
      await drive.deleteForever(f.id); dropItem(f.id); toast(f.name + " deleted forever");
    }],
  ] : [
    ["open_in_new", f.mimeType === FOLDER ? "Open" : "Open in Drive", () => openItem(f)],
    f.mimeType !== FOLDER && ["download", "Download", () => download(f)],
    "-",
    ["person_add", "Share", () => shareDialog(f)],
    ["link", "Copy link", () => { navigator.clipboard.writeText(linkFor(f)); toast("Link copied"); }],
    "-",
    ["drive_file_rename_outline", "Rename", async () => {
      const n = await ask("Rename", f.name, "Rename");
      if (n && n !== f.name) replaceItem(await drive.patch(f.id, { name: n }));
    }],
    f.ownedByMe && ["drive_file_move", "Move", async () => {
      const to = await pickFolder(`Move "${f.name}"`, "Move here", f.id);
      if (!to) return;
      await drive.patch(f.id, {}, { addParents: to.id, removeParents: (f.parents || []).join(",") || undefined });
      toast("Moved to " + to.name); reloadQuiet(); index.sync().catch(() => { });
    }],
    [f.starred ? "star" : "star_outline", f.starred ? "Remove from starred" : "Add to starred", async () => {
      const u = await drive.patch(f.id, { starred: !f.starred });
      if (state.view === "starred" && !state.trail.length && !u.starred) dropItem(f.id); else replaceItem(u);
    }],
    f.mimeType !== FOLDER && ["file_copy", "Make a copy", async () => { await drive.copy(f); toast("Made a copy of " + f.name); reloadQuiet(); }],
    ["info", "Details", () => details(f)],
    "-",
    f.ownedByMe && ["delete", "Move to trash", async () => {
      await drive.patch(f.id, { trashed: true }); dropItem(f.id); index.files.delete(f.id); toast(f.name + " moved to trash");
    }],
  ];
  m.innerHTML = "";
  items.filter(Boolean).forEach((it, i, arr) => {
    if (it === "-") { if (i && arr[i - 1] !== "-" && i < arr.length - 1) m.append(document.createElement("hr")); return; }
    const b = document.createElement("button");
    b.innerHTML = `<span class="ms">${it[0]}</span>${esc(it[1])}`;
    b.onclick = () => { hideMenus(); guard(it[1] + " failed", it[2]); };
    m.append(b);
  });
  m.classList.remove("hidden");
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
}

function hideMenus() { document.querySelectorAll(".menu").forEach(m => m.classList.add("hidden")); }

// ---------- Uploads with the duplicate check ----------

const queue = [];
let uploading = false;

/** files: [{file, path}] where path is the folder path inside the upload (for folder uploads). */
async function startUpload(files, parent = currentFolder()) {
  if (!files.length) return;
  const list = document.createElement("div");
  const status = document.createElement("div");
  status.innerHTML = `<div class="note">Checking whether these are already in your Drive…</div><div class="progress busy"><i></i></div>`;
  const wrap = document.createElement("div");
  const where = document.createElement("div");
  where.className = "person";
  wrap.append(where, status, list);
  let cands = null, forced = new Set(), cancelled = false;
  const drawWhere = () => {
    where.innerHTML = `<span class="ms">folder</span><div class="who"><small>Upload to</small>${esc(parent.name)}</div>`;
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = "Change";
    b.onclick = async () => { const p = await pickFolder("Upload to", "Upload here"); if (p) { parent = p; drawWhere(); } };
    where.append(b);
  };
  drawWhere();
  const count = () => cands ? cands.filter(c => !c.dup || forced.has(c)).length : 0;
  const m = modal({
    title: "Upload to Drive", body: wrap, wide: true,
    actions: [{ text: "" }, { label: "Cancel" }, {
      label: "Upload", primary: true, run: () => {
        if (!cands) return true;
        const go = cands.filter(c => !c.dup || forced.has(c));
        const skipped = cands.length - go.length;
        if (!go.length) { toast("Nothing uploaded: it's all already in your Drive"); return; }
        go.forEach(c => queue.push({ ...c, parent, sent: 0, done: false, error: null }));
        toast(`Uploading ${go.length} to ${parent.name}` + (skipped ? ` · skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : ""));
        pump();
      },
    }],
    onClose: () => { cancelled = true; },
  });
  const summary = $(".grow", m.actions);
  const upBtn = m.actions.querySelector(".btn.primary");
  upBtn.disabled = true;

  let note = null;
  try { await index.sync(); } catch (e) {
    note = index.state === "ready" ? "Couldn't refresh the duplicate list; using the last one." : "Couldn't check Drive for duplicates (" + e.message + ").";
  }
  const seen = new Map();
  cands = [];
  for (const { file, path } of files) {
    if (cancelled) return;
    status.innerHTML = `<div class="note">Fingerprinting ${esc(file.name)}…</div><div class="progress"><i style="width:0"></i></div>`;
    const bar = $(".progress > i", status);
    const md5 = await md5File(file, n => bar.style.width = (file.size ? n / file.size * 100 : 100) + "%");
    const inDrive = index.matches(md5, file.size);
    const sameAs = seen.get(md5 + ":" + file.size) || null;
    if (!sameAs) seen.set(md5 + ":" + file.size, file.name);
    cands.push({ file, path: path || "", name: file.name, md5, size: file.size, inDrive, sameAs, dup: inDrive.length > 0 || !!sameAs });
  }
  const dups = cands.filter(c => c.dup).length;
  status.innerHTML = (note ? `<div class="note warn">${esc(note)}</div>` : "") +
    (dups ? `<div class="note warn"><b>${dups} already in your Drive.</b> They'll be skipped unless you switch them on.</div>` : `<div class="note">None of these are in your Drive yet.</div>`);
  const draw = () => {
    list.innerHTML = "";
    cands.forEach(c => {
      const row = document.createElement("div");
      row.className = "cand" + (c.dup ? " dup" : "");
      let detail;
      if (c.inDrive.length) {
        const e = c.inDrive[0];
        detail = `Already in Drive: ${index.path(e.parents)} / ${e.name}` + (c.inDrive.length > 1 ? ` (+${c.inDrive.length - 1} more)` : "");
      } else if (c.sameAs) detail = `Same file as ${c.sameAs}, also in this upload`;
      else detail = "New · " + fmtSize(c.size);
      row.innerHTML = `<span class="ms ${c.dup ? "bad" : "good"}">${c.dup ? "warning" : "check_circle"}</span>
        <div class="info"><div class="n">${esc((c.path ? c.path + "/" : "") + c.name)}</div><small title="${esc(detail)}">${esc(detail)}</small></div>`;
      if (c.dup) {
        const l = document.createElement("label");
        l.className = "switch";
        l.innerHTML = `<input type="checkbox" ${forced.has(c) ? "checked" : ""}> Upload anyway`;
        $("input", l).onchange = e => { e.target.checked ? forced.add(c) : forced.delete(c); refresh(); };
        row.append(l);
      }
      list.append(row);
    });
  };
  const refresh = () => {
    const n = count();
    summary.textContent = n ? `${n} to upload` : "Nothing new to upload";
    upBtn.textContent = n ? "Upload" : "Done";
    upBtn.disabled = false;
  };
  draw(); refresh();
}

const folderCache = new Map();
async function folderFor(parent, path) {
  if (!path) return parent.id;
  let id = parent.id;
  for (const part of path.split("/").filter(Boolean)) {
    const key = id + "/" + part;
    if (!folderCache.has(key)) {
      const r = await drive.list(`${quote(id)} in parents and name=${quote(part)} and mimeType=${quote(FOLDER)} and trashed=false`, null, null, 1);
      folderCache.set(key, r.files?.[0]?.id || (await drive.folder(part, id)).id);
    }
    id = folderCache.get(key);
  }
  return id;
}

async function pump() {
  renderUploads();
  if (uploading) return;
  uploading = true;
  let any = false;
  for (let u; (u = queue.find(q => !q.done && !q.error));) {
    try {
      const parentId = await folderFor(u.parent, u.path);
      let last = 0;
      const f = await uploadFile(u.file, u.name, parentId, n => {
        u.sent = n;
        if (Date.now() - last > 250) { last = Date.now(); renderUploads(); }
      });
      u.done = true; u.sent = u.size; any = true;
      index.apply(f); index.save(); index.emit();
    } catch (e) { u.error = e.message; }
    renderUploads();
  }
  uploading = false;
  if (any) reloadQuiet();
}

function renderUploads() {
  const box = $("#uploads");
  if (!queue.length) { box.classList.add("hidden"); return; }
  const active = queue.filter(q => !q.done && !q.error).length;
  const failed = queue.filter(q => q.error).length;
  box.classList.remove("hidden");
  box.innerHTML = `<div class="uh"><span class="t">${active ? `Uploading ${active} item${active === 1 ? "" : "s"}` :
    failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : `${queue.length} upload${queue.length === 1 ? "" : "s"} complete`}</span>
    ${active ? "" : `<button class="icon-btn" id="up-close" title="Close"><span class="ms">close</span></button>`}</div>
    <div class="ul">${queue.map(q => `<div class="ui">${iconHtml({ mimeType: q.file.type })}<div class="info"><div class="n">${esc(q.name)}</div>
      ${q.error ? `<small class="err">${esc(q.error)}</small>` : q.done ? `<small>Done</small>` :
        `<div class="progress"><i style="width:${q.size ? q.sent / q.size * 100 : 0}%"></i></div>`}</div>
      ${q.done ? `<span class="ms" style="color:var(--ok)">check_circle</span>` : ""}</div>`).join("")}</div>`;
  const c = $("#up-close");
  if (c) c.onclick = () => { queue.length = 0; renderUploads(); };
}

// ---------- Duplicates page ----------

const keep = new Map();

function renderDuplicates() {
  if (state.view !== "duplicates") return;
  const c = $("#content");
  if (index.state === "scanning") {
    c.innerHTML = `<div class="empty"><span class="ms">manage_search</span>Checking every file in your Drive… ${index.found} so far
      <div class="progress busy" style="max-width:320px;margin:16px auto"><i></i></div>
      <small>The first check takes a minute or two. After that it only looks at what changed.</small></div>`;
    return;
  }
  if (index.state === "failed") { c.innerHTML = `<div class="empty error">${esc(index.error)}</div>`; return; }
  if (index.state !== "ready") { c.innerHTML = `<div class="empty">Loading…</div>`; return; }
  const groups = index.groups();
  if (!groups.length) {
    c.innerHTML = `<div class="empty"><span class="ms">check_circle</span>No duplicates in your Drive<br><small>${index.files.size} files checked · ${fmtWhen(index.updated)}</small></div>`;
    return;
  }
  const extras = g => { const k = keep.get(g.key) || g.copies[0].id; return g.copies.filter(x => x.id !== k); };
  const wasted = groups.reduce((s, g) => s + g.wasted, 0);
  c.innerHTML = `<div class="dup-head"><div class="grow">${groups.length} sets of identical files · ${fmtSize(wasted)} taken by extra copies
      <small>${index.files.size} files checked · last checked ${fmtWhen(index.updated)}. The oldest copy is kept unless you pick another.</small></div>
      <button class="btn primary" id="trash-all">Trash all extras</button></div>` +
    groups.map(g => {
      const k = keep.get(g.key) || g.copies[0].id;
      return `<div class="group" data-key="${esc(g.key)}">
        <div class="gh"><span class="ms">content_copy</span>${g.copies.length} copies · ${fmtSize(g.size)} each</div>
        ${g.copies.map(e => `<label class="copy"><input type="radio" name="k-${esc(g.key)}" value="${esc(e.id)}" ${e.id === k ? "checked" : ""}>
          <div class="info">${esc(e.name)}<small>${esc(index.path(e.parents))} · ${fmtWhen(e.modified)}</small></div>
          ${e.id === k ? `<span class="keep">KEEP</span>` : ""}</label>`).join("")}
        <div class="ga"><button class="btn" data-trash="${esc(g.key)}">Trash ${g.copies.length - 1} extra</button></div></div>`;
    }).join("");
  c.querySelectorAll(".group input[type=radio]").forEach(r => r.onchange = () => {
    keep.set(r.closest(".group").dataset.key, r.value); renderDuplicates();
  });
  const trash = async list => {
    if (!await confirmBox(`Move ${list.length} file${list.length === 1 ? "" : "s"} to trash?`,
      "The copy marked KEEP in each set stays. Trashed files can be restored from Trash for 30 days.", "Move to trash", false)) return;
    let n = 0;
    for (const e of list) {
      try { await drive.patch(e.id, { trashed: true }); index.files.delete(e.id); n++; } catch { }
    }
    await index.save();
    toast(`Moved ${n} duplicate${n === 1 ? "" : "s"} to trash` + (n < list.length ? ` · ${list.length - n} failed` : ""));
    index.emit();
  };
  $("#trash-all").onclick = () => trash(groups.flatMap(extras));
  c.querySelectorAll("[data-trash]").forEach(b => b.onclick = () => trash(extras(groups.find(g => g.key === b.dataset.trash))));
}

// ---------- Wiring ----------

function showSignIn(err) {
  $("#app").classList.add("hidden");
  $("#signin").classList.remove("hidden");
  $("#signin-error").textContent = err || "";
}

async function startApp() {
  $("#signin").classList.add("hidden");
  $("#app").classList.remove("hidden");
  index.listeners.add(() => { renderDupBadge(); if (state.view === "duplicates") renderDuplicates(); });
  const h = location.hash.slice(1);
  if (["recent", "starred", "shared", "trash", "duplicates"].includes(h)) state.view = h;
  history.replaceState({ view: state.view, trail: state.view === "files" ? [ROOT] : [], query: "" }, "", location.hash || "#files");
  if (state.view !== "files") state.trail = [];
  load();
  drive.about().then(a => { state.account = a; renderStorage(); }).catch(() => { });
  index.sync().catch(e => console.warn("index", e));
}

function wire() {
  $("#signin-btn").onclick = async () => {
    $("#signin-error").textContent = "";
    try { await requestToken("select_account"); startApp(); }
    catch (e) { $("#signin-error").textContent = "Couldn't sign in: " + e.message; }
  };
  $("#signout-btn").onclick = signOut;
  document.querySelectorAll("#nav a").forEach(a => a.onclick = () => go(a.dataset.nav));
  $("#menu-toggle").onclick = e => { e.stopPropagation(); $(".side").classList.toggle("open"); };
  $("#search").onsubmit = e => {
    e.preventDefault();
    const q = $("#search-input").value.trim();
    if (q) go("search", { query: q });
  };
  $("#sort").onchange = e => { state.sort = e.target.value; store.set("sort", state.sort); load(); };
  $("#view-toggle").onclick = () => { state.grid = !state.grid; store.set("grid", state.grid); renderChrome(); renderList(); };
  $("#empty-trash").onclick = () => guard("Couldn't empty trash", async () => {
    if (!await confirmBox("Empty trash?", "Everything in Trash will be deleted forever. This can't be undone.", "Delete forever")) return;
    await drive.emptyTrash(); state.items = []; renderList(); toast("Trash emptied");
  });
  $("#rescan").onclick = () => guard("Couldn't scan Drive", () => index.rebuild());

  $("#new-btn").onclick = e => { e.stopPropagation(); const m = $("#new-menu"); const was = m.classList.contains("hidden"); hideMenus(); if (was) m.classList.remove("hidden"); };
  $("#new-menu").onclick = e => {
    const b = e.target.closest("[data-new]");
    if (!b) return;
    hideMenus();
    if (b.dataset.new === "files") $("#file-input").click();
    if (b.dataset.new === "folder-upload") $("#folder-input").click();
    if (b.dataset.new === "folder") guard("Couldn't make folder", async () => {
      const n = await ask("New folder", "Untitled folder", "Create");
      if (n) { await drive.folder(n, currentFolder().id); reloadQuiet(); }
    });
  };
  $("#file-input").onchange = e => { startUpload([...e.target.files].map(file => ({ file }))); e.target.value = ""; };
  $("#folder-input").onchange = e => {
    startUpload([...e.target.files].map(file => ({ file, path: file.webkitRelativePath.split("/").slice(0, -1).join("/") })));
    e.target.value = "";
  };
  $("#account-btn").onclick = e => { e.stopPropagation(); const m = $("#account-menu"); const was = m.classList.contains("hidden"); hideMenus(); if (was) m.classList.remove("hidden"); };
  document.addEventListener("click", e => {
    if (!e.target.closest(".menu")) hideMenus();
    if (!e.target.closest(".side") && !e.target.closest("#menu-toggle")) $(".side").classList.remove("open");
  });

  const content = $("#content");
  content.addEventListener("dblclick", e => {
    const row = e.target.closest("[data-id]");
    if (row && state.view !== "trash" && !e.target.closest("[data-more]")) openItem(byId(row.dataset.id));
  });
  content.addEventListener("click", e => {
    const row = e.target.closest("[data-id]");
    if (!row) return;
    const f = byId(row.dataset.id);
    if (e.target.closest("[data-more]")) {
      e.stopPropagation();
      const r = e.target.closest("[data-more]").getBoundingClientRect();
      showMenu(f, r.left, r.bottom);
      return;
    }
    content.querySelectorAll(".sel").forEach(x => x.classList.remove("sel"));
    row.classList.add("sel");
    // Folders open on one click on touch screens, like the Drive app.
    if (matchMedia("(pointer: coarse)").matches && state.view !== "trash") openItem(f);
  });
  content.addEventListener("contextmenu", e => {
    const row = e.target.closest("[data-id]");
    if (!row) return;
    e.preventDefault(); e.stopPropagation();
    showMenu(byId(row.dataset.id), e.clientX, e.clientY);
  });

  // Drag and drop files (and whole folders) onto the page.
  let depth = 0;
  const canDrop = () => !$("#app").classList.contains("hidden") && !["trash", "duplicates"].includes(state.view);
  addEventListener("dragenter", e => {
    if (!canDrop() || !e.dataTransfer.types.includes("Files")) return;
    depth++; $("#drop-folder").textContent = currentFolder().name; $("#drop-hint").classList.remove("hidden");
  });
  addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("#drop-hint").classList.add("hidden"); } });
  addEventListener("dragover", e => { if (canDrop()) e.preventDefault(); });
  addEventListener("drop", async e => {
    e.preventDefault(); depth = 0; $("#drop-hint").classList.add("hidden");
    if (!canDrop()) return;
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const out = [];
    const walk = (entry, path) => new Promise(res => {
      if (entry.isFile) entry.file(file => { out.push({ file, path }); res(); }, () => res());
      else {
        const r = entry.createReader(), all = [];
        const more = () => r.readEntries(async es => {
          if (!es.length) { for (const x of all) await walk(x, path ? path + "/" + entry.name : entry.name); res(); }
          else { all.push(...es); more(); }
        }, () => res());
        more();
      }
    });
    if (entries.length) { for (const en of entries) await walk(en, ""); }
    else out.push(...[...e.dataTransfer.files].map(file => ({ file })));
    startUpload(out);
  });

  // Tell the CK Drive launcher (when there is one) that the page is still open.
  if (location.hostname === "localhost") setInterval(() => fetch("/ping", { method: "POST" }).catch(() => { }), 10000);
}

window.addEventListener("load", () => {
  wire();
  loadSavedToken();
  const ready = () => {
    initGoogle();
    if (!window.CKDRIVE_CLIENT_ID) return;
    if (token) startApp();
    else {
      showSignIn();
      if (store.get("signedIn", false)) $("#signin-btn").textContent = "Continue with Google";
    }
  };
  if (window.google?.accounts) ready();
  else {
    const t = setInterval(() => { if (window.google?.accounts) { clearInterval(t); ready(); } }, 100);
    setTimeout(() => {
      if (!window.google?.accounts) { clearInterval(t); showSignIn("Couldn't reach Google. Check the internet connection and reload."); }
    }, 15000);
  }
});
