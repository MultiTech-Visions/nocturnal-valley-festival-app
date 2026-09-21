// User-dropped points and phone-to-phone sharing. Owns everything below the
// map: the drop/edit flow, the sharing sheet, and the QR transfer screens.
// app.js hands it a built Viewer and Geo and otherwise stays out of the way.
const PointsUI = (() => {
  const $ = (id) => document.getElementById(id);

  // Kept on the phone at a size worth looking at; shrunk hard for transfer,
  // where every kilobyte is another QR frame to hold the camera through.
  const KEEP = { px: 1280, quality: 0.72 };
  const SEND = { px: 320, quality: 0.5 };

  let viewer = null;
  let geo = null;
  let state = { points: [], bundles: [] };
  let dropping = false;
  let editing = null;
  let pendingPhoto = null;
  let stopPlaying = null;
  let scanAbort = null;
  let wakeLock = null;

  const els = {};

  function show(panel) {
    for (const p of document.querySelectorAll('.sheet')) p.hidden = p.id !== panel;
    els.scrim.hidden = panel === null;
  }

  function status(msg) {
    els.hint.textContent = msg;
  }

  // ---------- Drawing ----------
  function draw() {
    for (const key of [...viewer.markers.keys()]) {
      if (key.startsWith('cp-')) viewer.removeMarker(key);
    }
    for (const pt of state.points) {
      const p = geo.project(pt.lat, pt.lng);
      if (p.x < 0 || p.y < 0 || p.x > viewer.iw || p.y > viewer.ih) continue;
      const el = document.createElement('div');
      el.className = `pin${pt.bundleId === null ? '' : ' shared'}`;
      el.innerHTML = '<span class="pin-head"></span>';
      const tag = document.createElement('span');
      tag.className = 'pin-label';
      tag.textContent = pt.label;
      el.appendChild(tag);
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        openDetail(pt);
      });
      viewer.setMarker(`cp-${pt.id}`, { x: p.x, y: p.y, el });
    }
  }

  async function reload() {
    state = await Store.load();
    draw();
  }

  // ---------- Dropping ----------
  function arm() {
    dropping = !dropping;
    els.drop.classList.toggle('armed', dropping);
    els.drop.textContent = dropping ? 'Tap the map…' : 'Drop a point';
    status(dropping ? 'Tap where the landmark is.' : '');
  }

  // Called by app.js on every map tap; only acts while armed.
  function onMapTap(x, y) {
    if (!dropping) return;
    const here = geo.unproject(x, y);
    dropping = false;
    els.drop.classList.remove('armed');
    els.drop.textContent = 'Drop a point';
    status(here.inMesh ? '' : 'That spot is outside the calibrated area, so its location is a rough estimate.');
    openForm({ id: null, label: '', note: '', lat: here.lat, lng: here.lng, photoId: null, bundleId: null });
  }

  function openForm(point) {
    editing = point;
    pendingPhoto = null;
    els.label.value = point.label;
    els.note.value = point.note;
    els.photoName.textContent = point.photoId === null ? 'No photo' : 'Photo attached';
    els.photo.value = '';
    show('point-form');
    els.label.focus();
  }

  async function saveForm() {
    const label = els.label.value.trim();
    if (label === '') {
      els.label.focus();
      status('Give the point a name first.');
      return;
    }
    const point = {
      id: editing.id === null ? Store.newId() : editing.id,
      label,
      note: els.note.value.trim(),
      lat: editing.lat,
      lng: editing.lng,
      photoId: editing.photoId,
      bundleId: editing.bundleId,
      createdAt: Date.now()
    };
    if (pendingPhoto !== null) {
      point.photoId = point.photoId === null ? Store.newId() : point.photoId;
      await Store.putPhoto(point.photoId, pendingPhoto);
    }
    await Store.putPoint(point);
    show(null);
    await reload();
  }

  // ---------- Detail ----------
  async function openDetail(point) {
    editing = point;
    els.detailName.textContent = point.label;
    els.detailNote.textContent = point.note === '' ? 'No note' : point.note;
    els.detailOrigin.textContent = point.bundleId === null ? 'Yours' : 'Shared with you';
    els.detailPhoto.hidden = true;
    show('point-detail');
    if (point.photoId === null) return;
    const blob = await Store.getPhoto(point.photoId);
    if (blob === null) return;
    els.detailPhoto.src = URL.createObjectURL(blob);
    els.detailPhoto.hidden = false;
  }

  // ---------- Sharing ----------
  function renderShareList() {
    els.shareList.innerHTML = '';
    if (state.points.length === 0) {
      els.shareList.innerHTML = '<li class="empty">No points to share yet.</li>';
      return;
    }
    for (const pt of state.points) {
      const li = document.createElement('li');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.id = pt.id;
      const name = document.createElement('span');
      name.textContent = pt.label;
      const meta = document.createElement('span');
      meta.className = 'pt-meta';
      meta.textContent = pt.photoId === null ? '' : 'photo';
      li.append(box, name, meta);
      els.shareList.appendChild(li);
    }
  }

  function renderBundles() {
    els.bundleList.innerHTML = '';
    if (state.bundles.length === 0) {
      els.bundleList.innerHTML = '<li class="empty">Nothing received yet.</li>';
      return;
    }
    for (const b of state.bundles) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = b.name;
      const meta = document.createElement('span');
      meta.className = 'pt-meta';
      meta.textContent = `${b.count} point${b.count === 1 ? '' : 's'} · ${new Date(b.receivedAt).toLocaleDateString()}`;
      const del = document.createElement('button');
      del.className = 'btn small';
      del.type = 'button';
      del.textContent = 'Delete all';
      del.addEventListener('click', async () => {
        await Store.deleteBundle(b.id);
        await reload();
        renderBundles();
        renderShareList();
      });
      li.append(name, meta, del);
      els.bundleList.appendChild(li);
    }
  }

  // No browser can set screen brightness -- the API does not exist on any
  // platform. White behind the code is the honest substitute: it maximises
  // what the panel emits at whatever brightness the phone is on, and the
  // wake lock keeps it from dimming halfway through the scan.
  async function goBright() {
    document.body.classList.add('bright');
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  }

  async function goDim() {
    document.body.classList.remove('bright');
    if (wakeLock !== null) {
      await wakeLock.release();
      wakeLock = null;
    }
  }

  async function startShare() {
    const wanted = new Set(
      [...els.shareList.querySelectorAll('input:checked')].map((b) => b.dataset.id)
    );
    const points = state.points.filter((p) => wanted.has(p.id));
    if (points.length === 0) {
      status('Pick at least one point to share.');
      return;
    }

    // Photos ride along at transfer size. Each one costs frames, so the
    // sender is told what they are asking the other phone to hold still for.
    const photos = new Map();
    for (const pt of points) {
      if (pt.photoId === null) continue;
      const blob = await Store.getPhoto(pt.photoId);
      if (blob === null) continue;
      photos.set(pt.id, await Share.shrinkPhoto(blob, SEND.px, SEND.quality));
    }

    const name = els.shareName.value.trim() === '' ? 'Shared points' : els.shareName.value.trim();
    const { frames } = await Share.encode(name, points, photos);
    show('qr-view');
    await goBright();
    stopPlaying = Share.play(els.qr, frames, (i, total) => {
      els.qrCount.textContent = total === 1
        ? 'One code — hold steady'
        : `Frame ${i} of ${total} — keep both phones still until it completes`;
    });
  }

  async function stopShare() {
    if (stopPlaying !== null) {
      stopPlaying();
      stopPlaying = null;
    }
    await goDim();
    show('share-panel');
  }

  async function startReceive() {
    show('scan-view');
    els.scanCount.textContent = 'Point at the other phone’s screen…';
    scanAbort = new AbortController();
    const payload = await Share.receive(els.video, els.scanCanvas, (have, total) => {
      els.scanCount.textContent = `${have} of ${total} frames`;
    }, scanAbort.signal);

    const bundleId = Store.newId();
    const photos = [];
    const points = payload.p.map((row) => {
      const [label, lat, lng, note, imageIndex] = row;
      const point = {
        id: Store.newId(),
        label,
        note,
        lat,
        lng,
        photoId: null,
        bundleId,
        createdAt: Date.now()
      };
      if (imageIndex >= 0) {
        point.photoId = Store.newId();
        photos.push({ id: point.photoId, blob: Share.base64ToBlob(payload.i[imageIndex]) });
      }
      return point;
    });

    await Store.addBundle(
      { id: bundleId, name: payload.n, receivedAt: Date.now(), count: points.length },
      points,
      photos
    );
    await reload();
    renderBundles();
    renderShareList();
    show('share-panel');
    status(`Received ${points.length} point${points.length === 1 ? '' : 's'} from “${payload.n}”.`);
  }

  function stopReceive() {
    if (scanAbort !== null) {
      scanAbort.abort();
      scanAbort = null;
    }
    show('share-panel');
  }

  // ---------- Wiring ----------
  function init(options) {
    viewer = options.viewer;
    geo = options.geo;

    for (const id of [
      'scrim', 'hint', 'drop', 'share', 'label', 'note', 'photo', 'photo-name', 'form-save', 'form-cancel',
      'detail-name', 'detail-note', 'detail-origin', 'detail-photo', 'detail-edit', 'detail-delete', 'detail-close',
      'share-list', 'share-name', 'share-go', 'share-close', 'bundle-list', 'receive-go',
      'qr', 'qr-count', 'qr-done', 'video', 'scan-canvas', 'scan-count', 'scan-cancel'
    ]) {
      els[id.replace(/-(\w)/g, (m, c) => c.toUpperCase())] = $(id);
    }

    els.drop.addEventListener('click', arm);
    els.share.addEventListener('click', async () => {
      // Re-read before rendering: one indexed read is cheap, and it means the
      // sheet can never show a list that something else has already changed.
      await reload();
      renderShareList();
      renderBundles();
      show('share-panel');
    });

    els.photo.addEventListener('change', async () => {
      const file = els.photo.files[0];
      if (file === undefined) return;
      pendingPhoto = await Share.shrinkPhoto(file, KEEP.px, KEEP.quality);
      els.photoName.textContent = `Photo ready (${Math.round(pendingPhoto.size / 1024)} KB)`;
    });
    els.formSave.addEventListener('click', saveForm);
    els.formCancel.addEventListener('click', () => show(null));

    els.detailClose.addEventListener('click', () => show(null));
    els.detailEdit.addEventListener('click', () => openForm(editing));
    els.detailDelete.addEventListener('click', async () => {
      await Store.deletePoint(editing);
      show(null);
      await reload();
    });

    els.shareClose.addEventListener('click', () => show(null));
    els.shareGo.addEventListener('click', startShare);
    els.receiveGo.addEventListener('click', startReceive);
    els.qrDone.addEventListener('click', stopShare);
    els.scanCancel.addEventListener('click', stopReceive);
    els.scrim.addEventListener('click', () => show(null));

    return reload();
  }

  return { init, onMapTap };
})();
