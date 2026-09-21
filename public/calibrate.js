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

// One inline confirm bubble, anchored above whatever element asked for it:
// a numbered dot on either pane, or the Delete button in the list. Fixed
// positioning keeps it out of the panes' overflow and Leaflet's transforms.
// Only one is ever open, and anything that moves a pane dismisses it, since
// a bubble pinned to a dot that has since panned away is a mis-click waiting
// to happen.
const confirmBubble = (() => {
  let open = null;

  function close() {
    if (open === null) return;
    open.el.remove();
    open = null;
  }

  function ask(anchorEl, message, onYes) {
    close();
    const el = document.createElement('div');
    el.className = 'confirm';

    const text = document.createElement('span');
    text.textContent = message;

    // Step one: a plain Delete. Step two: the same bubble, rebuilt as a
    // green check and a red X. Two presses to lose a point you may have
    // spent a while placing.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'confirm-btn del';
    del.textContent = 'Delete';

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'confirm-btn yes';
    yes.textContent = '\u2713';
    yes.title = 'Confirm delete';
    yes.addEventListener('click', () => {
      close();
      onYes();
    });

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'confirm-btn no';
    no.textContent = '\u2715';
    no.title = 'Keep';
    no.addEventListener('click', close);

    del.addEventListener('click', () => {
      del.remove();
      text.textContent = 'Sure?';
      el.append(yes, no);
      // The bubble changed width, so re-anchor before it looks off-centre.
      place(el, anchorEl);
      yes.focus();
    });

    el.append(text, del);
    document.body.appendChild(el);
    place(el, anchorEl);
    open = { el, anchorEl };
    del.focus();
  }

  // Anchored above the dot, centred on it, with the arrow pointing down at
  // it. Flips below when there is no room above, so a point near the top of
  // a pane doesn't push the bubble off screen.
  function place(el, anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const h = el.offsetHeight;
    const above = r.top - 10 >= h;
    el.classList.toggle('below', !above);
    el.style.left = `${r.left + r.width / 2}px`;
    el.style.top = above ? `${r.top - 10}px` : `${r.bottom + 10}px`;
  }

  // Capture phase so a press anywhere else dismisses before it does its own
  // work: one tap to cancel, not one to cancel and another to act.
  document.addEventListener('pointerdown', (e) => {
    if (open !== null && !open.el.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('resize', close);

  return { ask, close };
})();

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
  sat.on('movestart zoomstart', () => confirmBubble.close());

  const satLayer = L.layerGroup().addTo(sat);
  let satPending = null;

  // World_Imagery is unlabeled aerial photography, so a cold calibration gives
  // you nothing to navigate by: no town names, no roads, no park name. These
  // transparent Esri reference layers put those labels over the imagery.
  // They're clutter once you're oriented, hence the toggle.
  const labels = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 })
  ]);
  L.control.layers(null, { 'Place &amp; road labels': labels }, { collapsed: false, position: 'topright' }).addTo(sat);

  if (calib.points.length > 0) {
    // Already calibrated: fitBounds lands you on the venue, so start clean.
    sat.fitBounds(calib.points.map((p) => p.ll), { padding: [40, 40] });
  } else {
    // Nothing placed yet: you're hunting for the site, so start labeled.
    labels.addTo(sat);
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
      const remove = () => {
        calib.points.splice(i, 1);
        save();
        render();
      };
      const askRemove = (anchorEl) => confirmBubble.ask(anchorEl, `Delete ${p.label}?`, remove);

      const dot = dotEl('fixed', n);
      // The dot lives inside the viewer container, so its events would
      // otherwise bubble into the pan/tap handling and drop a pending pixel.
      dot.addEventListener('pointerdown', (e) => e.stopPropagation());
      dot.addEventListener('pointerup', (e) => e.stopPropagation());
      dot.addEventListener('click', () => askRemove(dot));
      viewer.setMarker(`pt-${i}`, { x: p.px[0], y: p.px[1], el: dot });

      const satMarker = L.marker(p.ll, {
        icon: L.divIcon({ className: '', html: `<div class="cal-dot fixed sat">${n}</div>`, iconSize: [0, 0] })
      }).addTo(satLayer);
      // Leaflet stops marker clicks from reaching the map, so this can't also
      // register a satellite pick.
      // Anchor on the dot itself: the Leaflet icon box is 0x0 by design.
      satMarker.on('click', () => askRemove(satMarker.getElement().firstElementChild));

      const li = document.createElement('li');
      const off = resid === null ? '' : `${Math.round(resid[i])} m off the average fit`;
      li.innerHTML = `<span class="pt-name"></span><span class="pt-meta">${off}</span>`;
      li.querySelector('.pt-name').textContent = p.label;
      if (resid !== null && resid[i] > 40) li.classList.add('suspect');

      const del = document.createElement('button');
      del.className = 'btn small';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', () => askRemove(del));
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
