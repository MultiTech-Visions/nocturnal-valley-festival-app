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
