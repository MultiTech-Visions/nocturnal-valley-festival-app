// Point me at that. A bearing from where the phone is to where it wants to
// be, turned into an arrow that accounts for which way the phone is held.
//
// Two halves, and only the first is reliable everywhere. The bearing is
// spherical trig on two GPS fixes. The heading -- which way the phone is
// actually pointing -- depends on a magnetometer the browser may not expose:
// iOS needs a permission prompt raised from a real tap, Android reports it
// through a different event, and some devices have no compass at all. When
// there is no heading the dial goes north-up and says so, which still works
// with the compass in anyone's pocket.
const Compass = (() => {
  const RAD = Math.PI / 180;
  const R = 6371008.8;

  let target = null;
  let fix = null;
  let heading = null;
  let watching = false;
  let requestGps = null;
  const els = {};

  // Great-circle bearing, degrees clockwise from true north.
  function bearingTo(from, to) {
    const φ1 = from.lat * RAD;
    const φ2 = to.lat * RAD;
    const Δλ = (to.lng - from.lng) * RAD;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // Haversine. Over a festival site the error is centimetres.
  function distanceTo(from, to) {
    const φ1 = from.lat * RAD;
    const φ2 = to.lat * RAD;
    const dφ = φ2 - φ1;
    const dλ = (to.lng - from.lng) * RAD;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function prettyDistance(m) {
    if (m < 1000) return `${Math.round(m / 5) * 5} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
  }

  const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const cardinal = (deg) => POINTS[Math.round(deg / 45) % 8];

  // ---------- Heading ----------
  function onOrientation(e) {
    let h = null;
    // iOS: already true north, already clockwise.
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;
    } else if (e.absolute === true && typeof e.alpha === 'number') {
      // Everyone else: alpha counts anticlockwise from north.
      h = 360 - e.alpha;
    }
    if (h === null) return;
    // If the screen is rotated relative to the device, the arrow has to
    // rotate with it. The app asks for portrait, so this is usually zero.
    const angle = screen.orientation === undefined || screen.orientation === null ? 0 : screen.orientation.angle;
    heading = (h + angle + 360) % 360;
    paint();
  }

  // iOS only grants this from inside a real tap, which is why it is asked
  // for at the moment a target is chosen rather than at start-up.
  async function startHeading() {
    if (watching) return;
    const DOE = window.DeviceOrientationEvent;
    if (DOE === undefined) return;
    if (typeof DOE.requestPermission === 'function') {
      const state = await DOE.requestPermission();
      if (state !== 'granted') return;
    }
    // absolute first: the plain event is relative to wherever the device
    // happened to be pointing when it started, which is useless here.
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    watching = true;
  }

  function stopHeading() {
    window.removeEventListener('deviceorientationabsolute', onOrientation, true);
    window.removeEventListener('deviceorientation', onOrientation, true);
    watching = false;
    heading = null;
  }

  // ---------- Painting ----------
  function paint() {
    if (target === null) return;
    els.name.textContent = target.label;

    if (fix === null) {
      els.dist.textContent = 'Waiting for GPS…';
      els.note.textContent = 'Turn on “Show my location” to get a direction.';
      els.needle.style.transform = 'rotate(0deg)';
      return;
    }

    const bearing = bearingTo(fix, target);
    const metres = distanceTo(fix, target);
    els.dist.textContent = `${prettyDistance(metres)} · ${cardinal(bearing)} ${Math.round(bearing)}°`;

    if (heading === null) {
      // North-up: the dial is a map, not a pointer. Say so, or someone will
      // trust the arrow while facing the wrong way.
      els.needle.style.transform = `rotate(${bearing}deg)`;
      els.rose.style.transform = 'rotate(0deg)';
      els.dial.classList.add('north-up');
      els.note.textContent = 'No compass on this phone — dial is north-up, so hold it with north away from you.';
      return;
    }

    els.dial.classList.remove('north-up');
    els.needle.style.transform = `rotate(${(bearing - heading + 360) % 360}deg)`;
    els.rose.style.transform = `rotate(${-heading}deg)`;
    els.note.textContent = metres < 15 ? 'You’re basically on it.' : 'Point the phone flat, arrow shows the way.';
  }

  // ---------- Public ----------
  async function setTarget(next) {
    target = next;
    // Using the compass at all is worth a badge; scoring is the hunt's job.
    Badges.bump('compass').then(() => QuestsUI.score());
    els.panel.hidden = false;
    paint();
    // Both are gesture-sensitive on some platforms, so they ride the tap
    // that chose the target.
    await startHeading();
    if (fix === null && requestGps !== null) requestGps();
    paint();
  }

  function clear() {
    target = null;
    els.panel.hidden = true;
    stopHeading();
  }

  // Fed by the map's existing GPS watch rather than opening a second one.
  function onFix(coords) {
    fix = { lat: coords.latitude, lng: coords.longitude };
    paint();
  }

  const active = () => target !== null;

  function init(options) {
    requestGps = options.requestGps;
    els.panel = document.getElementById('compass');
    els.name = document.getElementById('compass-name');
    els.dist = document.getElementById('compass-dist');
    els.note = document.getElementById('compass-note');
    els.needle = document.getElementById('compass-needle');
    els.rose = document.getElementById('compass-rose');
    els.dial = document.getElementById('compass-dial');
    els.close = document.getElementById('compass-close');
    els.close.addEventListener('click', clear);
  }

  return { init, setTarget, clear, onFix, active, bearingTo, distanceTo };
})();
