// Pixel art trophies, and the rules that hand them out.
//
// The hunt exists to collect real coordinates for a map that was estimated by
// hand. Nobody does that as a favour, so the badges pay for it: the ones that
// feel best to earn are the ones that make the map more accurate -- placing a
// find on the artwork, sweeping a whole category, finishing all 26.
//
// Sprites are 12x12 character grids drawn to a canvas with smoothing off, so
// they stay crisp at any size and the whole set costs a few kilobytes.
const Badges = (() => {
  const SIZE = 12;

  let data = null;
  let unlocked = new Set();
  let stats = { shares: 0, compass: 0, owlTaps: 0, logoTaps: 0, photos: 0 };
  let queue = [];
  const els = {};

  function draw(canvas, badge, locked) {
    const px = Math.max(1, Math.floor(canvas.width / SIZE));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    badge.art.forEach((row, y) => {
      [...row].forEach((key, x) => {
        if (key === '.') return;
        // A locked badge is the same art as a flat silhouette: the shape is
        // a hint at what it is, the colour is the reward.
        ctx.fillStyle = locked ? '#2c1b52' : data.palette[key];
        ctx.fillRect(x * px, y * px, px, px);
      });
    });
  }

  // ---------- Rules ----------
  // Each returns true when earned. Everything they need is in one context
  // object built by the caller, so nothing here reaches into storage.
  const RULES = {
    finds: (r, c) => c.finds.filter((f) => f.lat !== null).length >= r.n,
    all_finds: (r, c) => c.questTotal > 0 && c.foundIds.size >= c.questTotal,
    placed: (r, c) => c.finds.filter((f) => f.px !== null).length >= r.n,
    category: (r, c) => {
      const inCat = c.quests.filter((q) => q.category === r.id);
      return inCat.length > 0 && inCat.every((q) => c.foundIds.has(q.id));
    },
    photo: (r, c) => c.stats.photos > 0,
    night: (r, c) => c.finds.some((f) => {
      const h = new Date(f.foundAt).getHours();
      return h >= 2 && h < 5;
    }),
    fast_three: (r, c) => {
      const times = c.finds.map((f) => f.foundAt).sort((a, b) => a - b);
      return times.some((t, i) => i >= 2 && t - times[i - 2] <= 3600000);
    },
    shared: (r, c) => c.stats.shares > 0,
    stars: (r, c) => c.favorites.length >= r.n,
    correction: (r, c) => c.overrides.length > 0,
    compass: (r, c) => c.stats.compass > 0,
    owl_taps: (r, c) => c.stats.owlTaps >= r.n,
    logo_taps: (r, c) => c.stats.logoTaps >= r.n,
    // Counting on past midnight means a 5am set is "29:00" -- see the
    // schedule format. Anything from 29:00 is a sunrise set.
    sunrise_star: (r, c) => c.favorites.some((id) => {
      const ev = c.events.find((e) => e.id === id);
      if (ev === undefined || ev.start === null) return false;
      return Number(ev.start.split(':')[0]) >= 29;
    })
  };

  function earned(badge, context) {
    const rule = RULES[badge.rule.type];
    if (rule === undefined) throw new Error(`No rule named "${badge.rule.type}" for badge ${badge.id}`);
    return rule(badge.rule, context);
  }

  // ---------- Awarding ----------
  async function evaluate(context) {
    context.stats = stats;
    const fresh = [];
    for (const badge of data.badges) {
      if (unlocked.has(badge.id)) continue;
      if (!earned(badge, context)) continue;
      unlocked.add(badge.id);
      fresh.push(badge);
    }
    if (fresh.length === 0) {
      render();
      return;
    }
    await Store.putUnlocked([...unlocked]);
    queue.push(...fresh);
    render();
    showNext();
  }

  // One at a time, so three unlocking together do not stack on top of each
  // other -- and never over the top of the find celebration, whose buttons
  // the toast sits directly on. The queue is flushed when that closes.
  function showNext() {
    if (queue.length === 0 || !els.toast.hidden) return;
    const celebrating = document.getElementById('celebrate');
    if (celebrating !== null && !celebrating.hidden) return;
    const badge = queue.shift();
    draw(els.toastArt, badge, false);
    els.toastName.textContent = badge.name;
    els.toastBlurb.textContent = badge.blurb;
    els.toast.hidden = false;
    // Goes away on its own. A toast that waits to be dismissed ends up
    // parked over whatever the person does next.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(dismissToast, 6000);
  }

  let toastTimer = null;

  function dismissToast() {
    clearTimeout(toastTimer);
    els.toast.hidden = true;
    showNext();
  }

  // ---------- The case ----------
  function render() {
    if (els.case === undefined || els.case === null) return;
    els.case.innerHTML = '';
    const total = data.badges.length;
    els.caseCount.textContent = `${unlocked.size} of ${total} badges`;
    for (const badge of data.badges) {
      const got = unlocked.has(badge.id);
      // A hidden badge gives nothing away until it is earned -- that is the
      // whole fun of it.
      const secret = badge.hidden === true && !got;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `trophy${got ? ' got' : ''}${secret ? ' secret' : ''}`;
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 48;
      if (!secret) draw(canvas, badge, !got);
      cell.appendChild(canvas);
      const name = document.createElement('span');
      name.textContent = secret ? '???' : badge.name;
      cell.appendChild(name);
      cell.title = secret ? 'Hidden badge — find it yourself' : `${badge.name}: ${badge.blurb}`;
      cell.addEventListener('click', () => {
        els.detail.textContent = secret
          ? 'A hidden one. No clues.'
          : `${badge.name} — ${badge.blurb}${got ? '' : ' (not yet)'}`;
      });
      els.case.appendChild(cell);
    }
  }

  // ---------- Counters the rules read ----------
  async function bump(key, by) {
    stats[key] += by === undefined ? 1 : by;
    await Store.putStats(stats);
  }

  const has = (id) => unlocked.has(id);
  const count = () => unlocked.size;

  async function init() {
    els.case = document.getElementById('badge-case');
    els.caseCount = document.getElementById('badge-count');
    els.detail = document.getElementById('badge-detail');
    els.toast = document.getElementById('badge-toast');
    els.toastArt = document.getElementById('badge-toast-art');
    els.toastName = document.getElementById('badge-toast-name');
    els.toastBlurb = document.getElementById('badge-toast-blurb');
    document.getElementById('badge-toast-close').addEventListener('click', dismissToast);

    const res = await fetch('/public/badges.json');
    if (!res.ok) throw new Error(`badges.json returned ${res.status}`);
    data = await res.json();

    unlocked = new Set(await Store.getUnlocked());
    const saved = await Store.getStats();
    if (saved !== null) stats = saved;
    render();
  }

  return { init, evaluate, bump, render, has, count, draw, flush: showNext };
})();
