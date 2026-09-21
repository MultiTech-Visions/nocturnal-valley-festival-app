// Local store for user-dropped points and their photos. IndexedDB rather than
// localStorage: photos are blobs, and localStorage would both blow its quota
// and force a base64 round-trip on every read.
//
// Points hold lat/lng, never pixels. Pixels are derived through the current
// calibration at draw time, so recalibrating or replacing the map artwork
// moves everyone's saved points to the right place instead of stranding them.
const Store = (() => {
  const DB = 'nv-store';
  const VERSION = 3;
  let dbPromise = null;

  function open() {
    if (dbPromise !== null) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      // Guarded per store, not per version: a phone upgrading from 1 and a
      // phone installing fresh both run this, and only the missing stores
      // should be created.
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('points')) {
          // Received points carry the id of the bundle they arrived in, so a
          // whole share can be listed and dropped as one unit.
          db.createObjectStore('points', { keyPath: 'id' }).createIndex('bundleId', 'bundleId');
        }
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('bundles')) db.createObjectStore('bundles', { keyPath: 'id' });
        // v2: the schedule. favorites are this phone's own picks; setlists
        // are other people's, kept whole so a friend's plan can be shown
        // alongside yours and dropped in one go.
        if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'eventId' });
        if (!db.objectStoreNames.contains('setlists')) db.createObjectStore('setlists', { keyPath: 'id' });
        // v3: edits to the published schedule, and the last schedule pulled
        // from the cloud. An override is a patch over one event, never a
        // copy of it, so a later sync still wins on everything untouched.
        if (!db.objectStoreNames.contains('overrides')) db.createObjectStore('overrides', { keyPath: 'eventId' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
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

  // One transaction, one pass. Everything the map and the schedule need to
  // render comes back together rather than in four separate round trips.
  async function load() {
    const out = await run(['points', 'bundles', 'favorites', 'setlists', 'overrides', 'meta'], 'readonly',
      (p, b, f, s, o, m) => [asList(p), asList(b), asList(f), asList(s), asList(o), asOne(m, 'schedule')]);
    const [points, bundles, favorites, setlists, overrides, schedule] = await Promise.all(out);
    return {
      points,
      bundles,
      favorites: favorites.map((f) => f.eventId),
      setlists,
      overrides,
      // undefined until a cloud sync has ever happened on this phone.
      cloud: schedule === undefined ? null : schedule
    };
  }

  async function putOverride(override) {
    await run(['overrides'], 'readwrite', (o) => o.put(override));
    return override;
  }

  async function deleteOverride(eventId) {
    await run(['overrides'], 'readwrite', (o) => o.delete(eventId));
  }

  async function putOverrides(list) {
    await run(['overrides'], 'readwrite', (o) => {
      for (const override of list) o.put(override);
    });
  }

  // The last schedule pulled from the sheet, kept whole so the app opens on
  // it offline instead of falling back to whatever shipped in the build.
  async function putCloudSchedule(version, at, schedule) {
    await run(['meta'], 'readwrite', (m) => m.put({ key: 'schedule', version, at, schedule }));
  }

  // Returns the state it left the event in, so a caller can repaint one star
  // without reloading the whole store.
  async function toggleFavorite(eventId, on) {
    await run(['favorites'], 'readwrite', (f) => (on ? f.put({ eventId }) : f.delete(eventId)));
    return on;
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
  async function addBundle(bundle, points, photos, setlist) {
    await run(['points', 'photos', 'bundles', 'setlists'], 'readwrite', (p, ph, b, s) => {
      b.put(bundle);
      for (const point of points) p.put(point);
      for (const photo of photos) ph.put(photo);
      // A share can carry points, a setlist, or both; the bundle row is what
      // ties them together so one "delete all" removes the lot.
      if (setlist !== null) s.put(setlist);
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
    await run(['points', 'photos', 'bundles', 'setlists'], 'readwrite', (p, ph, b, s) => {
      for (const point of points) {
        p.delete(point.id);
        if (point.photoId !== null) ph.delete(point.photoId);
      }
      s.delete(id);
      b.delete(id);
    });
    return points.length;
  }

  return {
    load, newId, putPoint, putPhoto, getPhoto, deletePoint, toggleFavorite,
    putOverride, deleteOverride, putOverrides, putCloudSchedule,
    addBundle, deleteBundle
  };
})();
