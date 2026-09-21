// The schedule tab: every stage side by side on one grid, each one able to
// be toggled out, plus non-music tracks on the same footing. Favourites are
// this phone's; setlists received from other people ride alongside as
// initials on the sets they are going to.
const ScheduleUI = (() => {
  const $ = (id) => document.getElementById(id);

  // One grid row per quarter hour. Fine enough for a 15-minute changeover,
  // coarse enough that a whole festival day fits in one scroll.
  const SLOT_MIN = 15;
  const ROW_PX = 13;

  let data = null;
  let favorites = new Set();
  let setlists = [];
  let visibleTracks = new Set();
  let visibleFriends = new Set();
  let activeDay = null;
  let onlyMine = false;
  const els = {};

  // "25:30" means half one in the morning of the night that started that
  // day: festival days do not end at midnight, and neither should the grid.
  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function clockLabel(mins) {
    const h24 = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const ampm = h24 < 12 ? 'am' : 'pm';
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
  }

  const trackById = (id) => data.tracks.find((t) => t.id === id);

  // Who else is going, for the chips on a set.
  function friendsFor(eventId) {
    return setlists.filter((s) => visibleFriends.has(s.id) && s.eventIds.includes(eventId));
  }

  const initials = (name) => name.trim().slice(0, 2).toUpperCase();

  // ---------- Controls ----------
  function renderDays() {
    els.days.innerHTML = '';
    for (const day of data.days) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${day.id === activeDay ? ' on' : ''}`;
      b.textContent = day.note === undefined ? day.label : `${day.label} · ${day.note}`;
      b.addEventListener('click', () => {
        activeDay = day.id;
        render();
      });
      els.days.appendChild(b);
    }
  }

  function renderTrackChips() {
    els.tracks.innerHTML = '';
    for (const track of data.tracks) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip track${visibleTracks.has(track.id) ? ' on' : ''}`;
      b.style.setProperty('--chip', track.color);
      b.textContent = track.name;
      b.title = track.sound === '' ? track.name : `${track.name} — ${track.sound}`;
      b.addEventListener('click', () => {
        if (visibleTracks.has(track.id)) visibleTracks.delete(track.id);
        else visibleTracks.add(track.id);
        render();
      });
      els.tracks.appendChild(b);
    }

    // Received setlists get the same treatment as tracks: toggle a friend on
    // and their picks appear against yours.
    els.friends.innerHTML = '';
    for (const s of setlists) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip friend${visibleFriends.has(s.id) ? ' on' : ''}`;
      b.textContent = `${s.name} (${s.eventIds.length})`;
      b.addEventListener('click', () => {
        if (visibleFriends.has(s.id)) visibleFriends.delete(s.id);
        else visibleFriends.add(s.id);
        render();
      });
      els.friends.appendChild(b);
    }
    els.friendsRow.hidden = setlists.length === 0;
  }

  // ---------- Grid ----------
  function starButton(ev) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = `star${favorites.has(ev.id) ? ' on' : ''}`;
    star.textContent = favorites.has(ev.id) ? '★' : '☆';
    star.setAttribute('aria-label', favorites.has(ev.id) ? `Remove ${ev.title} from my schedule` : `Add ${ev.title} to my schedule`);
    star.addEventListener('click', async (e) => {
      e.stopPropagation();
      const on = !favorites.has(ev.id);
      await Store.toggleFavorite(ev.id, on);
      if (on) favorites.add(ev.id);
      else favorites.delete(ev.id);
      render();
    });
    return star;
  }

  function eventCard(ev, track) {
    const card = document.createElement('div');
    card.className = `ev${favorites.has(ev.id) ? ' mine' : ''}`;
    card.style.setProperty('--ev', track === undefined ? '#8a7bb8' : track.color);

    const title = document.createElement('span');
    title.className = 'ev-title';
    title.textContent = ev.title;
    card.append(title, starButton(ev));

    if (ev.start !== null) {
      const when = document.createElement('span');
      when.className = 'ev-when';
      when.textContent = `${clockLabel(toMinutes(ev.start))}–${clockLabel(toMinutes(ev.end))}`;
      card.appendChild(when);
    }
    if (ev.note !== undefined) {
      const note = document.createElement('span');
      note.className = 'ev-note';
      note.textContent = ev.note;
      card.appendChild(note);
    }

    const going = friendsFor(ev.id);
    if (going.length > 0) {
      const who = document.createElement('span');
      who.className = 'ev-friends';
      for (const s of going) {
        const chip = document.createElement('span');
        chip.className = 'who';
        chip.textContent = initials(s.name);
        chip.title = s.name;
        who.appendChild(chip);
      }
      card.appendChild(who);
    }
    return card;
  }

  function render() {
    renderDays();
    renderTrackChips();
    els.grid.innerHTML = '';
    els.tba.innerHTML = '';

    const day = data.days.find((d) => d.id === activeDay);
    const shown = data.tracks.filter((t) => visibleTracks.has(t.id));
    const wanted = (ev) => !onlyMine || favorites.has(ev.id);

    els.mine.classList.toggle('on', onlyMine);
    els.mine.textContent = onlyMine ? '★ My schedule' : '☆ My schedule';

    if (shown.length === 0) {
      els.grid.innerHTML = '<p class="empty">No stages selected. Tap one above.</p>';
      return;
    }

    const dayStart = toMinutes(day.start);
    const dayEnd = toMinutes(day.end);
    const rows = Math.ceil((dayEnd - dayStart) / SLOT_MIN);

    const timed = data.events.filter((e) => e.day === day.id && e.start !== null && visibleTracks.has(e.track) && wanted(e));

    els.grid.style.gridTemplateColumns = `48px repeat(${shown.length}, minmax(120px, 1fr))`;
    els.grid.style.gridTemplateRows = `28px repeat(${rows}, ${ROW_PX}px)`;

    // Header row of stage names.
    shown.forEach((track, i) => {
      const h = document.createElement('div');
      h.className = 'col-head';
      h.style.setProperty('--ev', track.color);
      h.textContent = track.name;
      h.style.gridColumn = `${i + 2}`;
      h.style.gridRow = '1';
      els.grid.appendChild(h);
    });

    // Hour rules down the time gutter.
    for (let t = dayStart; t <= dayEnd; t += 60) {
      const row = Math.round((t - dayStart) / SLOT_MIN) + 2;
      const lab = document.createElement('div');
      lab.className = 'hour';
      lab.textContent = clockLabel(t);
      lab.style.gridColumn = '1';
      lab.style.gridRow = `${row}`;
      els.grid.appendChild(lab);

      const rule = document.createElement('div');
      rule.className = 'rule';
      rule.style.gridColumn = `2 / ${shown.length + 2}`;
      rule.style.gridRow = `${row}`;
      els.grid.appendChild(rule);
    }

    for (const ev of timed) {
      const col = shown.findIndex((t) => t.id === ev.track);
      if (col === -1) continue;
      const startRow = Math.round((toMinutes(ev.start) - dayStart) / SLOT_MIN) + 2;
      const span = Math.max(2, Math.round((toMinutes(ev.end) - toMinutes(ev.start)) / SLOT_MIN));
      const card = eventCard(ev, trackById(ev.track));
      card.style.gridColumn = `${col + 2}`;
      card.style.gridRow = `${startRow} / span ${span}`;
      els.grid.appendChild(card);
    }

    if (timed.length === 0) {
      const none = document.createElement('p');
      none.className = 'empty';
      none.style.gridColumn = `1 / ${shown.length + 2}`;
      none.style.gridRow = `2 / span ${Math.min(rows, 6)}`;
      none.textContent = onlyMine
        ? 'Nothing starred on this day yet.'
        : 'No set times published for this day yet.';
      els.grid.appendChild(none);
    }

    // Anything announced without a time. It is still worth starring, and it
    // moves into the grid by itself the moment a time is filled in.
    const pending = data.events.filter((e) => e.start === null && wanted(e));
    if (pending.length === 0) return;
    const h = document.createElement('h3');
    h.textContent = 'Announced — times to come';
    els.tba.appendChild(h);
    for (const track of [...data.tracks, { id: null, name: 'Stage to be announced', color: '#8a7bb8' }]) {
      const mine = pending.filter((e) => e.track === track.id);
      if (mine.length === 0) continue;
      const group = document.createElement('div');
      group.className = 'tba-group';
      const label = document.createElement('h4');
      label.textContent = track.name;
      label.style.setProperty('--ev', track.color);
      group.appendChild(label);
      for (const ev of mine) group.appendChild(eventCard(ev, track));
      els.tba.appendChild(group);
    }
  }

  async function refresh() {
    const state = await Store.load();
    favorites = new Set(state.favorites);
    setlists = state.setlists;
    render();
  }

  // What this phone has starred, for the sharing sheet.
  const myFavorites = () => [...favorites];
  const eventTitle = (id) => {
    const ev = data === null ? undefined : data.events.find((e) => e.id === id);
    return ev === undefined ? id : ev.title;
  };

  async function init() {
    for (const id of ['sched-days', 'sched-tracks', 'sched-friends', 'sched-friends-row', 'sched-grid', 'sched-tba', 'sched-mine']) {
      els[id.replace('sched-', '').replace(/-(\w)/g, (m, c) => c.toUpperCase())] = $(id);
    }
    const res = await fetch('/public/schedule.json');
    if (!res.ok) throw new Error(`schedule.json returned ${res.status}`);
    data = await res.json();

    activeDay = data.days[0].id;
    // Stages on by default, activity tracks off: the grid should open on
    // what most people came for, not on everything at once.
    for (const t of data.tracks) {
      if (t.kind === 'stage') visibleTracks.add(t.id);
    }

    els.mine.addEventListener('click', () => {
      onlyMine = !onlyMine;
      render();
    });

    await refresh();
  }

  return { init, refresh, myFavorites, eventTitle };
})();
