// CK Drive for the browser: the owner's Google Drive through the Drive REST API, plus duplicate checks.
"use strict";

const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,md5Checksum,modifiedTime,parents,starred,trashed,shared,ownedByMe," +
  "owners(displayName),webViewLink,thumbnailLink,iconLink,driveId";
const ROOT = { id: "root", name: "My Drive" };

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("ckdrive." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ckdrive." + k, JSON.stringify(v)); } catch { } },
};

// ---------- Sign-in ----------

let token = null, tokenExpires = 0, tokenClient = null, tokenWaiters = [];

// Running from the CK Drive Windows app (localhost): it can keep a lasting sign-in, so windows never ask again.
const LAUNCHER = location.hostname === "localhost";
let lasting = false; // signed in through the Windows app

async function launcher(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || "GET", body: opts.body, headers: { "X-CKDrive": "1" }, cache: "no-store" });
  let j = {};
  try { j = await r.json(); } catch { }
  if (!r.ok) { const e = new Error(j.error || "CK Drive app error " + r.status); e.code = r.status; throw e; }
  return j;
}

async function launcherToken() {
  const t = await launcher("/auth/token");
  token = t.access_token;
  tokenExpires = Date.now() + Math.max(60, t.expires_in) * 1000;
  return token;
}

function loadSavedToken() {
  try {
    // localStorage, not sessionStorage: a new window shares the sign-in (until Google's hour is up).
    const t = JSON.parse(localStorage.getItem("ckdrive.token") || "null");
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
      try { localStorage.setItem("ckdrive.token", JSON.stringify({ token, exp: tokenExpires })); } catch { }
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
  if (lasting) {
    try { return await launcherToken(); } catch (e) {
      if (e.code !== 401) throw e;
      lasting = false; // access was removed in the Google account: sign in again
    }
  }
  return requestToken("");
}

/** Google's code flow: the Windows app turns the code into a lasting sign-in. */
function lastingSignIn() {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initCodeClient({
      client_id: window.CKDRIVE_CLIENT_ID,
      scope: SCOPE,
      ux_mode: "popup",
      select_account: true,
      callback: async r => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        try {
          const t = await launcher("/auth/code", { method: "POST", body: r.code });
          token = t.access_token; tokenExpires = Date.now() + t.expires_in * 1000;
          lasting = true; store.set("signedIn", true);
          resolve();
        } catch (e) { reject(e); }
      },
      error_callback: e => reject(new Error(e.message || e.type || "Sign-in was closed")),
    });
    client.requestCode();
  });
}

/** On the Windows app's sign-in screen: the one-time "stay signed in" setup, until a secret is saved. */
async function showLastingSetup() {
  let st;
  try { st = await launcher("/auth/status"); } catch { return; }
  const box = $("#lasting");
  if (st.secret) { box.classList.add("hidden"); $("#signin-btn").textContent = "Sign in with Google"; return; }
  box.classList.remove("hidden");
  $("#lasting-save").onclick = async () => {
    $("#lasting-error").textContent = "";
    try {
      await launcher("/auth/secret", { method: "POST", body: $("#lasting-secret").value.trim() });
      $("#lasting-secret").value = "";
      box.classList.add("hidden");
      $("#signin-btn").textContent = "Sign in with Google";
      $("#signin-error").textContent = "";
    } catch (e) { $("#lasting-error").textContent = e.message; }
  };
}

async function signOut() {
  if (lasting) { try { await launcher("/auth/signout", { method: "POST" }); } catch { } lasting = false; }
  else if (token) google.accounts.oauth2.revoke(token, () => { });
  token = null;
  localStorage.removeItem("ckdrive.token");
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
  // Shared drives: every file call has to say it understands them.
  if (url.includes("/files") && !url.includes("/files/trash") && !url.includes("supportsAllDrives"))
    url += (url.includes("?") ? "&" : "?") + "supportsAllDrives=true";
  // A dropped connection, or Google saying "busy": wait and try again (1 s, 2 s, 4 s) before giving up.
  let r;
  for (let tries = 0; ; tries++) {
    try {
      r = await fetch(url.startsWith("http") ? url : API + url, { method: opts.method || "GET", headers, body });
      if ((r.status === 429 || r.status >= 500) && tries < 3) { await new Promise(res => setTimeout(res, 1000 << tries)); continue; }
      break;
    } catch (e) {
      if (tries >= 3) throw new Error("Can't reach Google. Check the internet connection");
      await new Promise(res => setTimeout(res, 1000 << tries));
    }
  }
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
  list: (q, orderBy, pageToken, pageSize = 100, fields = FIELDS, extra = {}) =>
    call("/files?" + qs({ q, orderBy, pageToken, pageSize, fields: `nextPageToken,files(${fields})`, includeItemsFromAllDrives: true,
      ...(extra.driveId ? { corpora: "drive", driveId: extra.driveId } : extra.corpora ? { corpora: extra.corpora } : {}) })),
  sharedDrives: async () => ((await call("/drives?pageSize=100&fields=" + encodeURIComponent("drives(id,name)"))).drives || [])
    .map(d => ({ id: d.id, name: d.name, mimeType: FOLDER, driveId: d.id, ownedByMe: false })),
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
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?" + qs({ uploadType: "resumable", fields: FIELDS, supportsAllDrives: true }), {
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

  rebuild(force = true) {
    return this.run(async () => {
      await this.load();
      // Two callers can ask for the first scan at once (page load and an upload): only one scans.
      if (!force && this.token) return;
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
    if (!this.token) return this.rebuild(false);
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
    let cur = parents && parents[0], guard = 0, top = "My Drive";
    while (cur && guard++ < 30) {
      const f = this.folders.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parents[0];
      // A folder with no parent at all is a computer that Drive for desktop backs up.
      if (!cur) top = "Computers";
    }
    return [top, ...parts].join(" / ");
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
    let trail = [ROOT], done = false, made = null, okBtn = null;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="picker-path"></div>
      <div class="picker-new hidden"><input type="text" placeholder="Folder name" value="Untitled folder"><button class="btn primary">Create</button></div>
      <div class="folder-list"></div>`;
    // New folder: made inside the folder being shown, then opened, so the confirm button picks it.
    const newRow = $(".picker-new", wrap), newName = $("input", newRow);
    const create = async () => {
      const name = newName.value.trim();
      if (!name) return;
      try {
        const f = await drive.folder(name, trail.at(-1).id);
        newRow.classList.add("hidden");
        // Stay here and select it, so it's visible and the confirm button uses it.
        made = { id: f.id, name: f.name };
        draw();
      } catch (e) { toast("Couldn't make the folder: " + e.message); }
    };
    $("button", newRow).onclick = create;
    newName.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); create(); } });
    const draw = async () => {
      const path = $(".picker-path", wrap);
      path.innerHTML = (trail.length > 1 ? `<button class="icon-btn" data-up title="Up"><span class="ms">arrow_back</span></button>` : "") +
        `<span class="grow">${esc(trail.map(t => t.name).join(" / "))}</span>` +
        `<button class="icon-btn" data-new-folder title="New folder here"><span class="ms">create_new_folder</span></button>`;
      const up = $("[data-up]", path);
      if (up) up.onclick = () => { made = null; trail = trail.slice(0, -1); draw(); };
      if (okBtn) okBtn.textContent = made ? confirm.replace(" here", "") + " to " + made.name : confirm;
      $("[data-new-folder]", path).onclick = () => {
        newRow.classList.toggle("hidden");
        if (!newRow.classList.contains("hidden")) { newName.value = "Untitled folder"; newName.focus(); newName.select(); }
      };
      const list = $(".folder-list", wrap);
      list.innerHTML = `<div class="empty" style="padding:40px">Loading…</div>`;
      try {
        const r = await drive.list(`${quote(trail.at(-1).id)} in parents and trashed=false and mimeType=${quote(FOLDER)}`, "name_natural", null, 500);
        let fs = (r.files || []).filter(f => f.id !== exclude);
        if (made) fs = [made, ...fs.filter(f => f.id !== made.id)];
        list.innerHTML = (made ? `<div class="picker-made">Made "${esc(made.name)}". It's selected below.</div>` : "") +
          (fs.length ? "" : `<div class="empty" style="padding:40px">No folders inside</div>`);
        fs.forEach(f => {
          const b = document.createElement("button");
          const isNew = made && f.id === made.id;
          if (isNew) b.className = "chosen";
          b.innerHTML = `<span class="ms">${isNew ? "check_circle" : "folder"}</span>${esc(f.name)}` +
            (isNew ? `<small>New folder · click to open it</small>` : "");
          b.onclick = () => { made = null; trail = [...trail, { id: f.id, name: f.name }]; draw(); };
          list.append(b);
        });
      } catch (e) { list.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; }
    };
    const m = modal({
      title, body: wrap,
      actions: [{ label: "Cancel" }, { label: confirm, primary: true, run: () => { done = true; res(made || trail.at(-1)); } }],
      onClose: () => { if (!done) res(null); },
    });
    okBtn = m.actions.querySelector(".btn.primary");
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
  sel: new Set(),       // selected file ids
  anchor: null,         // last clicked id, for shift-click ranges
};

const SORTS = { name: "folder,name_natural", modified: "folder,modifiedTime desc", size: "folder,quotaBytesUsed desc" };

function currentFolder() {
  if (state.view === "files" || (["starred", "shared", "computers", "drives"].includes(state.view) && state.trail.length)) {
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
    case "computers":
    case "drives":
      if (state.trail.length) return [`${quote(inside.id)} in parents and trashed=false`, SORTS[state.sort], { driveId: inside.driveId }];
      return state.view === "starred"
        ? ["starred=true and trashed=false", "folder,name_natural"]
        : ["sharedWithMe=true and trashed=false", "sharedWithMeTime desc"];
    case "recent": return [`trashed=false and mimeType!=${quote(FOLDER)}`, "recency desc"];
    case "search": return [`(name contains ${quote(state.query)} or fullText contains ${quote(state.query)}) and trashed=false`, null, { corpora: "allDrives" }];
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
  state.sel.clear(); state.anchor = null;
  renderChrome();
  if (state.view === "duplicates") { renderDuplicates(); guard("Couldn't check Drive", () => index.sync()); return; }
  state.items = []; state.next = null; state.loading = true; state.error = null;
  renderList();
  try {
    const r = await listFor();
    if (seq !== state.seq) return;
    state.items = r.files || []; state.next = r.nextPageToken || null;
  } catch (e) {
    if (seq !== state.seq) return;
    state.error = e.message;
  }
  state.loading = false;
  renderList();
}

/** The current view's first page. Computers and Shared drives have their own top-level lists. */
async function listFor(pageToken) {
  if (!state.trail.length && state.view === "computers") {
    await index.sync();
    return { files: [...index.folders].filter(([, f]) => !f.parents.length).map(([id, f]) => ({ id, name: f.name, mimeType: FOLDER, ownedByMe: true }))
      .sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (!state.trail.length && state.view === "drives") return { files: (await drive.sharedDrives()).sort((a, b) => a.name.localeCompare(b.name)) };
  const [q, order, extra] = queryFor();
  return drive.list(q, order, pageToken, 100, FIELDS, extra || {});
}

async function loadMore() {
  if (!state.next || state.loading) return;
  const seq = state.seq;
  state.loading = true;
  try {
    const r = await listFor(state.next);
    if (seq !== state.seq) return;
    state.items = state.items.concat(r.files || []); state.next = r.nextPageToken || null;
  } catch (e) { toast(e.message); }
  state.loading = false;
  renderList();
}

function reloadQuiet() {
  if (state.view === "duplicates") return;
  const seq = state.seq;
  listFor().then(r => {
    if (seq !== state.seq) return;
    state.items = r.files || []; state.next = r.nextPageToken || null;
    const ids = new Set(state.items.map(f => f.id));
    [...state.sel].forEach(id => { if (!ids.has(id)) state.sel.delete(id); });
    renderList();
  }).catch(() => { });
}

// ---------- Rendering ----------

function renderChrome() {
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === state.view));
  const crumbs = $("#crumbs");
  const titles = { recent: "Recent", starred: "Starred", shared: "Shared with me", trash: "Trash", duplicates: "Duplicates",
    computers: "Computers", drives: "Shared drives" };
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
      <div class="card ${state.sel.has(f.id) ? "sel" : ""}" data-id="${esc(f.id)}">
        <div class="head"><button class="check" data-check title="Select"><span class="lt">${iconHtml(f)}</span><span class="ms box">check_circle</span></button>
          <span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
          <button class="icon-btn" data-more title="More"><span class="ms">more_vert</span></button></div>
        <div class="thumb" ${f.thumbnailLink ? `data-thumb="${esc(f.id)}"` : ""}>${iconHtml(f)}</div>
      </div>`).join("")}</div>`;
  } else {
    c.innerHTML = `<table class="files"><thead><tr><th>Name</th><th class="col-owner">Owner</th>
      <th class="col-mod">${trash ? "Trashed from" : "Last modified"}</th><th class="col-size">Size</th><th class="col-act"></th></tr></thead>
      <tbody>${state.items.map(f => `
      <tr class="row ${state.sel.has(f.id) ? "sel" : ""}" data-id="${esc(f.id)}">
        <td><div class="name-cell"><button class="check" data-check title="Select"><span class="lt" ${f.thumbnailLink ? `data-thumb="${esc(f.id)}"` : ""}>${iconHtml(f)}</span><span class="ms box">check_box</span></button>
          <span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
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
  loadThumbs(c);
  renderSelection();
}

// ---------- Selecting several files ----------

/** Updates row highlights and the selection bar without redrawing the list. */
function renderSelection() {
  document.querySelectorAll("#content [data-id]").forEach(el => {
    const on = state.sel.has(el.dataset.id);
    el.classList.toggle("sel", on);
    const box = el.querySelector(".check .box");
    if (box) box.textContent = el.tagName === "TR" ? (on ? "check_box" : "check_box_outline_blank") : (on ? "check_circle" : "radio_button_unchecked");
  });
  $("#content").classList.toggle("selecting", state.sel.size > 0);
  const bar = $("#selbar");
  if (!state.sel.size || state.view === "duplicates") { bar.classList.add("hidden"); $("#crumbs").classList.remove("hidden"); return; }
  $("#crumbs").classList.add("hidden");
  bar.classList.remove("hidden");
  const files = selectedFiles();
  const trash = state.view === "trash";
  const mine = files.every(f => f.ownedByMe || f.driveId);
  const allStarred = files.every(f => f.starred);
  const btn = (icon, title, act, show = true) => show ? `<button class="icon-btn" data-sel="${act}" title="${title}"><span class="ms">${icon}</span></button>` : "";
  bar.innerHTML = `<button class="icon-btn" data-sel="clear" title="Clear selection (Esc)"><span class="ms">close</span></button>
    <span class="count">${state.sel.size} selected</span>` + (trash
      ? btn("restore_from_trash", "Restore", "restore") + btn("delete_forever", "Delete forever", "delete")
      : btn("download", "Download", "download", files.some(f => f.mimeType !== FOLDER)) +
        btn("drive_file_move", "Move", "move", mine) +
        btn(allStarred ? "star" : "star_outline", allStarred ? "Remove from starred" : "Add to starred", "star") +
        btn("delete", "Move to trash (Delete)", "trash", mine)) +
    btn("select_all", "Select all (Ctrl+A)", "all");
}

const selectedFiles = () => state.items.filter(f => state.sel.has(f.id));

function clickSelect(f, e) {
  const ids = state.items.map(x => x.id);
  if (e.shiftKey && state.anchor && ids.includes(state.anchor)) {
    const [a, b] = [ids.indexOf(state.anchor), ids.indexOf(f.id)].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) state.sel.clear();
    ids.slice(a, b + 1).forEach(id => state.sel.add(id));
  } else if (e.ctrlKey || e.metaKey || e.toggle) {
    state.sel.has(f.id) ? state.sel.delete(f.id) : state.sel.add(f.id);
    state.anchor = f.id;
  } else {
    state.sel.clear(); state.sel.add(f.id); state.anchor = f.id;
  }
  renderSelection();
}

/** Runs [each] on every selected file, then reports how many worked. */
async function bulk(verb, files, each, after) {
  state.sel.clear(); renderSelection();
  let ok = 0;
  for (const f of files) { try { await each(f); ok++; } catch (e) { console.warn(verb, f.name, e); } }
  const failed = files.length - ok;
  toast(`${verb} ${ok} item${ok === 1 ? "" : "s"}` + (failed ? ` · ${failed} failed` : ""));
  renderList();
  if (after) after();
}

async function selectionAction(act) {
  const files = selectedFiles();
  if (act === "clear") { state.sel.clear(); renderSelection(); return; }
  if (act === "all") { state.items.forEach(f => state.sel.add(f.id)); renderSelection(); return; }
  if (!files.length) return;
  if (act === "trash") return bulk("Moved to trash:", files, async f => {
    await drive.patch(f.id, { trashed: true }); state.items = state.items.filter(x => x.id !== f.id); index.files.delete(f.id);
  }, () => index.save());
  if (act === "restore") return bulk("Restored", files, async f => {
    await drive.patch(f.id, { trashed: false }); state.items = state.items.filter(x => x.id !== f.id);
  }, () => index.sync().catch(() => { }));
  if (act === "delete") {
    if (!await confirmBox(`Delete ${files.length} forever?`, "They'll be deleted forever. This can't be undone.", "Delete forever")) return;
    return bulk("Deleted forever:", files, async f => { await drive.deleteForever(f.id); state.items = state.items.filter(x => x.id !== f.id); });
  }
  if (act === "star") {
    const star = !files.every(f => f.starred);
    return bulk(star ? "Starred" : "Unstarred", files, async f => {
      const u = await drive.patch(f.id, { starred: star });
      state.items = state.items.map(x => x.id === u.id ? u : x);
    }, () => { if (state.view === "starred" && !state.trail.length) reloadQuiet(); });
  }
  if (act === "move") {
    const to = await pickFolder(`Move ${files.length} item${files.length === 1 ? "" : "s"}`, "Move here");
    if (!to) return;
    return bulk(`Moved to ${to.name}:`, files, async f => {
      await drive.patch(f.id, {}, { addParents: to.id, removeParents: (f.parents || []).join(",") || undefined });
    }, () => { reloadQuiet(); index.sync().catch(() => { }); });
  }
  if (act === "download") {
    const list = files.filter(f => f.mimeType !== FOLDER);
    return bulk("Downloaded", list, f => download(f));
  }
}

// Drive's own thumbnails (photos, videos, PDFs, Docs…), fetched with the sign-in token as rows scroll into view.
const thumbCache = new Map();     // id -> blob URL, or null for "has none"
const thumbLinks = new Map();     // id -> thumbnailLink, for files not in the current list
let thumbsBusy = 0;
const thumbQueue = [];

async function thumbUrl(id) {
  if (thumbCache.has(id)) return thumbCache.get(id);
  let link = state.items.find(x => x.id === id)?.thumbnailLink || thumbLinks.get(id);
  if (link === undefined) {
    // Not in the list (the Duplicates page): ask Drive for it.
    try { link = (await call(`/files/${encodeURIComponent(id)}?fields=thumbnailLink`)).thumbnailLink || null; } catch { link = null; }
    thumbLinks.set(id, link);
  }
  if (!link) { thumbCache.set(id, null); return null; }
  const r = await fetch(link.replace(/=s\d+$/, "=s400"), { headers: { Authorization: "Bearer " + await getToken() } });
  const url = r.ok ? URL.createObjectURL(await r.blob()) : null;
  thumbCache.set(id, url);
  return url;
}

/** Six at a time, so a long list doesn't fire hundreds of requests at once. */
function queueThumb(el) {
  thumbQueue.push(el);
  const pump = async () => {
    while (thumbsBusy < 6 && thumbQueue.length) {
      const t = thumbQueue.shift();
      thumbsBusy++;
      thumbUrl(t.dataset.thumb).then(url => {
        if (url && t.isConnected) { t.innerHTML = `<img src="${url}" alt="">`; t.classList.add("has-img"); }
      }).catch(() => { }).finally(() => { thumbsBusy--; pump(); });
    }
  };
  pump();
}

function loadThumbs(root) {
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    queueThumb(e.target);
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
    const crumb = { id: f.id, name: f.name, driveId: f.driveId || state.trail.at(-1)?.driveId };
    if (state.view === "files") go("files", { trail: [...state.trail, crumb] });
    else go(state.view === "search" || state.view === "recent" ? "files" : state.view,
      { trail: state.view === "search" || state.view === "recent" ? [ROOT, crumb] : [...state.trail, crumb] });
    return;
  }
  if (viewKind(f)) {
    // Arrow through the photos, videos and PDFs in the same list.
    const list = state.items.filter(viewKind);
    openViewer(list, Math.max(0, list.findIndex(x => x.id === f.id)));
    return;
  }
  window.open(linkFor(f), "_blank", "noopener");
}

// ---------- Built-in viewer ----------

/** What CK Drive shows itself: image, video, audio or pdf (anything else opens in Drive). */
function viewKind(f) {
  const m = f.mimeType || "";
  if (m === FOLDER || isNative(f)) return null;
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  return null;
}

// Types browsers can draw themselves; others (HEIC, RAW…) use Drive's large preview image.
const WEB_IMAGES = /^image\/(jpeg|png|gif|webp|bmp|svg\+xml|avif|x-icon)$/;

async function fetchBlob(f) {
  const r = await call(`/files/${encodeURIComponent(f.id)}?alt=media`, { raw: true });
  return r.blob();
}

function openViewer(files, start) {
  let i = start, urls = [], aborted = false;
  const v = document.createElement("div");
  v.id = "viewer";
  v.innerHTML = `
    <div class="vbar">
      <button class="icon-btn" data-v="close" title="Close (Esc)"><span class="ms">close</span></button>
      <div class="vt"><div class="vn"></div><small class="vc"></small></div>
      <button class="icon-btn" data-v="download" title="Download"><span class="ms">download</span></button>
      <button class="icon-btn" data-v="drive" title="Open in Google Drive"><span class="ms">open_in_new</span></button>
      <button class="icon-btn" data-v="more" title="More"><span class="ms">more_vert</span></button>
    </div>
    <div class="vbody"></div>
    <button class="vnav prev" data-v="prev" title="Previous (←)"><span class="ms">chevron_left</span></button>
    <button class="vnav next" data-v="next" title="Next (→)"><span class="ms">chevron_right</span></button>`;
  document.body.append(v);
  const body = $(".vbody", v);
  const release = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };
  const close = () => { aborted = true; release(); v.remove(); document.removeEventListener("keydown", onKey, true); };

  const show = async () => {
    const f = files[i];
    release();
    $(".vn", v).textContent = f.name;
    $(".vc", v).textContent = files.length > 1 ? `${i + 1} of ${files.length}` : "";
    $(".prev", v).classList.toggle("hidden", i === 0);
    $(".next", v).classList.toggle("hidden", i === files.length - 1);
    body.innerHTML = `<div class="vmsg">Loading…</div>`;
    const kind = viewKind(f);
    const mine = i;
    try {
      if (kind === "image") {
        const big = f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, "=s2400") : null;
        if (big) {
          // Drive's large preview first (quick), then the real file if the browser can draw it.
          const r = await fetch(big, { headers: { Authorization: "Bearer " + await getToken() } });
          if (r.ok && mine === i && !aborted) {
            const u = URL.createObjectURL(await r.blob()); urls.push(u);
            body.innerHTML = `<img class="vimg" src="${u}" alt="">`;
          }
        }
        if (WEB_IMAGES.test(f.mimeType) && Number(f.size || 0) < 60e6) {
          const u = URL.createObjectURL(await fetchBlob(f));
          if (mine !== i || aborted) return URL.revokeObjectURL(u);
          urls.push(u);
          body.innerHTML = `<img class="vimg" src="${u}" alt="">`;
        } else if (!big) throw new Error("This kind of photo can't be shown here");
        zoomable($(".vimg", body));
      } else if (kind === "pdf") {
        const u = URL.createObjectURL(new Blob([await fetchBlob(f)], { type: "application/pdf" }));
        if (mine !== i || aborted) return URL.revokeObjectURL(u);
        urls.push(u);
        body.innerHTML = `<iframe class="vpdf" src="${u}" title="${esc(f.name)}"></iframe>`;
      } else if (kind === "audio" && Number(f.size || 0) < 200e6) {
        const u = URL.createObjectURL(await fetchBlob(f));
        if (mine !== i || aborted) return URL.revokeObjectURL(u);
        urls.push(u);
        body.innerHTML = `<div class="vaudio"><span class="ms">music_note</span><audio src="${u}" controls autoplay></audio></div>`;
      } else {
        // Videos stream through Drive's own player (it needs this browser signed in to Google).
        body.innerHTML = `<iframe class="vframe" src="https://drive.google.com/file/d/${encodeURIComponent(f.id)}/preview" allow="autoplay; fullscreen" allowfullscreen title="${esc(f.name)}"></iframe>`;
      }
    } catch (e) {
      if (mine !== i || aborted) return;
      body.innerHTML = `<div class="vmsg">${esc(e.message || "Couldn't load this file")}<br><br>
        <button class="btn" data-v="drive">Open in Google Drive</button></div>`;
    }
  };

  const go = d => { const n = i + d; if (n >= 0 && n < files.length) { i = n; show(); } };
  v.addEventListener("click", e => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    const f = files[i];
    const act = b.dataset.v;
    if (act === "close") close();
    else if (act === "prev") go(-1);
    else if (act === "next") go(1);
    else if (act === "download") guard("Download failed", () => download(f));
    else if (act === "drive") window.open(linkFor(f), "_blank", "noopener");
    else if (act === "more") {
      const r = b.getBoundingClientRect();
      showMenu(f, r.left, r.bottom, { onTrash: () => { files.splice(i, 1); if (!files.length) close(); else { i = Math.min(i, files.length - 1); show(); } } });
    }
  });
  const onKey = e => {
    if ($("#modal-root").children.length) return;
    if (e.key === "Escape") { if (!$("#ctx-menu").classList.contains("hidden")) hideMenus(); else close(); e.stopPropagation(); }
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  };
  document.addEventListener("keydown", onKey, true);
  // Swipe left/right on touch screens.
  let sx = null;
  body.addEventListener("touchstart", e => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  body.addEventListener("touchend", e => {
    if (sx == null || body.querySelector(".vimg.zoomed")) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
    sx = null;
  });
  show();
}

/** Click or double-tap to zoom a photo; drag to look around; mouse wheel zooms too. */
function zoomable(img) {
  if (!img) return;
  let scale = 1, x = 0, y = 0, drag = null;
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    img.classList.toggle("zoomed", scale > 1);
  };
  img.addEventListener("click", e => {
    if (drag && drag.moved) return;
    if (scale > 1) { scale = 1; x = y = 0; } else scale = 2.5;
    apply();
  });
  img.addEventListener("wheel", e => {
    e.preventDefault();
    scale = Math.min(6, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (scale === 1) x = y = 0;
    apply();
  }, { passive: false });
  img.addEventListener("pointerdown", e => {
    if (scale === 1) return;
    drag = { sx: e.clientX - x, sy: e.clientY - y, moved: false };
    img.setPointerCapture(e.pointerId);
  });
  img.addEventListener("pointermove", e => {
    if (!drag) return;
    x = e.clientX - drag.sx; y = e.clientY - drag.sy; drag.moved = true;
    apply();
  });
  img.addEventListener("pointerup", () => { setTimeout(() => { drag = null; }, 0); });
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

function showMenu(f, x, y, opts = {}) {
  const m = $("#ctx-menu");
  const trash = state.view === "trash";
  const items = trash ? [
    ["restore_from_trash", "Restore", async () => { await drive.patch(f.id, { trashed: false }); dropItem(f.id); toast(f.name + " restored"); index.sync().catch(() => { }); }],
    ["delete_forever", "Delete forever", async () => {
      if (!await confirmBox("Delete forever?", `"${f.name}" will be deleted forever. This can't be undone.`, "Delete forever")) return;
      await drive.deleteForever(f.id); dropItem(f.id); toast(f.name + " deleted forever");
    }],
  ] : [
    !opts.onTrash && ["open_in_new", f.mimeType === FOLDER ? "Open" : viewKind(f) ? "Preview" : "Open in Drive", () => openItem(f)],
    viewKind(f) && ["open_in_new", "Open in Drive", () => window.open(linkFor(f), "_blank", "noopener")],
    f.mimeType !== FOLDER && ["download", "Download", () => download(f)],
    "-",
    ["person_add", "Share", () => shareDialog(f)],
    ["link", "Copy link", () => { navigator.clipboard.writeText(linkFor(f)); toast("Link copied"); }],
    "-",
    ["drive_file_rename_outline", "Rename", async () => {
      const n = await ask("Rename", f.name, "Rename");
      if (n && n !== f.name) replaceItem(await drive.patch(f.id, { name: n }));
    }],
    (f.ownedByMe || f.driveId) && ["drive_file_move", "Move", async () => {
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
    (f.ownedByMe || f.driveId) && ["delete", "Move to trash", async () => {
      await drive.patch(f.id, { trashed: true }); dropItem(f.id); index.files.delete(f.id); toast(f.name + " moved to trash");
      if (opts.onTrash) opts.onTrash();
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

/** Right-click / ⋮ on a file while several are selected. */
function showBulkMenu(x, y) {
  const m = $("#ctx-menu");
  const files = selectedFiles();
  const trash = state.view === "trash";
  const mine = files.every(f => f.ownedByMe || f.driveId);
  const items = trash
    ? [["restore_from_trash", "Restore", "restore"], ["delete_forever", "Delete forever", "delete"]]
    : [
      files.some(f => f.mimeType !== FOLDER) && ["download", "Download", "download"],
      mine && ["drive_file_move", "Move", "move"],
      files.every(f => f.starred) ? ["star", "Remove from starred", "star"] : ["star_outline", "Add to starred", "star"],
      mine && ["delete", "Move to trash", "trash"],
    ];
  m.innerHTML = `<div style="padding:6px 16px;color:var(--muted)">${files.length} selected</div>`;
  items.filter(Boolean).forEach(([icon, label, act]) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="ms">${icon}</span>${esc(label)}`;
    b.onclick = () => { hideMenus(); guard(label + " failed", () => selectionAction(act)); };
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
  // The very first time, the whole Drive is listed once; say so, so it doesn't look like every upload will wait.
  const showScan = () => {
    if (index.state === "scanning") $(".note", status).textContent =
      `One-time setup: listing your Drive (${index.found} files so far). After this, checks take a second.`;
  };
  index.listeners.add(showScan);
  showScan();
  const syncNote = async () => {
    try { await index.sync(); return null; } catch (e) {
      return index.state === "ready"
        ? "No connection to Google right now, so files added elsewhere in the last few minutes may not be caught yet. Checking again automatically…"
        : "No connection to Google right now, so these haven't been checked for duplicates yet. Checking again automatically…";
    }
  };
  try { note = await syncNote(); } finally { index.listeners.delete(showScan); }
  const seen = new Map();
  cands = [];
  for (const { file, path } of files) {
    if (cancelled) return;
    status.innerHTML = `<div class="note">Fingerprinting ${esc(file.name)}…</div><div class="progress"><i style="width:0"></i></div>`;
    const bar = $(".progress > i", status);
    const md5 = await md5File(file, n => bar.style.width = (file.size ? n / file.size * 100 : 100) + "%");
    cands.push({ file, path: path || "", name: file.name, md5, size: file.size });
  }
  /** Compares every picked file with the Drive list (again, after a connection problem clears). */
  const evaluate = () => {
    seen.clear();
    cands.forEach(c => {
      const k = c.md5 + ":" + c.size;
      c.inDrive = index.matches(c.md5, c.size);
      c.sameAs = seen.get(k) || null;
      if (!c.sameAs) seen.set(k, c.name);
      c.dup = c.inDrive.length > 0 || !!c.sameAs;
    });
    const dups = cands.filter(c => c.dup).length;
    const checked = index.state === "ready";
    status.innerHTML = (note ? `<div class="note warn">${esc(note)}</div>` : "") +
      (dups ? `<div class="note warn"><b>${dups} already in your Drive.</b> They'll be skipped unless you switch them on.</div>`
        : checked ? `<div class="note">None of these are in your Drive yet.</div>` : "");
    draw(); refresh();
  };
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
      else if (index.state !== "ready") detail = "Not checked against Drive yet · " + fmtSize(c.size);
      else detail = "New · " + fmtSize(c.size);
      const icon = c.dup ? "warning" : index.state === "ready" ? "check_circle" : "help";
      // A preview of the photo itself (from this computer, nothing is uploaded for it).
      if (c.file.type.startsWith("image/") && !c.preview && c.file.size < 40e6) c.preview = URL.createObjectURL(c.file);
      row.innerHTML = `<span class="ms ${c.dup ? "bad" : "good"}">${icon}</span>` +
        (c.preview ? `<img class="cthumb" src="${c.preview}" alt="">` : "") + `
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
  evaluate();
  // Keep trying while the window is open (3 s, 6 s, 12 s… up to every 30 s).
  for (let wait = 3000; note && !cancelled; wait = Math.min(wait * 2, 30000)) {
    await new Promise(res => setTimeout(res, wait));
    if (cancelled) return;
    note = await syncNote();
    evaluate();
  }
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
      // A duplicate made on purpose ("Upload anyway") isn't announced later.
      const copies = index.matches(u.md5, u.size).length;
      const known = store.get("dupKnown", null);
      if (copies > 1 && known) { known[u.md5 + ":" + u.size] = copies; store.set("dupKnown", known); }
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

// ---------- New duplicates since last time ----------
// Duplicates can appear by any route (the Drive app, Drive for desktop, email attachments saved twice…).

const dupKey = g => g.key;
function markDuplicatesSeen(groups) { store.set("dupKnown", Object.fromEntries(groups.map(g => [dupKey(g), g.copies.length]))); }

function announceNewDuplicates() {
  const groups = index.groups();
  const before = store.get("dupKnown", null);
  if (!before) { markDuplicatesSeen(groups); return; } // first visit: nothing is "new" yet
  const fresh = groups.filter(g => (before[dupKey(g)] || 1) < g.copies.length);
  if (!fresh.length) return;
  const name = fresh[0].copies.reduce((a, b) => (b.modified > a.modified ? b : a)).name;
  const t = $("#toast");
  t.innerHTML = esc(fresh.length === 1 ? `"${name}" is in your Drive more than once.` : `${fresh.length} files are in your Drive more than once.`) +
    ` <a href="#duplicates" style="color:#8ab4f8;margin-left:8px">Review</a>`;
  $("a", t).onclick = e => { e.preventDefault(); t.classList.add("hidden"); go("duplicates"); };
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 12000);
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
  markDuplicatesSeen(groups);
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
        <div class="gh"><span class="gthumb" data-thumb="${esc(g.copies[0].id)}"><span class="ms">content_copy</span></span>${g.copies.length} copies · ${fmtSize(g.size)} each</div>
        ${g.copies.map(e => `<label class="copy"><input type="radio" name="k-${esc(g.key)}" value="${esc(e.id)}" ${e.id === k ? "checked" : ""}>
          <div class="info">${esc(e.name)}<small>${esc(index.path(e.parents))} · ${fmtWhen(e.modified)}</small></div>
          ${e.id === k ? `<span class="keep">KEEP</span>` : ""}</label>`).join("")}
        <div class="ga"><button class="btn" data-trash="${esc(g.key)}">Trash ${g.copies.length - 1} extra</button></div></div>`;
    }).join("");
  loadThumbs(c);
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
  if (["recent", "starred", "shared", "trash", "duplicates", "computers", "drives"].includes(h)) state.view = h;
  if (state.view !== "files") state.trail = [];
  // Back where it was before an update reload (same folder, same search).
  try {
    const back = JSON.parse(sessionStorage.getItem("ckdrive.place") || "null");
    sessionStorage.removeItem("ckdrive.place");
    if (back) { state.view = back.view; state.trail = back.trail; state.query = back.query || ""; }
  } catch { }
  history.replaceState({ view: state.view, trail: state.trail, query: state.query }, "", location.hash || "#files");
  if (state.view === "search") $("#search-input").value = state.query;
  load();
  drive.about().then(a => { state.account = a; renderStorage(); }).catch(() => { });
  index.sync().then(announceNewDuplicates).catch(e => console.warn("index", e));
  watchForUpdates();
}

// ---------- Updating itself ----------
// Each release has a version (stamp-web.ps1). An open CK Drive checks for a newer one now and then and
// reloads into it, but never in the middle of an upload, a dialog or the viewer.

const MY_VERSION = document.querySelector('meta[name="ckdrive-version"]')?.content || "";
let updateWaiting = false;

function safeToReload() {
  return !queue.some(q => !q.done && !q.error) && !$("#modal-root").children.length && !$("#viewer") && !state.sel.size;
}

function reloadNow() {
  try { sessionStorage.setItem("ckdrive.place", JSON.stringify({ view: state.view, trail: state.trail, query: state.query })); } catch { }
  location.reload();
}

async function checkForUpdate() {
  if (!MY_VERSION || updateWaiting) return;
  try {
    const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const v = (await r.json()).version;
    if (v && v !== MY_VERSION) updateWaiting = true;
  } catch { return; }
  if (updateWaiting) applyUpdate();
}

function applyUpdate() {
  if (safeToReload()) { reloadNow(); return; }
  // Busy: say so once, and reload as soon as it's safe.
  if (!$("#update-note")) {
    document.body.insertAdjacentHTML("beforeend",
      `<div id="update-note" class="toast" style="bottom:84px">CK Drive has been updated. It will refresh by itself when you're done.</div>`);
  }
  setTimeout(applyUpdate, 15000);
}

function watchForUpdates() {
  setInterval(checkForUpdate, 10 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
  addEventListener("focus", checkForUpdate);
  setTimeout(checkForUpdate, 30 * 1000);
}

function wire() {
  $("#signin-btn").onclick = async () => {
    $("#signin-error").textContent = "";
    try {
      // In the Windows app, once the secret is saved: a lasting sign-in. Otherwise Google's hour-long one.
      let st = null;
      if (LAUNCHER) try { st = await launcher("/auth/status"); } catch { }
      if (st && st.secret) await lastingSignIn(); else await requestToken("select_account");
      startApp();
    }
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
    if (b.dataset.new === "camera") $("#camera-input").click();
    if (b.dataset.new === "folder") guard("Couldn't make folder", async () => {
      const n = await ask("New folder", "Untitled folder", "Create");
      if (n) { await drive.folder(n, currentFolder().id); reloadQuiet(); }
    });
  };
  $("#file-input").onchange = e => { startUpload([...e.target.files].map(file => ({ file }))); e.target.value = ""; };
  $("#camera-input").onchange = e => {
    // Phones name camera shots oddly ("image.jpg"); give them a date-time name like the camera app does.
    const files = [...e.target.files].map(f => {
      const d = new Date(), p = n => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || [f.type.startsWith("video/") ? ".mp4" : ".jpg"])[0];
      return { file: new File([f], (f.type.startsWith("video/") ? "VID_" : "IMG_") + stamp + ext, { type: f.type }) };
    });
    startUpload(files); e.target.value = "";
  };
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
    if (!row) {
      // A click on empty space clears the selection.
      if (!e.target.closest("button") && state.sel.size) { state.sel.clear(); renderSelection(); }
      return;
    }
    const f = byId(row.dataset.id);
    if (e.target.closest("[data-more]")) {
      e.stopPropagation();
      const r = e.target.closest("[data-more]").getBoundingClientRect();
      if (state.sel.has(f.id) && state.sel.size > 1) showBulkMenu(r.left, r.bottom);
      else showMenu(f, r.left, r.bottom);
      return;
    }
    // The tick box (the file icon) adds or removes a file; on touch screens, so does a tap while selecting.
    const touch = matchMedia("(pointer: coarse)").matches;
    if (e.target.closest("[data-check]") || (touch && state.sel.size)) { clickSelect(f, { toggle: true }); return; }
    // Files and folders open on one tap on touch screens, like the Drive app.
    if (touch && state.view !== "trash") { openItem(f); return; }
    clickSelect(f, e);
  });
  content.addEventListener("contextmenu", e => {
    const row = e.target.closest("[data-id]");
    if (!row) return;
    e.preventDefault(); e.stopPropagation();
    const f = byId(row.dataset.id);
    if (state.sel.has(f.id) && state.sel.size > 1) { showBulkMenu(e.clientX, e.clientY); return; }
    clickSelect(f, {});
    showMenu(f, e.clientX, e.clientY);
  });
  // Long-press on touch screens starts selecting.
  let pressTimer = null;
  content.addEventListener("touchstart", e => {
    const row = e.target.closest("[data-id]");
    if (!row || e.target.closest("[data-more]")) return;
    pressTimer = setTimeout(() => { pressTimer = "fired"; clickSelect(byId(row.dataset.id), { toggle: true }); }, 500);
  }, { passive: true });
  const cancelPress = () => { if (pressTimer && pressTimer !== "fired") clearTimeout(pressTimer); };
  content.addEventListener("touchmove", cancelPress, { passive: true });
  content.addEventListener("touchend", e => {
    if (pressTimer === "fired") e.preventDefault(); // don't also open the file
    else cancelPress();
    pressTimer = null;
  });
  $("#selbar").addEventListener("click", e => {
    const b = e.target.closest("[data-sel]");
    if (b) guard("Couldn't do that", () => selectionAction(b.dataset.sel));
  });
  document.addEventListener("keydown", e => {
    if ($("#modal-root").children.length || $("#viewer") || e.target.closest?.("input, select, textarea")) return;
    if ($("#app").classList.contains("hidden")) return;
    if (e.key === "Escape" && state.sel.size) { state.sel.clear(); renderSelection(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && state.items.length) { e.preventDefault(); selectionAction("all"); }
    else if (e.key === "Delete" && state.sel.size && state.view !== "trash") guard("Couldn't move to trash", () => selectionAction("trash"));
    else if (e.key === "Enter" && state.sel.size === 1) openItem(selectedFiles()[0]);
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
  const ready = async () => {
    initGoogle();
    if (!window.CKDRIVE_CLIENT_ID) return;
    if (LAUNCHER) {
      // Already signed in on this PC: straight in, no Google window at all.
      try { await launcherToken(); lasting = true; startApp(); return; } catch { }
    }
    if (token) startApp();
    else {
      showSignIn();
      if (store.get("signedIn", false)) $("#signin-btn").textContent = "Continue with Google";
      if (LAUNCHER) showLastingSetup();
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
