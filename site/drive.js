// Google sign-in + a single JSON file in the user's Google Drive used as the data store.
//
// Uses the `drive.file` scope: the app can only see files it created, nothing else in Drive.
// The browser's localStorage stays as a cache (so the app works offline); Drive is the shared copy.
// Conflicts are detected with Drive's file `version`: if another device saved since our last sync,
// the user picks which copy wins.
import { DRIVE_FILE_NAME, GOOGLE_CLIENT_ID } from "./config.js";

const SCOPES = "https://www.googleapis.com/auth/drive.file openid email";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const STATE_KEY = "pt.drive";   // { email, fileId, version, dirty } in localStorage
const TOKEN_KEY = "pt.driveToken"; // { access_token, expires_at } in sessionStorage (cleared with the tab)

const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)) || null; } catch { return null; } };
const write = (storage, key, v) => { try { v == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };

export function createDriveSync({ getSnapshot, applySnapshot, onStatus }) {
  let tokenClient = null;
  let saveTimer = null;
  let busy = Promise.resolve();
  const state = () => read(localStorage, STATE_KEY);
  const setState = (patch) => write(localStorage, STATE_KEY, patch === null ? null : { ...(state() || {}), ...patch });
  const token = () => {
    const t = read(sessionStorage, TOKEN_KEY);
    return t && t.expires_at > Date.now() + 60e3 ? t.access_token : null;
  };
  const status = (kind, detail = "") => onStatus({ kind, detail, email: state()?.email || "" });

  async function loadGis() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load Google sign-in"));
      document.head.appendChild(s);
    });
  }

  // Must be called from a click/tap: Google opens a popup.
  async function requestToken() {
    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient ||= google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: SCOPES, callback: () => {} });
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, "https://www.googleapis.com/auth/drive.file")) {
          return reject(new Error("Please allow access to the app's own Google Drive files."));
        }
        write(sessionStorage, TOKEN_KEY, { access_token: resp.access_token, expires_at: Date.now() + resp.expires_in * 1000 });
        resolve(resp.access_token);
      };
      tokenClient.error_callback = (err) => reject(new Error(err.message || err.type || "Sign-in cancelled"));
      tokenClient.requestAccessToken({ prompt: state()?.email ? "" : "consent", login_hint: state()?.email || "" });
    });
  }

  async function api(url, opts = {}) {
    const t = token();
    if (!t) throw Object.assign(new Error("Google session expired"), { needsTap: true });
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
    if (res.status === 401) {
      write(sessionStorage, TOKEN_KEY, null);
      throw Object.assign(new Error("Google session expired"), { needsTap: true });
    }
    if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  const findFile = async () => {
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const j = await (await api(`${API}?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,version)`)).json();
    return j.files?.[0] || null;
  };
  const meta = async (id) => (await api(`${API}/${id}?fields=id,version,trashed`)).json();
  const download = async (id) => (await api(`${API}/${id}?alt=media`)).json();
  async function create(data) {
    const boundary = "pt" + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: "application/json", description: "Portfolio Tracker data (transactions + settings)" }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
    return (await api(`${UPLOAD}?uploadType=multipart&fields=id,version`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    })).json();
  }
  const update = async (id, data) => (await api(`${UPLOAD}/${id}?uploadType=media&fields=id,version`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  })).json();

  const count = (snap) => snap?.transactions?.length || 0;
  const same = (a, b) => JSON.stringify(a?.transactions || []) === JSON.stringify(b?.transactions || [])
    && JSON.stringify(a?.settings || {}) === JSON.stringify(b?.settings || {});

  async function push(fileId) {
    const saved = fileId ? await update(fileId, getSnapshot()) : await create(getSnapshot());
    setState({ fileId: saved.id, version: saved.version, dirty: false });
  }

  // Reconcile this browser with the Drive file.
  async function sync() {
    status("syncing");
    const st = state() || {};
    let file = st.fileId ? await meta(st.fileId).catch(() => null) : null;
    if (!file || file.trashed) file = await findFile();
    const local = getSnapshot();
    if (!file) {
      await push(null);
      return status("synced", "Created your data file in Google Drive");
    }
    const remoteChanged = file.id !== st.fileId || file.version !== st.version;
    if (!remoteChanged) {
      if (st.dirty) await push(file.id);
      return status("synced");
    }
    const remote = await download(file.id);
    let useRemote = true;
    if (!same(local, remote) && count(local) && (st.dirty || file.id !== st.fileId)) {
      useRemote = confirm(
        `Your Google Drive copy (${count(remote)} transactions) differs from the data on this device ` +
        `(${count(local)} transactions).\n\nOK = use the Google Drive copy on this device.\n` +
        `Cancel = keep this device's data and overwrite Google Drive.`);
    }
    if (useRemote) {
      setState({ fileId: file.id, version: file.version, dirty: false });
      await applySnapshot(remote);
    } else {
      setState({ fileId: file.id, version: file.version });
      await push(file.id);
    }
    status("synced");
  }

  const run = (fn) => (busy = busy.then(fn).catch((e) => {
    console.error(e);
    status(e.needsTap ? "needs-tap" : "error", e.needsTap ? "" : e.message);
  }));

  return {
    enabled: Boolean(GOOGLE_CLIENT_ID),
    get signedIn() { return Boolean(state()?.email); },

    /** On page load: sync if this tab still has a valid token, else ask for a tap. */
    resume() {
      if (!this.enabled) return status("off");
      if (!this.signedIn) return status("signed-out");
      if (!token()) return status("needs-tap");
      return run(sync);
    },

    /** Sign in (or reconnect after the 1-hour token expires) and sync. Call from a tap. */
    connect() {
      return run(async () => {
        status("syncing", "Waiting for Google…");
        await requestToken();
        if (!state()?.email) {
          const info = await (await api("https://openidconnect.googleapis.com/v1/userinfo")).json();
          setState({ email: info.email });
        }
        await sync();
      });
    },

    /** Call after every local change; uploads shortly after. */
    changed() {
      if (!this.enabled || !this.signedIn) return;
      setState({ dirty: true });
      clearTimeout(saveTimer);
      if (!token()) return status("needs-tap", "Changes not synced yet");
      status("syncing");
      saveTimer = setTimeout(() => run(sync), 800);
    },

    signOut() {
      const t = read(sessionStorage, TOKEN_KEY)?.access_token;
      if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
      write(sessionStorage, TOKEN_KEY, null);
      setState(null);
      status("signed-out");
    },
  };
}
