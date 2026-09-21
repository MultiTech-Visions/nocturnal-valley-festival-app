const functions = require('@google-cloud/functions-framework');
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
