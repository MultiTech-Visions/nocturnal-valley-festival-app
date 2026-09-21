// The hunt. The map ships with hand-estimated coordinates and nobody from HQ
// is going to walk the site with a GPS, so this asks the crowd instead:
// stand at a landmark, press "I found it", and the phone's own fix is a
// better number than the estimate it replaces. Every find drops a pin, and a
// find that is also placed on the artwork is a calibration pair -- the thing
// that actually makes the map more accurate.
//
// The celebration is not decoration. It is the one moment someone is standing
// still, pleased with themselves, and will actually take the group photo they
// otherwise never remember to take.
const QuestsUI = (() => {
  const $ = (id) => document.getElementById(id);

  // Big enough to be worth looking at later, small enough that a phone full
  // of them is not a problem. Same shrinker the map points use.
  const KEEP = { px: 1280, quality: 0.72 };

  let data = null;
  let finds = new Map();
  let geo = null;
  let viewer = null;
  let requestGps = null;
  let pending = null;
  let placing = null;
  const els = {};

  const questById = (id) => data.quests.find((q) => q.id === id);
  const categoryById = (id) => data.categories.find((c) => c.id === id);
  const foundCount = () => finds.size;

  // ---------- The list ----------
  function render() {
    els.list.innerHTML = '';
    const total = data.quests.length;
    els.progress.textContent = `${foundCount()} of ${total} found`;
    els.bar.style.width = `${(foundCount() / total) * 100}%`;

    for (const cat of data.categories) {
      const mine = data.quests.filter((q) => q.category === cat.id);
      if (mine.length === 0) continue;
      const head = document.createElement('h3');
      head.className = 'quest-cat';
      head.style.setProperty('--cat', cat.color);
      head.textContent = `${cat.name} · ${mine.filter((q) => finds.has(q.id)).length}/${mine.length}`;
      els.list.appendChild(head);

      for (const q of mine) {
        const find = finds.get(q.id);
        const li = document.createElement('li');
        li.className = `quest${find === undefined ? '' : ' done'}`;
        li.style.setProperty('--cat', cat.color);

        const icon = document.createElement('span');
        icon.className = 'quest-icon';
        icon.textContent = q.icon;

        const text = document.createElement('div');
        text.className = 'quest-text';
        const name = document.createElement('strong');
        name.textContent = q.name;
        const hint = document.createElement('span');
        hint.className = 'pt-meta';
        hint.textContent = find === undefined
          ? q.hint
          : `Found ${new Date(find.foundAt).toLocaleDateString()} · ±${Math.round(find.accuracy)} m${find.px === null ? '' : ' · on the map'}`;
        text.append(name, hint);

        const go = document.createElement('button');
        go.type = 'button';
        go.className = `btn small${find === undefined ? ' primary' : ''}`;
        go.textContent = find === undefined ? 'I found it' : 'Undo';
        go.addEventListener('click', () => (find === undefined ? claim(q) : unclaim(q)));

        li.append(icon, text, go);
        els.list.appendChild(li);
      }
    }
  }

  // ---------- Finding ----------
  function currentPosition() {
    if (!('geolocation' in navigator)) return Promise.reject(new Error('this phone has no location support'));
    return Promise.race([
      new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
      }),
      // Same reason as dropping a point: the permission prompt is not
      // covered by the API's own timeout, so nothing waits forever.
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('no fix yet')), 15000))
    ]);
  }

  async function claim(quest) {
    els.celebrateName.textContent = quest.name;
    els.celebrateIcon.textContent = quest.icon;
    els.celebrateWhere.textContent = 'Pinning where you are…';
    els.celebratePhotoName.textContent = '';
    els.celebratePhoto.value = '';
    els.celebrateShot.hidden = true;
    els.celebratePlace.hidden = true;
    els.celebrate.hidden = false;

    if (requestGps !== null) requestGps();
    try {
      const pos = await currentPosition();
      const { latitude, longitude, accuracy } = pos.coords;
      const point = {
        id: Store.newId(),
        label: quest.name,
        note: 'Found on the hunt',
        lat: latitude,
        lng: longitude,
        photoId: null,
        bundleId: null,
        createdAt: Date.now()
      };
      const find = {
        questId: quest.id,
        foundAt: Date.now(),
        lat: latitude,
        lng: longitude,
        accuracy,
        pointId: point.id,
        // Filled in only if they go on to place it on the artwork, which is
        // what turns a find into a calibration pair.
        px: null
      };
      await Store.putFind(find, point);
      finds.set(quest.id, find);
      pending = { quest, find, point };

      els.celebrateWhere.textContent = `Pinned to within ${Math.round(accuracy)} m. ${foundCount()} of ${data.quests.length} found.`;
      els.celebratePlace.hidden = false;
      render();
      await score();
      if (onChange !== null) onChange();
    } catch (err) {
      // No fix is not a failed find: record it, say the coordinates are
      // missing, and let them add the pin later rather than losing the moment.
      const find = { questId: quest.id, foundAt: Date.now(), lat: null, lng: null, accuracy: 0, pointId: null, px: null };
      await Store.putFind(find, null);
      finds.set(quest.id, find);
      pending = { quest, find, point: null };
      els.celebrateWhere.textContent = `Counted, but no GPS right now (${err.message}), so no pin was dropped.`;
      render();
      await score();
      if (onChange !== null) onChange();
    }
  }

  async function unclaim(quest) {
    const find = finds.get(quest.id);
    if (find.pointId !== null) {
      const state = await Store.load();
      const point = state.points.find((p) => p.id === find.pointId);
      if (point !== undefined) await Store.deletePoint(point);
    }
    await Store.deleteFind(quest.id);
    finds.delete(quest.id);
    render();
    if (onChange !== null) onChange();
  }

  // ---------- The photo ----------
  async function attachPhoto(file) {
    if (pending === null || pending.point === null) return;
    const blob = await Share.shrinkPhoto(file, KEEP.px, KEEP.quality);
    const photoId = Store.newId();
    await Store.putPhoto(photoId, blob);
    pending.point.photoId = photoId;
    await Store.putPoint(pending.point);
    els.celebratePhotoName.textContent = 'Saved to this phone, on the pin.';
    els.celebrateShot.src = URL.createObjectURL(blob);
    els.celebrateShot.hidden = false;
    await Badges.bump('photos');
    await score();
    if (onChange !== null) onChange();
  }

  // ---------- Putting it on the artwork ----------
  // The find gives real coordinates; tapping the icon gives the pixel those
  // coordinates belong to. Together that is a calibration pair, which is the
  // only thing that can actually fix a hand-estimated map.
  function startPlacing() {
    if (pending === null) return;
    placing = pending;
    els.celebrate.hidden = true;
    els.placeBar.hidden = false;
    els.placeWhat.textContent = `Tap ${placing.quest.name} on the map`;
    document.body.classList.remove('view-schedule', 'view-hunt');
  }

  function stopPlacing() {
    placing = null;
    els.placeBar.hidden = true;
  }

  // Called by app.js on a map tap while a find is waiting to be placed.
  async function onMapTap(x, y) {
    if (placing === null) return false;
    const find = placing.find;
    find.px = [Math.round(x), Math.round(y)];
    await Store.putFind(find, null);
    finds.set(find.questId, find);
    els.placeWhat.textContent = `${placing.quest.name} pinned on the artwork — thank you, that one helps.`;
    setTimeout(stopPlacing, 1800);
    render();
    await score();
    if (onChange !== null) onChange();
    return true;
  }

  // Finds with both a fix and a pixel, for sharing or handing to whoever
  // maintains calibration.json.
  const calibrationPairs = () => [...finds.values()]
    .filter((f) => f.px !== null && f.lat !== null)
    .map((f) => ({ label: questById(f.questId).name, px: f.px, ll: [+f.lat.toFixed(7), +f.lng.toFixed(7)], accuracy: f.accuracy }));

  const myFinds = () => [...finds.values()];

  async function applyFinds(list) {
    for (const f of list) {
      if (finds.has(f.questId)) continue;
      await Store.putFind(f, null);
      finds.set(f.questId, f);
    }
    render();
  }

  let onChange = null;

  // One place that knows what a badge rule might want to look at.
  async function score() {
    const state = await Store.load();
    await Badges.evaluate({
      finds: [...finds.values()],
      foundIds: new Set(finds.keys()),
      quests: data.quests,
      questTotal: data.quests.length,
      favorites: state.favorites,
      overrides: state.overrides,
      events: ScheduleUI.events()
    });
  }

  async function refresh() {
    const state = await Store.load();
    finds = new Map(state.finds.map((f) => [f.questId, f]));
    render();
    await score();
  }

  async function init(options) {
    geo = options.geo;
    viewer = options.viewer;
    requestGps = options.requestGps;
    onChange = options.onChange;

    // Named one by one on purpose: a clever id-to-camelCase mapping here
    // silently produced els.celebratename and took the whole tab down.
    els.list = $('hunt-list');
    els.progress = $('hunt-progress');
    els.bar = $('hunt-bar');
    els.celebrate = $('celebrate');
    els.celebrateName = $('celebrate-name');
    els.celebrateIcon = $('celebrate-icon');
    els.celebrateWhere = $('celebrate-where');
    els.celebratePhoto = $('celebrate-photo');
    els.celebratePhotoName = $('celebrate-photo-name');
    els.celebrateShot = $('celebrate-shot');
    els.celebratePlace = $('celebrate-place');
    els.celebrateDone = $('celebrate-done');
    els.placeBar = $('place-bar');
    els.placeWhat = $('place-what');
    els.placeStop = $('place-stop');

    const res = await fetch('/public/quests.json');
    if (!res.ok) throw new Error(`quests.json returned ${res.status}`);
    data = await res.json();

    els.celebratePhoto.addEventListener('change', async () => {
      const file = els.celebratePhoto.files[0];
      if (file === undefined) return;
      await attachPhoto(file);
    });
    els.celebrateDone.addEventListener('click', () => { els.celebrate.hidden = true; });
    els.celebratePlace.addEventListener('click', startPlacing);
    els.placeStop.addEventListener('click', stopPlacing);

    await refresh();
  }

  return { init, refresh, score, onMapTap, foundCount, myFinds, applyFinds, calibrationPairs, placing: () => placing !== null };
})();
