function showFatal(msg) {
  const el = document.getElementById('fatal');
  el.textContent = msg;
  el.hidden = false;
}
window.addEventListener('error', (e) => showFatal(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showFatal(`Error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

// Starting view: French Village, MO. Pan to the venue from here.
const START = { lat: 37.995, lng: -90.395, zoom: 14 };
const DRAFT_KEY = 'nv-calibration-draft';

const $ = (id) => document.getElementById(id);
const els = { label: $('label'), add: $('add'), pending: $('pending'), list: $('list'), copy: $('copy'), reset: $('reset'), source: $('source'), out: $('out') };

function dotEl(cls, text) {
  const el = document.createElement('div');
  el.className = `cal-dot ${cls}`;
  el.textContent = text;
  return el;
}

async function init() {
  const res = await fetch('/public/calibration.json');
  if (!res.ok) throw new Error(`calibration.json returned ${res.status}`);
  const deployed = await res.json();

  // A draft in this browser wins over the deployed file, so a refresh
  // mid-session doesn't lose work. "Discard draft" goes back to deployed.
  const draftText = localStorage.getItem(DRAFT_KEY);
  const calib = draftText === null ? deployed : JSON.parse(draftText);
  els.source.textContent = draftText === null ? 'Loaded the deployed calibration.json.' : 'Loaded your unsaved draft from this browser.';

  const img = new Image();
  img.draggable = false;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error(`Map image failed to load: ${calib.image.src}`));
    img.src = calib.image.src;
  });
  if (img.naturalWidth !== calib.image.width || img.naturalHeight !== calib.image.height) {
    throw new Error(`Image is ${img.naturalWidth}×${img.naturalHeight}; calibration says ${calib.image.width}×${calib.image.height}.`);
  }

  let mode = 'pair';
  let pendingPx = null;
  let pendingLL = null;
  let geo = null;

  const viewer = new Viewer($('img-view'), img, {
    maxZoom: 10,
    onTap: (x, y) => {
      if (mode !== 'pair') return;
      pendingPx = [Math.round(x), Math.round(y)];
      viewer.setMarker('pending', { x, y, el: dotEl('pending', '+') });
      updatePending();
    }
  });

  const sat = L.map('sat-view', { zoomControl: true }).setView([START.lat, START.lng], START.zoom);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: 'Imagery © Esri'
  }).addTo(sat);
  const satLayer = L.layerGroup().addTo(sat);
  let satPending = null;

  if (calib.points.length > 0) {
    sat.fitBounds(calib.points.map((p) => p.ll), { padding: [40, 40] });
  }

  sat.on('click', (e) => {
    const ll = [+e.latlng.lat.toFixed(7), +e.latlng.lng.toFixed(7)];
    if (mode === 'test') {
      if (geo === null) throw new Error('Add at least 3 points before testing.');
      const p = geo.project(ll[0], ll[1]);
      viewer.setMarker('test', { x: p.x, y: p.y, el: dotEl(p.inMesh ? 'test' : 'test rough', '') });
      viewer.centerOn(p.x, p.y);
      if (satPending !== null) satPending.remove();
      satPending = L.circleMarker(ll, { radius: 7, color: '#fff', fillColor: '#35a7ff', fillOpacity: 1, weight: 2 }).addTo(sat);
      els.pending.textContent = p.inMesh ? 'Inside the calibrated area.' : 'Outside the calibrated area: rough estimate only.';
      return;
    }
    pendingLL = ll;
    if (satPending !== null) satPending.remove();
    satPending = L.circleMarker(ll, { radius: 7, color: '#fff', fillColor: '#f6d31b', fillOpacity: 1, weight: 2 }).addTo(sat);
    updatePending();
  });

  function updatePending() {
    els.add.disabled = !(pendingPx !== null && pendingLL !== null);
    const parts = [];
    parts.push(pendingPx === null ? 'Map: not picked' : `Map: ${pendingPx[0]}, ${pendingPx[1]}`);
    parts.push(pendingLL === null ? 'Satellite: not picked' : `Satellite: ${pendingLL[0]}, ${pendingLL[1]}`);
    els.pending.textContent = parts.join('   ');
  }

  function clearPending() {
    pendingPx = null;
    pendingLL = null;
    viewer.removeMarker('pending');
    if (satPending !== null) satPending.remove();
    satPending = null;
    updatePending();
  }

  function save() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(calib));
    els.out.value = JSON.stringify(calib, null, 2);
  }

  function render() {
    geo = calib.points.length >= 3 ? Geo.build(calib) : null;
    const resid = geo === null ? null : geo.residuals();

    satLayer.clearLayers();
    for (const key of [...viewer.markers.keys()]) {
      if (key.startsWith('pt-')) viewer.removeMarker(key);
    }
    els.list.innerHTML = '';

    calib.points.forEach((p, i) => {
      const n = String(i + 1);
      viewer.setMarker(`pt-${i}`, { x: p.px[0], y: p.px[1], el: dotEl('fixed', n) });
      L.marker(p.ll, {
        icon: L.divIcon({ className: '', html: `<div class="cal-dot fixed sat">${n}</div>`, iconSize: [0, 0] })
      }).addTo(satLayer);

      const li = document.createElement('li');
      const off = resid === null ? '' : `${Math.round(resid[i])} m off the average fit`;
      li.innerHTML = `<span class="pt-name"></span><span class="pt-meta">${off}</span>`;
      li.querySelector('.pt-name').textContent = p.label;
      if (resid !== null && resid[i] > 40) li.classList.add('suspect');

      const del = document.createElement('button');
      del.className = 'btn small';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        calib.points.splice(i, 1);
        save();
        render();
      });
      li.appendChild(del);
      li.addEventListener('click', (e) => {
        if (e.target === del) return;
        viewer.centerOn(p.px[0], p.px[1], 3);
        sat.setView(p.ll, 18);
      });
      els.list.appendChild(li);
    });

    if (geo !== null) {
      els.source.textContent = `${calib.points.length} points, ${geo.triangleCount} triangles.`;
    }
  }

  els.add.addEventListener('click', () => {
    const label = els.label.value.trim();
    if (label === '') {
      els.label.focus();
      els.pending.textContent = 'Give this point a name first.';
      return;
    }
    calib.points.push({ label, px: pendingPx, ll: pendingLL });
    els.label.value = '';
    clearPending();
    save();
    render();
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', () => {
      mode = r.value;
      clearPending();
      viewer.removeMarker('test');
      els.pending.textContent = mode === 'test'
        ? 'Tap anywhere on the satellite to see where the dot lands.'
        : 'Tap the festival map, then the satellite.';
    })
  );

  els.copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(els.out.value);
    els.copy.textContent = 'Copied';
    setTimeout(() => (els.copy.textContent = 'Copy calibration.json'), 1500);
  });

  els.reset.addEventListener('click', () => {
    if (!confirm('Discard your draft and reload the deployed calibration?')) return;
    localStorage.removeItem(DRAFT_KEY);
    location.reload();
  });

  els.out.value = JSON.stringify(calib, null, 2);
  render();
}

init();
