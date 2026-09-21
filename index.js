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
const EVENTS_TAB = process.env.SCHEDULE_EVENTS_TAB === undefined ? 'Events' : process.env.SCHEDULE_EVENTS_TAB;
const TRACKS_TAB = process.env.SCHEDULE_TRACKS_TAB;
const EVENTS_CSV_URL = process.env.SCHEDULE_EVENTS_CSV_URL;
const TRACKS_CSV_URL = process.env.SCHEDULE_TRACKS_CSV_URL;
const SHEET_TTL_MS = 60000;
let sheetCache = null;
let tokenCache = null;

// The metadata server is only reachable from inside Cloud Run, which is the
// point: no credentials are stored, shipped, or rotatable-by-mistake.
// spreadsheets.readonly is asked for explicitly -- the default
// cloud-platform token is not a scope the Sheets API accepts.
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-account/default/token'
  + '?scopes=https://www.googleapis.com/auth/spreadsheets.readonly';

async function accessToken() {
  if (tokenCache !== null && Date.now() < tokenCache.expires) return tokenCache.token;
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) {
    throw new Error(`Could not get a service-account token (${res.status}). This path only works on Cloud Run.`);
  }
  const body = await res.json();
  // A minute of headroom, so a token never expires mid-request.
  tokenCache = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function fetchSheetTab(tab) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}`
    + `/values/${encodeURIComponent(tab)}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 403) {
    throw new Error(`The service account cannot read this sheet. Share the sheet with it as Viewer, and enable the Sheets API. (tab "${tab}")`);
  }
  if (res.status === 404) {
    throw new Error(`No sheet ${SHEET_ID} with a tab named "${tab}".`);
  }
  if (!res.ok) throw new Error(`Sheets API said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.values === undefined || body.values.length === 0) {
    throw new Error(`Tab "${tab}" is empty. The first row must be the header: id, title, track, day, start, end, note.`);
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

async function buildSchedule() {
  const base = JSON.parse(FILES.get('schedule.json').body.toString('utf8'));
  const rows = await readEvents();
  const events = rows.map((r) => {
    const event = {
      id: r.id,
      title: r.title,
      track: orNull(r.track),
      day: orNull(r.day),
      start: orNull(r.start),
      end: orNull(r.end)
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

  const schedule = { festival: base.festival, days: base.days, tracks, events };
  const version = crypto.createHash('sha256').update(JSON.stringify(schedule)).digest('hex').slice(0, 12);
  return { version, schedule, at: Date.now() };
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
        if (req.query.check === '1') res.json({ version: sheet.version, at: sheet.at });
        else res.json({ version: sheet.version, at: sheet.at, schedule: sheet.schedule });
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
