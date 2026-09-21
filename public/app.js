// On a phone there's no console, so uncaught errors are shown on screen.
function showFatal(msg) {
  const el = document.getElementById('fatal');
  el.textContent = msg;
  el.hidden = false;
}
window.addEventListener('error', (e) => showFatal(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showFatal(`Error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

const els = {
  offline: document.getElementById('offline'),
  gpsStatus: document.getElementById('gps-status'),
  gpsToggle: document.getElementById('gps-toggle'),
  recenter: document.getElementById('recenter'),
  drop: document.getElementById('drop'),
  share: document.getElementById('share'),
  map: document.getElementById('map')
};

// ---------- Offline readiness ----------
async function checkOffline() {
  const reg = await navigator.serviceWorker.ready;
  const status = await new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    reg.active.postMessage('status', [ch.port2]);
  });
  els.offline.textContent = status.ready ? 'Ready offline' : 'Saving for offline…';
  els.offline.className = `badge ${status.ready ? 'ready' : 'pending'}`;
  if (!status.ready) setTimeout(checkOffline, 1500);
}

if (!('serviceWorker' in navigator)) throw new Error('This browser does not support offline mode.');
navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(checkOffline);

// ---------- Map + GPS ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Map image failed to load: ${src}`));
    img.src = src;
    img.draggable = false;
  });
}

// Tabs. The schedule does not depend on the map or its calibration, so it
// is wired up before anything that can bail out.
function wireTabs() {
  const names = ['map', 'schedule', 'hunt'];
  const tabs = {};
  for (const name of names) tabs[name] = document.getElementById(`tab-${name}`);
  const pick = (which) => {
    for (const name of names) {
      document.body.classList.toggle(`view-${name}`, name !== 'map' && name === which);
      tabs[name].classList.toggle('on', name === which);
    }
  };
  for (const name of names) tabs[name].addEventListener('click', () => pick(name));

  // Egg: the offline badge in the corner is also a door. Five taps.
  let logoTaps = 0;
  let logoAt = 0;
  document.getElementById('offline').addEventListener('click', () => {
    const now = Date.now();
    logoTaps = now - logoAt > 1500 ? 1 : logoTaps + 1;
    logoAt = now;
    if (logoTaps < 5) return;
    logoTaps = 0;
    Badges.bump('logoTaps', 5).then(() => QuestsUI.score());
  });
}

async function init() {
  wireTabs();
  await ScheduleUI.init();

  const res = await fetch('/public/calibration.json');
  if (!res.ok) throw new Error(`calibration.json returned ${res.status}`);
  const calib = await res.json();
  const img = await loadImage(calib.image.src);

  if (img.naturalWidth !== calib.image.width || img.naturalHeight !== calib.image.height) {
    throw new Error(`Map is ${img.naturalWidth}×${img.naturalHeight} but calibration expects ${calib.image.width}×${calib.image.height}. Recalibrate.`);
  }

  // Taps are forwarded to the points layer, which ignores them unless the
  // user has armed "Drop a point".
  const viewer = new Viewer(els.map, img, {
    maxZoom: 6,
    // A find waiting to be placed on the artwork claims the tap; otherwise
    // it belongs to whatever the points layer is doing.
    onTap: (x, y) => {
      QuestsUI.onMapTap(x, y).then((claimed) => {
        if (!claimed) PointsUI.onMapTap(x, y);
      });
    },
    // Long press anywhere on the artwork means "take me to this spot",
    // whether or not there is a saved point on it.
    onLongPress: (x, y) => PointsUI.onMapLongPress(x, y)
  });

  if (calib.points.length < 3) {
    els.gpsStatus.textContent = 'Map not calibrated yet';
    els.gpsToggle.disabled = true;
    // Dropping and sharing points both need a transform between GPS and the
    // artwork, so they stay off until the map is calibrated.
    els.drop.disabled = true;
    els.share.disabled = true;
    return;
  }
  const geo = Geo.build(calib);
  // The compass rides the map's GPS watch rather than starting its own, and
  // can ask for it to be switched on when someone picks a destination.
  Compass.init({ requestGps: () => { if (!wanted) els.gpsToggle.click(); } });
  await PointsUI.init({ viewer, geo });
  await Badges.init();
  await QuestsUI.init({
    viewer,
    geo,
    requestGps: () => { if (!wanted) els.gpsToggle.click(); },
    // A find drops a pin, so the map has to redraw.
    onChange: () => PointsUI.reload()
  });

  let watchId = null;
  let wanted = false;

  const dot = document.createElement('div');
  dot.className = 'me';
  const ring = document.createElement('div');
  ring.className = 'me-accuracy';

  let last = null;
  let centeredOnce = false;

  function onFix(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    Compass.onFix(pos.coords);
    const p = geo.project(latitude, longitude);
    const offImage = p.x < 0 || p.y < 0 || p.x > calib.image.width || p.y > calib.image.height;
    const x = Math.min(Math.max(p.x, 0), calib.image.width);
    const y = Math.min(Math.max(p.y, 0), calib.image.height);

    dot.classList.toggle('rough', !p.inMesh);
    dot.classList.toggle('edge', offImage);
    viewer.setMarker('ring', { x, y, el: ring, radiusPx: offImage ? 0 : accuracy * geo.pxPerMeter(latitude, longitude) });
    viewer.setMarker('me', { x, y, el: dot });

    last = { x, y };
    els.recenter.disabled = false;
    els.gpsStatus.textContent = offImage
      ? 'You’re off the map'
      : `Within ${Math.round(accuracy)} m${p.inMesh ? '' : ' · rough area'}`;

    if (!centeredOnce) {
      viewer.centerOn(x, y, 2.5);
      centeredOnce = true;
    }
  }

  function onError(err) {
    const reasons = {
      1: 'Location permission denied. Allow it in your phone settings.',
      2: 'No GPS signal yet. Step out from under the trees.',
      3: 'Still searching for satellites…'
    };
    els.gpsStatus.textContent = reasons[err.code];
  }

  function start() {
    if (watchId !== null) return;
    els.gpsStatus.textContent = 'Finding satellites…';
    watchId = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 60000
    });
  }

  function stop() {
    if (watchId === null) return;
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  els.gpsToggle.addEventListener('click', () => {
    wanted = !wanted;
    // textContent would delete the SVG inside the button. The icon carries
    // its own on/off state through the .off class.
    els.gpsToggle.classList.toggle('off', !wanted);
    const label = wanted ? 'Hide my location' : 'Show my location';
    els.gpsToggle.setAttribute('aria-label', label);
    els.gpsToggle.title = label;
    if (wanted) {
      centeredOnce = false;
      start();
    } else {
      stop();
      viewer.removeMarker('me');
      viewer.removeMarker('ring');
      els.gpsStatus.textContent = 'GPS off';
      els.recenter.disabled = true;
    }
  });

  els.recenter.addEventListener('click', () => viewer.centerOn(last.x, last.y, 2.5));

  // GPS only runs while the app is on screen, to save battery.
  document.addEventListener('visibilitychange', () => {
    if (!wanted) return;
    if (document.hidden) stop();
    else start();
  });
}

init();
