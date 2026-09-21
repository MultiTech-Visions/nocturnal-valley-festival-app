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
    // Any sheet taking over means the callout's point is no longer what the
    // screen is about.
    closeCallout();
  }

  function status(msg) {
    els.hint.textContent = msg;
  }

  // ---------- Photos ----------
  // Object URLs are cached per photo and revoked wholesale on reload:
  // a pin preview, the callout thumbnail and the lightbox all want the same
  // image, and decoding it three times would be three times the work.
  const photoUrls = new Map();

  async function photoUrl(photoId) {
    if (photoUrls.has(photoId)) return photoUrls.get(photoId);
    const blob = await Store.getPhoto(photoId);
    if (blob === null) return null;
    const url = URL.createObjectURL(blob);
    photoUrls.set(photoId, url);
    return url;
  }

  function dropPhotoUrls() {
    for (const url of photoUrls.values()) URL.revokeObjectURL(url);
    photoUrls.clear();
  }

  // ---------- Drawing ----------
  function draw() {
    for (const key of [...viewer.markers.keys()]) {
      if (key.startsWith('cp-')) viewer.removeMarker(key);
    }
    for (const pt of state.points) {
      const p = geo.project(pt.lat, pt.lng);
      if (p.x < 0 || p.y < 0 || p.x > viewer.iw || p.y > viewer.ih) continue;
      viewer.setMarker(`cp-${pt.id}`, { x: p.x, y: p.y, el: pinEl(pt) });
    }
  }

  function pinEl(pt) {
    const el = document.createElement('div');
    el.className = `pin${pt.bundleId === null ? '' : ' shared'}`;

    const inner = document.createElement('div');
    inner.className = 'pin-inner';
    inner.innerHTML = '<span class="pin-head"></span>';

    const tag = document.createElement('span');
    tag.className = 'pin-label';
    tag.textContent = pt.label;
    inner.appendChild(tag);
    el.appendChild(inner);

    if (pt.photoId !== null) {
      const preview = document.createElement('span');
      preview.className = 'pin-preview';
      const img = document.createElement('img');
      img.alt = '';
      preview.appendChild(img);
      inner.appendChild(preview);
      // Loaded on first hover, not on draw: a map full of pins should not
      // decode every photo before anyone has asked to see one.
      el.addEventListener('pointerenter', async () => {
        if (img.src !== '') return;
        const url = await photoUrl(pt.photoId);
        if (url !== null) img.src = url;
      });
    }

    // Pointer capture is what makes a tap work on a phone: without it a
    // finger that drifts a pixel off a 16px pin sends pointerup somewhere
    // else entirely, and only a dead-still long press ever registered.
    let press = null;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      if (press === null || e.pointerId !== press.id) return;
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      press = null;
      if (moved < 10) openDetail(pt, el);
    });
    el.addEventListener('pointercancel', () => { press = null; });
    return el;
  }

  async function reload() {
    dropPhotoUrls();
    state = await Store.load();
    draw();
    renderSidebar();
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
  // A callout pinned to its point rather than a sheet at the bottom of the
  // screen: the whole value of it is saying "this one", so it follows the
  // pin while the map is panned or zoomed instead of drifting off it.
  let calloutAnchor = null;
  let calloutRaf = null;

  function placeCallout() {
    if (calloutAnchor === null) return;
    const el = els.pointDetail;
    const r = calloutAnchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const above = r.top - 12 >= h;
    el.classList.toggle('below', !above);
    // Clamped so a point near either edge keeps the callout on screen.
    const half = el.offsetWidth / 2;
    const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
    el.style.left = `${x}px`;
    el.style.top = above ? `${r.top - 12}px` : `${r.bottom + 12}px`;
  }

  function trackCallout() {
    placeCallout();
    calloutRaf = requestAnimationFrame(trackCallout);
  }

  function closeCallout() {
    if (calloutRaf !== null) {
      cancelAnimationFrame(calloutRaf);
      calloutRaf = null;
    }
    calloutAnchor = null;
    els.pointDetail.hidden = true;
  }

  async function openDetail(point, anchorEl) {
    editing = point;
    els.detailName.textContent = point.label;
    els.detailNote.textContent = point.note === '' ? 'No note' : point.note;
    els.detailOrigin.textContent = point.bundleId === null ? 'Yours' : 'Shared with you';
    els.detailPhoto.hidden = true;
    els.detailPhoto.removeAttribute('src');

    els.pointDetail.hidden = false;
    calloutAnchor = anchorEl;
    placeCallout();
    if (calloutRaf === null) trackCallout();

    if (point.photoId === null) return;
    const url = await photoUrl(point.photoId);
    if (url === null) return;
    els.detailPhoto.src = url;
    els.detailPhoto.hidden = false;
    placeCallout();
  }

  // ---------- Sidebar ----------
  function renderSidebar() {
    els.pointList.innerHTML = '';
    if (state.points.length === 0) {
      els.pointList.innerHTML = '<li class="empty">No points yet. Use “Drop a point”.</li>';
      return;
    }
    for (const pt of state.points) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `pin-head${pt.bundleId === null ? '' : ' shared'}`;
      const name = document.createElement('span');
      name.className = 'pt-name';
      name.textContent = pt.label;
      const meta = document.createElement('span');
      meta.className = 'pt-meta';
      meta.textContent = pt.photoId === null ? '' : '📷';
      li.append(dot, name, meta);
      li.addEventListener('click', () => centerOn(pt));
      els.pointList.appendChild(li);
    }
  }

  function centerOn(pt) {
    const p = geo.project(pt.lat, pt.lng);
    viewer.centerOn(p.x, p.y, 3);
    if (window.innerWidth < 900) els.sidebar.classList.remove('open');
    // The marker is rebuilt on every draw, so find the live element rather
    // than holding a reference that may already be detached.
    const marker = viewer.markers.get(`cp-${pt.id}`);
    if (marker !== undefined) openDetail(pt, marker.el);
  }

  // Swipe in from the right edge to open, swipe right on the panel to close.
  function wireSwipe() {
    let swipe = null;
    document.addEventListener('pointerdown', (e) => {
      const fromEdge = e.clientX > window.innerWidth - 24;
      const onPanel = els.sidebar.contains(e.target);
      if (!fromEdge && !onPanel) return;
      swipe = { x: e.clientX, opening: !els.sidebar.classList.contains('open') };
    });
    document.addEventListener('pointerup', (e) => {
      if (swipe === null) return;
      const dx = e.clientX - swipe.x;
      if (swipe.opening && dx < -40) els.sidebar.classList.add('open');
      if (!swipe.opening && dx > 60) els.sidebar.classList.remove('open');
      swipe = null;
    });
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
      'point-detail', 'detail-name', 'detail-note', 'detail-origin', 'detail-photo', 'detail-edit', 'detail-delete', 'detail-close',
      'sidebar', 'sidebar-grip', 'sidebar-close', 'point-list', 'lightbox', 'lightbox-img',
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

    els.detailClose.addEventListener('click', closeCallout);
    els.detailEdit.addEventListener('click', () => {
      closeCallout();
      openForm(editing);
    });
    els.detailDelete.addEventListener('click', async () => {
      await Store.deletePoint(editing);
      closeCallout();
      await reload();
    });

    // Thumbnail to full size and back.
    els.detailPhoto.addEventListener('click', () => {
      els.lightboxImg.src = els.detailPhoto.src;
      els.lightbox.hidden = false;
    });
    els.lightbox.addEventListener('click', () => {
      els.lightbox.hidden = true;
      els.lightboxImg.removeAttribute('src');
    });

    els.sidebarGrip.addEventListener('click', () => els.sidebar.classList.toggle('open'));
    els.sidebarClose.addEventListener('click', () => els.sidebar.classList.remove('open'));
    wireSwipe();

    // A press on the map itself dismisses the callout, the way tapping away
    // from a popover does anywhere else. Pins stop their own events, so this
    // never fires for the pin that opened it.
    document.getElementById('map').addEventListener('pointerdown', closeCallout);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeCallout();
      els.lightbox.hidden = true;
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
