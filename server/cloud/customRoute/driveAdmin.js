/**
 * HEXSign Drive — connect the platform to a Google Drive / Shared drive.
 *
 * Served by the platform's own server, so nothing extra needs to run:
 *   GET  /drive-admin        the page (styled like the platform)
 *   GET  /drive/status       connection + last sync
 *   POST /drive/sync         run a sync now
 *   POST /drive/connect      save credentials + target
 *   POST /drive/disconnect   forget the connection
 *
 * Every API call needs a valid Parse session token (X-Parse-Session-Token),
 * the same token the signed-in platform session already holds.
 *
 * The mirror is one-way and additive: new/changed files are uploaded, nothing
 * on the Drive is ever deleted and files added there are never removed.
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const FILES_DIR = process.env.DRIVE_FILES_DIR || '/usr/src/app/files/files';
const SYNC_INTERVAL_MS = Number(process.env.DRIVE_INTERVAL_SECONDS || 600) * 1000;
const CONFIG_CLASS = 'hexsign_DriveConfig';
const CONFIG_ROW = 'default';
const SCOPE = 'https://www.googleapis.com/auth/drive';

/* ------------------------------------------------------------------ config */

const ConfigObject = () =>
  Parse.Object.extend(CONFIG_CLASS);

async function loadConfig() {
  const q = new Parse.Query(ConfigObject());
  q.equalTo('rowKey', CONFIG_ROW);
  const res = await q.first({ useMasterKey: true });
  return res || null;
}

async function saveConfig(fields) {
  let obj = await loadConfig();
  if (!obj) {
    const Cls = ConfigObject();
    obj = new Cls();
    obj.set('rowKey', CONFIG_ROW);
  }
  Object.entries(fields).forEach(([k, v]) => obj.set(k, v));
  await obj.save(null, { useMasterKey: true });
  return obj;
}

/* ------------------------------------------------------------------ google */

async function tokenFromRefreshToken(cred) {
  const body = new URLSearchParams({
    client_id: cred.client_id,
    client_secret: cred.client_secret,
    refresh_token: cred.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'token refresh failed');
  return j.access_token;
}

async function tokenFromServiceAccount(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key).toString('base64url');
  const assertion = `${unsigned}.${signature}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'service account auth failed');
  return j.access_token;
}

async function accessToken(cfg) {
  const cred = cfg.credentials;
  if (cred.type === 'service_account') return tokenFromServiceAccount(cred);
  if (cred.refresh_token) return tokenFromRefreshToken(cred);
  throw new Error('credentials are neither a service account nor an OAuth refresh token');
}

const api = (token, url, init = {}) =>
  fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });

async function resolveDrive(token, cfg) {
  if (cfg.driveId) return cfg.driveId;
  if (!cfg.driveName) return null;
  const r = await api(token, 'https://www.googleapis.com/drive/v3/drives?pageSize=100');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'cannot list shared drives');
  const hit = (j.drives || []).find(
    d => d.name.trim().toLowerCase() === cfg.driveName.trim().toLowerCase()
  );
  if (!hit) throw new Error(`shared drive "${cfg.driveName}" not found or not shared with this account`);
  return hit.id;
}

async function ensureFolder(token, driveId, name, parentId) {
  let q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({
    q,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    fields: 'files(id,name)',
    pageSize: '10',
  });
  if (driveId) {
    params.set('corpora', 'drive');
    params.set('driveId', driveId);
  }
  const r = await api(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'cannot look up folder');
  if (j.files?.length) return j.files[0].id;

  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  if (driveId) body.driveId = driveId;
  const c = await api(token, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const cj = await c.json();
  if (!c.ok) throw new Error(cj.error?.message || 'cannot create folder');
  return cj.id;
}

async function remoteIndex(token, driveId, folderIds) {
  const out = new Map();
  for (const [label, fid] of Object.entries(folderIds)) {
    if (!fid) continue;
    let pageToken = null;
    do {
      const params = new URLSearchParams({
        q: `'${fid}' in parents and trashed = false`,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        fields: 'nextPageToken, files(id,name,size,md5Checksum)',
        pageSize: '200',
      });
      if (driveId) {
        params.set('corpora', 'drive');
        params.set('driveId', driveId);
      }
      if (pageToken) params.set('pageToken', pageToken);
      const r = await api(token, `https://www.googleapis.com/drive/v3/files?${params}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'cannot list folder contents');
      (j.files || []).forEach(f => out.set(f.name, { id: f.id, size: Number(f.size || 0), md5: f.md5Checksum, folder: label }));
      pageToken = j.nextPageToken;
    } while (pageToken);
  }
  return out;
}

async function uploadFile(token, folderId, name, filePath, existingId) {
  const buf = fs.readFileSync(filePath);
  if (existingId) {
    const r = await api(
      token,
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&supportsAllDrives=true`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: buf }
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error?.message || 'update failed');
    }
    return 'updated';
  }
  const boundary = 'hexsign' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await api(
    token,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  );
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error?.message || 'upload failed');
  }
  return 'uploaded';
}

/* -------------------------------------------------------------------- sync */

let syncing = false;

async function runSync({ trigger = 'manual' } = {}) {
  const cfgObj = await loadConfig();
  if (!cfgObj) throw new Error('drive is not connected');
  const cfg = {
    credentials: cfgObj.get('credentials'),
    driveId: cfgObj.get('driveId'),
    driveName: cfgObj.get('driveName'),
    folders: cfgObj.get('folders') || ['Documents', 'Signed'],
  };
  if (!cfg.credentials) throw new Error('drive is not connected');

  if (syncing) return { skipped: true, reason: 'a sync is already running' };
  syncing = true;
  const started = new Date();
  try {
    const token = await accessToken(cfg);
    const driveId = await resolveDrive(token, cfg);
    const folderIds = {};
    for (const name of cfg.folders) folderIds[name] = await ensureFolder(token, driveId, name);

    const local = fs.existsSync(FILES_DIR)
      ? fs.readdirSync(FILES_DIR).filter(n => fs.statSync(path.join(FILES_DIR, n)).isFile())
      : [];
    const remote = await remoteIndex(token, driveId, folderIds);

    let uploaded = 0;
    let unchanged = 0;
    const errors = [];
    for (const name of local.sort()) {
      const filePath = path.join(FILES_DIR, name);
      const stat = fs.statSync(filePath);
      const have = remote.get(name);
      if (have && have.size === stat.size) {
        unchanged++;
        continue;
      }
      const target = cfg.folders.length > 1 && /signed/i.test(name) ? cfg.folders[1] : cfg.folders[0];
      try {
        await uploadFile(token, folderIds[target], name, filePath, have?.id);
        uploaded++;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }

    const result = {
      at: started.toISOString(),
      trigger,
      local: local.length,
      remote: remote.size,
      uploaded,
      unchanged,
      failed: errors.length,
      errors: errors.slice(0, 10),
    };
    await cfgObj.save(
      { lastRun: started, lastResult: JSON.stringify(result), lastOk: errors.length === 0 },
      { useMasterKey: true }
    );
    return result;
  } finally {
    syncing = false;
  }
}

let workerHandle = null;
async function startWorker() {
  if (workerHandle) return;
  try {
    const cfg = await loadConfig();
    if (!cfg?.get('credentials')) {
      // stays idle until a connection is saved; /drive/connect calls startWorker again
      return;
    }
    console.log(`[drive] worker started, every ${SYNC_INTERVAL_MS / 1000}s`);
    workerHandle = setInterval(() => {
      runSync({ trigger: 'schedule' }).catch(e => console.error('[drive] sync failed:', e.message));
    }, SYNC_INTERVAL_MS);
    workerHandle.unref?.();
  } catch (e) {
    console.error('[drive] worker start failed:', e.message);
  }
}

/* ------------------------------------------------------------------- routes */

const router = express.Router();

async function requireSession(req, res) {
  const token = req.get('X-Parse-Session-Token');
  if (!token) {
    res.status(401).json({ error: 'not signed in' });
    return null;
  }
  const q = new Parse.Query(Parse.Session);
  q.equalTo('sessionToken', token);
  q.include('user');
  const session = await q.first({ useMasterKey: true });
  if (!session) {
    res.status(401).json({ error: 'session expired — sign in again' });
    return null;
  }
  return session;
}

router.get('/drive/status', async (req, res) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;
    const cfg = await loadConfig();
    if (!cfg?.get('credentials')) return res.json({ connected: false });
    const cred = cfg.get('credentials');
    res.json({
      connected: true,
      account: cred.client_email || cred.client_id || 'connected',
      mode: cred.type === 'service_account' ? 'service account' : 'Google account',
      driveName: cfg.get('driveName') || cfg.get('driveId') || '(default drive)',
      folders: cfg.get('folders') || ['Documents', 'Signed'],
      lastRun: cfg.get('lastRun') || null,
      lastResult: cfg.get('lastResult') ? JSON.parse(cfg.get('lastResult')) : null,
      lastOk: cfg.get('lastOk'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/drive/sync', async (req, res) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;
    const result = await runSync({ trigger: 'manual' });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/drive/connect', async (req, res) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;
    const { credentials, driveName, driveId, folders } = req.body || {};
    let cred = credentials;
    if (typeof cred === 'string') {
      try {
        cred = JSON.parse(cred);
      } catch (e) {
        return res.status(400).json({ error: 'credentials are not valid JSON' });
      }
    }
    if (!cred) return res.status(400).json({ error: 'credentials are required' });
    if (cred.type !== 'service_account' && !cred.refresh_token) {
      return res.status(400).json({ error: 'need a service-account key or an OAuth token with refresh_token' });
    }
    const folderList = (folders || 'Documents,Signed')
      .split(',').map(s => s.trim()).filter(Boolean);

    // prove the credentials work before saving them
    const token = await accessToken({ credentials: cred });
    const id = await resolveDrive(token, { driveId, driveName });
    for (const name of folderList) await ensureFolder(token, id, name);

    await saveConfig({
      credentials: cred,
      driveId: id,
      driveName: driveName || null,
      folders: folderList,
      connectedAt: new Date(),
      lastResult: '',
      lastOk: false,
    });
    startWorker();
    res.json({ ok: true, driveId: id, folders: folderList });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/drive/disconnect', async (req, res) => {
  try {
    const session = await requireSession(req, res);
    if (!session) return;
    const cfg = await loadConfig();
    if (cfg) {
      await cfg.save({ credentials: null, driveId: null, driveName: null, lastResult: '' }, { useMasterKey: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/drive-admin', (req, res) => res.type('html').send(PAGE));

/* --------------------------------------------------------------------- page */

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drive connection · HEXSign</title>
<link rel="icon" href="/favicon.ico">
<style>
 :root{--navy:#112366;--orange:#E8603C}
 *{box-sizing:border-box}
 body{margin:0;font:15px/1.6 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2430;background:#f4f5f7}
 .wrap{max-width:760px;margin:0 auto;padding:28px 18px 60px}
 .brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
 .brand img{height:42px}
 .card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(17,35,102,.10);overflow:hidden;margin-bottom:18px}
 .bar{background:var(--navy);color:#fff;padding:14px 22px;font-weight:600}
 .body{padding:20px 22px}
 .row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #eef0f3;font-size:14px}
 .row:last-child{border-bottom:0}
 .k{color:#6b7280}
 .v{font-weight:600;text-align:right;word-break:break-word}
 .pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700}
 .on{background:#e7f6ef;color:#1c7a4d}.off{background:#fdeceb;color:#b4362c}
 button{font:inherit;font-weight:600;border:0;border-radius:7px;padding:11px 20px;cursor:pointer}
 .primary{background:var(--orange);color:#fff}
 .ghost{background:#eef1f6;color:var(--navy)}
 .danger{background:#fff;color:#b4362c;border:1px solid #f0c9c5}
 button:disabled{opacity:.55;cursor:not-allowed}
 label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
 input,textarea,select{width:100%;font:inherit;padding:10px 12px;border:1px solid #d6dae2;border-radius:7px;background:#fff}
 textarea{min-height:130px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
 .muted{color:#6b7280;font-size:13px}
 .msg{margin:14px 0;padding:11px 14px;border-radius:7px;font-size:14px;display:none}
 .msg.err{display:block;background:#fdeceb;color:#b4362c}
 .msg.ok{display:block;background:#e7f6ef;color:#1c7a4d}
 .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
 details{margin-top:18px}
 summary{cursor:pointer;font-weight:600;color:var(--navy);font-size:14px}
 code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:12.5px}
</style></head><body>
<div class="wrap">
  <div class="brand"><img src="/hexsign-logo.png" alt="HEXSign"></div>

  <div class="card">
    <div class="bar">Google Drive connection</div>
    <div class="body">
      <div id="status"><span class="muted">Checking…</span></div>
      <div id="msg" class="msg"></div>
      <div class="actions" id="actions"></div>
    </div>
  </div>

  <div class="card">
    <div class="bar">Connect or replace credentials</div>
    <div class="body">
      <p class="muted" style="margin-top:0">Paste a Google <strong>service-account key</strong> (recommended) or an OAuth token JSON that contains a
      <code>refresh_token</code>. The account must have access to the target drive.</p>
      <label for="cred">Credentials JSON</label>
      <textarea id="cred" placeholder='{"type":"service_account","client_email":"…","private_key":"…"}'></textarea>
      <label for="drive">Shared drive name <span class="muted">(leave blank for My Drive)</span></label>
      <input id="drive" placeholder="HEXSign">
      <label for="folders">Folders to keep</label>
      <input id="folders" value="Documents,Signed">
      <div class="actions">
        <button class="primary" id="btnConnect">Connect drive</button>
      </div>
      <details><summary>How to get a service-account key</summary>
        <p class="muted">Google Cloud Console → IAM &amp; Admin → Service Accounts → create one → Keys → Add key → JSON.
        Then share the drive or Shared drive with that address as <strong>Content manager</strong>.
        Full steps are in <code>docs/DRIVE.md</code> in the repository.</p>
      </details>
    </div>
  </div>
</div>
<script>
(function(){
  var msg=document.getElementById('msg'), statusEl=document.getElementById('status'), actions=document.getElementById('actions');
  function token(){
    try{
      for(var i=0;i<localStorage.length;i++){
        var k=localStorage.key(i);
        if(/currentUser$/.test(k)){
          var u=JSON.parse(localStorage.getItem(k)||'{}');
          if(u && u.sessionToken) return u.sessionToken;
        }
      }
    }catch(e){}
    return null;
  }
  function say(text, kind){ msg.className='msg '+(kind||''); msg.textContent=text; }
  function api(pathname, opts){
    opts=opts||{};
    opts.headers=Object.assign({'Content-Type':'application/json','X-Parse-Session-Token':token()||''}, opts.headers||{});
    return fetch('/api/drive'+pathname, opts).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); });
  }
  function row(k,v){ return '<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>'; }
  function render(s){
    if(!s.connected){
      statusEl.innerHTML='<div class="row"><span class="k">Status</span><span class="v"><span class="pill off">Not connected</span></span></div>'+
        '<p class="muted" style="margin-bottom:0">Documents stay inside the platform. Connect a drive below to mirror them.</p>';
      actions.innerHTML='';
      return;
    }
    var lr=s.lastResult;
    var last='never';
    if(lr){ last=lr.at? new Date(lr.at).toLocaleString():'—'; }
    var detail = lr ? ('uploaded '+lr.uploaded+', unchanged '+lr.unchanged+(lr.failed?', failed '+lr.failed:'')) : '—';
    statusEl.innerHTML =
      '<div class="row"><span class="k">Status</span><span class="v"><span class="pill on">Connected</span></span></div>'+
      row('Account', s.account)+
      row('Mode', s.mode)+
      row('Drive', s.driveName)+
      row('Folders', (s.folders||[]).join(', '))+
      row('Last sync', last)+
      row('Last result', detail);
    actions.innerHTML =
      '<button class="primary" id="btnSync">Sync now</button>'+
      '<button class="ghost" id="btnRefresh">Refresh</button>'+
      '<button class="danger" id="btnDisconnect">Disconnect</button>';
    document.getElementById('btnSync').onclick=function(){
      this.disabled=true; say('Syncing…','ok');
      api('/sync',{method:'POST'}).then(function(j){
        say('Sync finished — uploaded '+j.result.uploaded+', unchanged '+j.result.unchanged+(j.result.failed?', failed '+j.result.failed:''),'ok');
        load();
      }).catch(function(e){ say(e.message,'err'); }).finally(function(){ });
    };
    document.getElementById('btnRefresh').onclick=load;
    document.getElementById('btnDisconnect').onclick=function(){
      if(!confirm('Disconnect the drive? Documents stay in the platform; the mirror stops.')) return;
      api('/disconnect',{method:'POST'}).then(function(){ say('Disconnected.','ok'); load(); }).catch(function(e){ say(e.message,'err'); });
    };
  }
  function load(){
    api('/status').then(render).catch(function(e){
      statusEl.innerHTML='<span class="pill off">Not available</span>';
      say(e.message,'err');
    });
  }
  document.getElementById('btnConnect').onclick=function(){
    var btn=this, cred=document.getElementById('cred').value.trim();
    if(!cred){ say('Paste the credentials JSON first.','err'); return; }
    btn.disabled=true; say('Checking the credentials with Google…','ok');
    api('/connect',{method:'POST',body:JSON.stringify({
      credentials: cred,
      driveName: document.getElementById('drive').value.trim()||null,
      folders: document.getElementById('folders').value
    })}).then(function(j){
      say('Connected to '+ (j.driveId||'drive') +'. Folders ready: '+j.folders.join(', '),'ok');
      document.getElementById('cred').value='';
      load();
    }).catch(function(e){ say(e.message,'err'); }).finally(function(){ btn.disabled=false; });
  };
  load();
})();
</script></body></html>`;

/* ------------------------------------------------------------------- boot */

// start the background worker shortly after the server is up
setTimeout(() => { startWorker().catch(() => {}); }, 8000);

export default router;
