// Local store for user-dropped points and their photos. IndexedDB rather than
// localStorage: photos are blobs, and localStorage would both blow its quota
// and force a base64 round-trip on every read.
//
// Points hold lat/lng, never pixels. Pixels are derived through the current
// calibration at draw time, so recalibrating or replacing the map artwork
// moves everyone's saved points to the right place instead of stranding them.
const Store = (() => {
  const DB = 'nv-store';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise !== null) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const points = db.createObjectStore('points', { keyPath: 'id' });
        // Received points carry the id of the bundle they arrived in, so a
        // whole share can be listed and dropped as one unit.
        points.createIndex('bundleId', 'bundleId');
        db.createObjectStore('photos', { keyPath: 'id' });
        db.createObjectStore('bundles', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`IndexedDB open failed: ${req.error.message}`));
    });
    return dbPromise;
  }

  function run(stores, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const out = work(...stores.map((s) => tx.objectStore(s)));
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(new Error(`IndexedDB ${mode} failed: ${tx.error.message}`));
      tx.onabort = () => reject(new Error(`IndexedDB ${mode} aborted: ${tx.error === null ? 'unknown reason' : tx.error.message}`));
    }));
  }

  function asList(store) {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`IndexedDB read failed: ${req.error.message}`));
    });
  }

  function asOne(store, key) {
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`IndexedDB read failed: ${req.error.message}`));
    });
  }

  // One transaction, one pass: the sharing screen needs points, bundles and
  // nothing else, and asking three times is three times the work.
  async function load() {
    const [points, bundles] = await run(['points', 'bundles'], 'readonly', (p, b) => [asList(p), asList(b)]);
    return { points: await points, bundles: await bundles };
  }

  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  async function putPoint(point) {
    await run(['points'], 'readwrite', (p) => p.put(point));
    return point;
  }

  async function putPhoto(id, blob) {
    await run(['photos'], 'readwrite', (p) => p.put({ id, blob }));
    return id;
  }

  async function getPhoto(id) {
    const rec = await run(['photos'], 'readonly', (p) => asOne(p, id));
    const found = await rec;
    if (found === undefined) return null;
    return found.blob;
  }

  async function deletePoint(point) {
    await run(['points', 'photos'], 'readwrite', (p, ph) => {
      p.delete(point.id);
      if (point.photoId !== null) ph.delete(point.photoId);
    });
  }

  // A received share lands as one write: its bundle row, its points and its
  // photos together, so a half-imported bundle can't survive a dropped tab.
  async function addBundle(bundle, points, photos) {
    await run(['points', 'photos', 'bundles'], 'readwrite', (p, ph, b) => {
      b.put(bundle);
      for (const point of points) p.put(point);
      for (const photo of photos) ph.put(photo);
    });
  }

  // Deleting a share takes its points and their photos with it.
  async function deleteBundle(id) {
    const db = await open();
    const points = await new Promise((resolve, reject) => {
      const req = db.transaction('points', 'readonly').objectStore('points').index('bundleId').getAll(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`IndexedDB read failed: ${req.error.message}`));
    });
    await run(['points', 'photos', 'bundles'], 'readwrite', (p, ph, b) => {
      for (const point of points) {
        p.delete(point.id);
        if (point.photoId !== null) ph.delete(point.photoId);
      }
      b.delete(id);
    });
    return points.length;
  }

  return { load, newId, putPoint, putPhoto, getPhoto, deletePoint, addBundle, deleteBundle };
})();
