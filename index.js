const functions = require('@google-cloud/functions-framework');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

// Read every file in /public once at cold start. Unknown extensions or
// subfolders throw here so a bad deploy fails loudly instead of 404ing later.
const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES = new Map();
for (const name of fs.readdirSync(PUBLIC_DIR)) {
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type) throw new Error(`No content-type mapping for public/${name}`);
  FILES.set(name, { type, body: fs.readFileSync(path.join(PUBLIC_DIR, name)) });
}

// Binary assets can't be uploaded through the Cloud Run editor, so they live
// base64-encoded in images.json and are served under /public/<name>.
const IMAGES = JSON.parse(fs.readFileSync(path.join(__dirname, 'images.json'), 'utf8'));
for (const [name, b64] of Object.entries(IMAGES)) {
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type) throw new Error(`No content-type mapping for images.json entry ${name}`);
  if (FILES.has(name)) throw new Error(`images.json entry ${name} collides with public/${name}`);
  FILES.set(name, { type, body: Buffer.from(b64, 'base64') });
}

// The calibration tool is staff-only. Both halves of the login come from env
// vars; an unset or empty value throws at cold start so a misconfigured deploy
// fails loudly instead of serving the tool open. Basic auth always prompts for
// a username, so there is no blank-username option to fall back on.
function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} is not set; the calibration page cannot be served.`);
  }
  return value;
}
const CALIBRATE_USER = requiredEnv('CALIBRATE_USER');
const CALIBRATE_PASSWORD = requiredEnv('CALIBRATE_PASSWORD');
const EXPECTED_AUTH = Buffer.from(
  `Basic ${Buffer.from(`${CALIBRATE_USER}:${CALIBRATE_PASSWORD}`).toString('base64')}`
);

// Length-independent constant-time compare: hash both sides so a wrong-length
// header can't be distinguished from a wrong-password one by timing.
function authOk(header) {
  if (typeof header !== 'string') return false;
  const a = crypto.createHash('sha256').update(header).digest();
  const b = crypto.createHash('sha256').update(EXPECTED_AUTH).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Live schedule from a Google Sheet.
//
// Set times change on site and a redeploy is not a thing anyone wants to do
// from a field. Publish a sheet to the web as CSV, put its URL in
// SCHEDULE_EVENTS_CSV_URL, and this endpoint turns it into the same shape as
// public/schedule.json. Phones with signal can pull it; phones without keep
// the copy they already have.
//
// Both URLs are optional: with neither set the endpoint reports that it is
// not configured rather than pretending, and the app falls back to the
// bundled file.
// Two ways in, preferred first:
//
// SCHEDULE_SHEET_ID  - a private sheet shared with this service's own
//                      service account. Nothing is published to the web and
//                      no key file exists anywhere: Cloud Run's metadata
//                      server mints a token, the Sheets REST API takes it.
// SCHEDULE_EVENTS_CSV_URL - a sheet published to the web as CSV. Simpler to
//                      set up, but the URL is readable by anyone who has it.
const SHEET_ID = process.env.SCHEDULE_SHEET_ID;
const EVENTS_TAB = process.env.SCHEDULE_EVENTS_TAB;
const TRACKS_TAB = process.env.SCHEDULE_TRACKS_TAB;
// Optional tabs the automation writes to. Absent means nobody has set them
// up yet, which is different from a fetch that failed.
const ANNOUNCEMENTS_TAB = process.env.SCHEDULE_ANNOUNCEMENTS_TAB === undefined ? 'Announcements' : process.env.SCHEDULE_ANNOUNCEMENTS_TAB;
const CHANGES_TAB = process.env.SCHEDULE_CHANGES_TAB === undefined ? 'Changes' : process.env.SCHEDULE_CHANGES_TAB;
const EVENTS_CSV_URL = process.env.SCHEDULE_EVENTS_CSV_URL;
const TRACKS_CSV_URL = process.env.SCHEDULE_TRACKS_CSV_URL;
const SHEET_TTL_MS = 60000;
let sheetCache = null;
let tokenCache = null;

// The metadata server is only reachable from inside Cloud Run, which is the
// point: no credentials are stored, shipped, or rotatable-by-mistake.
// spreadsheets.readonly is asked for explicitly -- the default
// cloud-platform token is not a scope the Sheets API accepts.
// Metadata lives behind a link-local address. The DNS name is the documented
// way in, the numeric address is what the name resolves to and keeps working
// when DNS inside the container does not. Scoped first, because a narrow
// token is better; the service's default token second, because some
// platforms reject the ?scopes= form outright.
const METADATA_HOSTS = ['http://metadata.google.internal', 'http://169.254.169.254'];
const TOKEN_PATH = '/computeMetadata/v1/instance/service-account/default/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function tokenAttempts() {
  const out = [];
  for (const host of METADATA_HOSTS) {
    out.push({ label: `${host} scoped`, url: `${host}${TOKEN_PATH}?scopes=${SHEETS_SCOPE}` });
    out.push({ label: `${host} default`, url: `${host}${TOKEN_PATH}` });
  }
  return out;
}

// Reports what each attempt actually did rather than collapsing them all to
// one number, because "404" alone gave no way to tell a wrong path from a
// wrong host from no metadata server at all.
async function probeToken() {
  const results = [];
  for (const attempt of tokenAttempts()) {
    try {
      const res = await fetch(attempt.url, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000)
      });
      const body = await res.text();
      results.push({
        ...attempt,
        status: res.status,
        ok: res.ok,
        // Never the token itself; just enough to tell a real one apart.
        detail: res.ok ? `token of ${body.length} bytes` : body.slice(0, 160)
      });
    } catch (err) {
      results.push({ ...attempt, status: 0, ok: false, detail: `${err.name}: ${err.message}` });
    }
  }
  return results;
}

// A service-account key, straight from config. This needs no metadata
// server, no Cloud Run, and no publishing: the server signs its own
// assertion with the key and trades it for an access token. It is the route
// that works when the platform will not hand one over.
const SA_KEY_RAW = process.env.SCHEDULE_SA_KEY;
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function serviceAccountKey() {
  if (SA_KEY_RAW === undefined) return null;
  let key;
  try {
    // Pasted into a console, a key often arrives base64'd to survive the
    // newlines in its private key. Accept either form.
    const text = SA_KEY_RAW.trim().startsWith('{')
      ? SA_KEY_RAW
      : Buffer.from(SA_KEY_RAW, 'base64').toString('utf8');
    key = JSON.parse(text);
  } catch (err) {
    throw new Error(`SCHEDULE_SA_KEY is not a service-account JSON key: ${err.message}`);
  }
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
    throw new Error('SCHEDULE_SA_KEY is missing client_email or private_key. Paste the whole JSON key file.');
  }
  return key;
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The JWT bearer flow, by hand. Three base64url segments, the third an
// RS256 signature over the first two, traded at Google's token endpoint.
async function tokenFromKey(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SHEETS_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signature = b64url(
    crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key.private_key)
  );

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`
    })
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Google refused the key (${body.error}: ${body.error_description}). `
      + 'Check the key is current and the Sheets API is enabled for its project.');
  }
  return { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
}

let tokenAttemptIndex = 0;

async function accessToken() {
  if (tokenCache !== null && Date.now() < tokenCache.expires) return tokenCache.token;

  // A key in config beats asking the platform, because it cannot be refused.
  const key = serviceAccountKey();
  if (key !== null) {
    tokenCache = await tokenFromKey(key);
    return tokenCache.token;
  }

  const attempts = tokenAttempts();
  const tried = [];
  for (let i = 0; i < attempts.length; i++) {
    const at = (tokenAttemptIndex + i) % attempts.length;
    const attempt = attempts[at];
    try {
      const res = await fetch(attempt.url, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const body = await res.json();
        tokenAttemptIndex = at;
        // A minute of headroom, so a token never expires mid-request.
        tokenCache = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
        return tokenCache.token;
      }
      tried.push(`${attempt.label}:${res.status}`);
    } catch (err) {
      tried.push(`${attempt.label}:${err.name}`);
    }
  }
  throw new Error(`No service-account token from the metadata server (${tried.join('; ')}). `
    + 'Set SCHEDULE_SA_KEY to a service-account JSON key and none of this matters. /api/diag shows each attempt.');
}

// tab undefined means "the first sheet, whatever it is named": a range with
// no sheet prefix is how the API expresses that.
async function fetchSheetTab(tab) {
  const range = tab === undefined ? 'A:Z' : `${tab}!A:Z`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}`
    + `/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 403) {
    const body = (await res.text()).slice(0, 300);
    const scopeProblem = body.includes('insufficient') || body.includes('scope');
    throw new Error(scopeProblem
      ? 'The token this service can mint is not accepted by the Sheets API. Grant the service account the Sheets scope, or use the published-CSV route instead.'
      : 'The service account cannot read this sheet. Share the sheet with it as Viewer, and enable the Sheets API.');
  }
  if (res.status === 404) {
    const err = new Error(tab === undefined ? `No sheet with id ${SHEET_ID}.` : `No sheet ${SHEET_ID} with a tab named "${tab}".`);
    err.missingTab = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Sheets API said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.values === undefined || body.values.length === 0) {
    const err = new Error('That sheet is empty. The first row must be the header: id, title, track, day, start, end, note.');
    err.missingTab = true;
    throw err;
  }
  // The API trims trailing empty cells per row, so short rows are padded
  // back out to the header width rather than losing their last columns.
  const width = body.values[0].length;
  const rows = body.values.map((r) => (r.length === width ? r : r.concat(new Array(width - r.length).fill(''))));
  return toObjects(rows);
}

// RFC 4180 enough for a spreadsheet export: quoted fields, embedded commas,
// doubled quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// First row is the header. Unknown columns are ignored, missing ones are
// absent rather than guessed at.
function toObjects(rows) {
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((key, i) => { o[key] = r[i] === undefined ? '' : r[i].trim(); });
    return o;
  });
}

const orNull = (v) => (v === undefined || v === '' ? null : v);

// Sheets treats anything past 24:00 as a duration and writes it back as
// "25:30:00". Both that and a plain "9:05" normalise to "HH:MM"; anything
// else is a typo worth surfacing rather than quietly dropping.
function normalizeTime(v, where) {
  if (v === undefined || v === '') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (m === null) throw new Error(`${where}: "${v}" is not a time. Use 21:30, and count on past midnight (25:30 is 1:30am).`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

async function fetchCsv(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw new Error('Sheet returned HTML, not CSV. Use File > Share > Publish to web and pick CSV.');
  }
  return toObjects(parseCsv(text));
}

const usingSheetApi = () => SHEET_ID !== undefined;
const scheduleConfigured = () => usingSheetApi() || EVENTS_CSV_URL !== undefined;

// Same row shape either way, so everything downstream is identical.
const readEvents = () => (usingSheetApi() ? fetchSheetTab(EVENTS_TAB) : fetchCsv(EVENTS_CSV_URL));

function readTracks() {
  if (usingSheetApi()) return TRACKS_TAB === undefined ? null : fetchSheetTab(TRACKS_TAB);
  return TRACKS_CSV_URL === undefined ? null : fetchCsv(TRACKS_CSV_URL);
}

// A tab the automation has not created yet is not a failure: the app should
// still get its schedule. Anything else still throws.
async function optionalTab(tab) {
  if (!usingSheetApi() || tab === '') return [];
  try {
    return await fetchSheetTab(tab);
  } catch (err) {
    if (err.missingTab === true) return [];
    throw err;
  }
}

// What the organisers posted, newest first, each carrying the edits it made
// so a phone can show "this moved from 11:30pm to 11:45pm" and so a wrong
// one can be put back.
async function readAnnouncements() {
  const [posts, changes] = await Promise.all([optionalTab(ANNOUNCEMENTS_TAB), optionalTab(CHANGES_TAB)]);
  const byPost = new Map();
  for (const c of changes) {
    if (c.announcementid === '') continue;
    if (!byPost.has(c.announcementid)) byPost.set(c.announcementid, []);
    byPost.get(c.announcementid).push({
      id: c.id,
      eventId: c.eventid,
      field: c.field,
      from: c.oldvalue,
      to: c.newvalue,
      status: c.status === '' ? 'applied' : c.status
    });
  }
  return posts
    .filter((p) => p.id !== '' && p.kind !== 'example')
    .map((p) => ({
      id: p.id,
      at: p.at,
      kind: p.kind === '' ? 'announcement' : p.kind,
      title: p.title,
      body: p.body,
      url: p.url,
      status: p.status === '' ? 'active' : p.status,
      revision: p.revision === '' ? 1 : Number(p.revision),
      changes: byPost.has(p.id) ? byPost.get(p.id) : []
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function buildSchedule() {
  const base = JSON.parse(FILES.get('schedule.json').body.toString('utf8'));
  const rows = await readEvents();
  const events = rows.map((r) => {
    const event = {
      id: r.id,
      title: r.title,
      track: orNull(r.track),
      day: orNull(r.day),
      start: normalizeTime(r.start, `Row ${r.id} start`),
      end: normalizeTime(r.end, `Row ${r.id} end`)
    };
    if (r.note !== undefined && r.note !== '') event.note = r.note;
    if (event.id === '' || event.title === '') {
      throw new Error(`Every row needs an id and a title; found id="${r.id}" title="${r.title}"`);
    }
    return event;
  });

  const trackRows = await readTracks();
  const tracks = trackRows === null ? base.tracks : trackRows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind === '' ? 'stage' : r.kind,
    sound: r.sound,
    color: r.color
  }));

  const announcements = await readAnnouncements();
  const schedule = { festival: base.festival, days: base.days, tracks, events };
  // Announcements are inside the hash, so posting one is itself a reason for
  // a phone to sync even when no set time moved.
  const version = crypto.createHash('sha256')
    .update(JSON.stringify({ schedule, announcements }))
    .digest('hex')
    .slice(0, 12);
  return { version, schedule, announcements, at: Date.now() };
}

async function getSheet() {
  if (sheetCache !== null && Date.now() - sheetCache.at < SHEET_TTL_MS) return sheetCache;
  sheetCache = await buildSchedule();
  return sheetCache;
}

// Paths that must live at root scope (service worker, manifest, pages).
const ROUTES = {
  '/': 'index.html',
  '/calibrate': 'calibrate.html',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest'
};

functions.http('app', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('Method not allowed');
    return;
  }

  if (req.path === '/calibrate' && !authOk(req.get('authorization'))) {
    res.set('WWW-Authenticate', 'Basic realm="Nocturnal Valley calibration", charset="UTF-8"');
    res.set('Cache-Control', 'no-store');
    res.status(401).send('Authentication required');
    return;
  }

  // What the sheet plumbing is actually doing, in one place, so a failure
  // can be read instead of guessed at. Nothing secret: statuses, error
  // names, and which env vars are set -- never their values.
  if (req.path === '/api/diag') {
    // With a key configured, the metadata server is irrelevant -- report
    // whether the key itself can mint a token instead.
    const keyProbe = async () => {
      if (SA_KEY_RAW === undefined) return 'SCHEDULE_SA_KEY not set';
      try {
        const got = await tokenFromKey(serviceAccountKey());
        return `works — token of ${got.token.length} chars`;
      } catch (err) {
        return `failed — ${err.message}`;
      }
    };
    Promise.all([probeToken(), keyProbe()])
      .then(([metadata, serviceAccountKeyResult]) => {
        res.set('Cache-Control', 'no-store');
        res.json({
          configured: {
            SCHEDULE_SHEET_ID: SHEET_ID === undefined ? 'not set' : `set (${SHEET_ID.length} chars)`,
            SCHEDULE_EVENTS_TAB: EVENTS_TAB === undefined ? 'not set (uses the first tab)' : EVENTS_TAB,
            SCHEDULE_EVENTS_CSV_URL: EVENTS_CSV_URL === undefined ? 'not set' : 'set',
            SCHEDULE_SA_KEY: SA_KEY_RAW === undefined ? 'not set' : `set (${SA_KEY_RAW.length} chars)`,
            K_SERVICE: process.env.K_SERVICE === undefined ? 'not set — this is not Cloud Run' : process.env.K_SERVICE,
            K_REVISION: process.env.K_REVISION === undefined ? 'not set' : process.env.K_REVISION
          },
          serviceAccountKey: serviceAccountKeyResult,
          metadata
        });
      })
      .catch((err) => res.status(500).json({ error: err.message }));
    return;
  }

  // ?check=1 answers with the version alone: a phone deciding whether a
  // sync is worth it should not pull the whole schedule to find out.
  if (req.path === '/api/schedule') {
    if (!scheduleConfigured()) {
      res.status(503).json({ error: 'No schedule sheet configured. Set SCHEDULE_SHEET_ID (preferred) or SCHEDULE_EVENTS_CSV_URL.' });
      return;
    }
    getSheet()
      .then((sheet) => {
        res.set('Cache-Control', 'no-store');
        // The check stays tiny, but carries enough for a bell to light up
        // without pulling the whole schedule.
        if (req.query.check === '1') {
          res.json({
            version: sheet.version,
            at: sheet.at,
            announcements: sheet.announcements.filter((a) => a.status !== 'reverted').length,
            latest: sheet.announcements.length === 0 ? null : sheet.announcements[0].id
          });
        }
        else res.json({ version: sheet.version, at: sheet.at, schedule: sheet.schedule, announcements: sheet.announcements });
      })
      .catch((err) => res.status(502).json({ error: err.message }));
    return;
  }

  let name = ROUTES[req.path];
  if (name === undefined && req.path.startsWith('/public/')) {
    name = req.path.slice('/public/'.length);
  }

  const file = name === undefined ? undefined : FILES.get(name);
  if (file === undefined) {
    res.status(404).send('Not found');
    return;
  }

  res.set('Content-Type', file.type);
  // The service worker owns offline caching; the browser HTTP cache must not
  // hold stale copies that would block a new SW version from installing.
  res.set('Cache-Control', 'no-cache');
  if (name === 'sw.js') res.set('Service-Worker-Allowed', '/');
  res.send(file.body);
});
