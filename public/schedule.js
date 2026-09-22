// The schedule tab: every stage side by side on one grid, each one able to
// be toggled out, plus non-music tracks on the same footing. Favourites are
// this phone's; setlists received from other people ride alongside as
// initials on the sets they are going to.
const ScheduleUI = (() => {
  const $ = (id) => document.getElementById(id);

  // One grid row per quarter hour. Fine enough for a 15-minute changeover,
  // coarse enough that a whole festival day fits in one scroll.
  const SLOT_MIN = 15;
  const ROW_PX = 15;

  let data = null;
  let bundled = null;
  let favorites = new Set();
  let setlists = [];
  let overrides = new Map();
  let cloud = null;
  let announcements = [];
  let seen = new Set();
  let editing = null;
  let mergePick = null;
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

  // ---------- The override layer ----------
  // Published schedule underneath, this phone's edits on top. Patches hold
  // only the fields somebody actually changed, so a later sync still wins on
  // everything they did not touch.
  function effectiveEvents() {
    const out = [];
    for (const ev of data.events) {
      const o = overrides.get(ev.id);
      if (o === undefined) {
        out.push(ev);
        continue;
      }
      if (o.patch.status === 'merged') continue;
      out.push({ ...ev, ...o.patch, edited: true });
    }
    // Sets added by hand, which have no published event underneath them.
    for (const o of overrides.values()) {
      if (o.patch.isNew === true && o.patch.status !== 'merged') {
        out.push({ ...o.patch, id: o.eventId, edited: true });
      }
    }
    return out;
  }

  const editedCount = () => overrides.size;

  // ---------- Undo / redo ----------
  // Whole-snapshot history rather than per-field diffs. The override set is a
  // handful of small patches, so copying it is cheap, and it means every kind
  // of edit -- retime, merge, cancel, add -- undoes the same way. A merge in
  // particular touches two events at once, and undoing half of one is how an
  // act goes missing.
  const past = [];
  const future = [];
  const snapshot = () => [...overrides.values()].map((o) => ({ ...o, patch: { ...o.patch } }));

  function remember() {
    past.push(snapshot());
    if (past.length > 30) past.shift();
    future.length = 0;
    paintHistory();
  }

  async function restore(list) {
    // The store is the source of truth, so it is rewritten to match, not
    // patched alongside.
    for (const eventId of overrides.keys()) await Store.deleteOverride(eventId);
    overrides = new Map(list.map((o) => [o.eventId, o]));
    await Store.putOverrides(list);
    render();
    paintHistory();
    QuestsUI.score();
  }

  async function undo() {
    if (past.length === 0) return;
    future.push(snapshot());
    await restore(past.pop());
  }

  async function redo() {
    if (future.length === 0) return;
    past.push(snapshot());
    await restore(future.pop());
  }

  async function resetEdits() {
    if (overrides.size === 0) return;
    remember();
    await restore([]);
    els.syncNote.textContent = 'All your schedule edits are cleared. Undo still has them.';
  }

  function paintHistory() {
    els.undo.disabled = past.length === 0;
    els.redo.disabled = future.length === 0;
    els.reset.disabled = overrides.size === 0;
  }

  async function setOverride(eventId, patch) {
    const existing = overrides.get(eventId);
    const merged = { eventId, patch: { ...(existing === undefined ? {} : existing.patch), ...patch }, updatedAt: Date.now() };
    overrides.set(eventId, merged);
    await Store.putOverride(merged);
    paintHistory();
    QuestsUI.score();
  }

  // Clearing a merged act's override has to release whatever it absorbed,
  // or the absorbed one stays hidden with nothing left pointing at it --
  // which is an act quietly vanishing from the schedule.
  async function clearOverride(eventId) {
    const release = [...overrides.values()].filter((o) => o.patch.mergedInto === eventId);
    overrides.delete(eventId);
    await Store.deleteOverride(eventId);
    for (const o of release) {
      overrides.delete(o.eventId);
      await Store.deleteOverride(o.eventId);
    }
    paintHistory();
  }

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
      QuestsUI.score();
    });
    return star;
  }

  function eventCard(ev, track) {
    const card = document.createElement('div');
    card.className = `ev${favorites.has(ev.id) ? ' mine' : ''}${ev.edited === true ? ' edited' : ''}${ev.status === 'cancelled' ? ' cancelled' : ''}`;
    // Tapping the body edits; the star keeps its own handler.
    card.addEventListener('click', () => (mergePick === null ? openEditor(ev) : pickMerge(ev)));
    card.style.setProperty('--ev', track === undefined ? '#8a7bb8' : track.color);

    const title = document.createElement('span');
    title.className = 'ev-title';
    title.textContent = ev.title;
    card.append(title, starButton(ev));
    if (ev.edited === true) {
      const flag = document.createElement('span');
      flag.className = 'ev-flag';
      flag.textContent = ev.status === 'cancelled' ? 'cancelled' : 'changed';
      card.appendChild(flag);
    }

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

    const all = effectiveEvents();
    const timed = all.filter((e) => e.day === day.id && e.start !== null && visibleTracks.has(e.track) && wanted(e));

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
    const pending = all.filter((e) => e.start === null && wanted(e));
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

  // ---------- Editing ----------
  // One sheet does every kind of change, because a phone in a field is the
  // worst place to hunt through nested menus: retime, restage, rename,
  // merge into a b2b, cancel, or add something that was never published.
  function openEditor(ev) {
    editing = ev;
    els.edTitle.value = ev.title;
    els.edNote.value = ev.note === undefined ? '' : ev.note;
    fillTimePickers(ev);

    els.edDay.innerHTML = '<option value="">Day TBA</option>';
    for (const d of data.days) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      o.selected = d.id === ev.day;
      els.edDay.appendChild(o);
    }
    els.edTrack.innerHTML = '<option value="">Stage TBA</option>';
    for (const t of data.tracks) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name;
      o.selected = t.id === ev.track;
      els.edTrack.appendChild(o);
    }

    els.edReset.hidden = !overrides.has(ev.id);
    els.edCancel.textContent = ev.status === 'cancelled' ? 'Un-cancel' : 'Mark cancelled';
    els.edHint.textContent = '';
    els.editor.hidden = false;
  }

  function closeEditor() {
    els.editor.hidden = true;
    editing = null;
  }

  // Nobody should have to know that 1:30am is written 25:30. The hour list
  // spans the day's own window and labels the small hours as next morning,
  // so the ambiguity disappears instead of being explained.
  function hourLabel(h) {
    const h24 = h % 24;
    const ampm = h24 < 12 ? 'am' : 'pm';
    const twelve = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${twelve}${ampm}${h >= 24 ? ' (next morning)' : ''}`;
  }

  function fillTimePickers(ev) {
    const day = data.days.find((d) => d.id === ev.day) === undefined
      ? data.days.find((d) => d.id === activeDay)
      : data.days.find((d) => d.id === ev.day);
    const from = Math.floor(toMinutes(day.start) / 60);
    const to = Math.ceil(toMinutes(day.end) / 60);

    for (const [hSel, mSel, value] of [[els.edStartH, els.edStartM, ev.start], [els.edEndH, els.edEndM, ev.end]]) {
      hSel.innerHTML = '<option value="">—</option>';
      for (let h = from; h <= to; h++) {
        const o = document.createElement('option');
        o.value = String(h);
        o.textContent = hourLabel(h);
        hSel.appendChild(o);
      }
      mSel.innerHTML = '';
      for (let m = 0; m < 60; m += 5) {
        const o = document.createElement('option');
        o.value = String(m);
        o.textContent = `:${String(m).padStart(2, '0')}`;
        mSel.appendChild(o);
      }
      if (value === null) {
        hSel.value = '';
        mSel.value = '0';
      } else {
        const mins = toMinutes(value);
        hSel.value = String(Math.floor(mins / 60));
        // Snap to the nearest five, so an odd published time still loads.
        mSel.value = String(Math.round((mins % 60) / 5) * 5 % 60);
      }
    }
  }

  function readTime(hSel, mSel) {
    if (hSel.value === '') return null;
    const h = Number(hSel.value);
    const m = Number(mSel.value);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  async function saveEditor() {
    const start = readTime(els.edStartH, els.edStartM);
    const end = readTime(els.edEndH, els.edEndM);
    if ((start === null) !== (end === null)) {
      els.edHint.textContent = 'Pick both a start and an end, or leave both blank.';
      return;
    }
    if (start !== null && toMinutes(end) <= toMinutes(start)) {
      els.edHint.textContent = 'The end has to come after the start.';
      return;
    }
    const patch = {
      title: els.edTitle.value.trim(),
      note: els.edNote.value.trim(),
      day: els.edDay.value === '' ? null : els.edDay.value,
      track: els.edTrack.value === '' ? null : els.edTrack.value,
      start,
      end
    };
    if (editing.isNew === true) patch.isNew = true;
    remember();
    await setOverride(editing.id, patch);
    closeEditor();
    render();
  }

  async function toggleCancelled() {
    remember();
    await setOverride(editing.id, { status: editing.status === 'cancelled' ? 'on' : 'cancelled' });
    closeEditor();
    render();
  }

  async function resetEvent() {
    remember();
    await clearOverride(editing.id);
    closeEditor();
    render();
  }

  async function addEvent() {
    const day = data.days.find((d) => d.id === activeDay);
    const id = `local-${Store.newId()}`;
    remember();
    const patch = { isNew: true, title: 'New set', note: '', day: day.id, track: [...visibleTracks][0], start: null, end: null };
    await setOverride(id, patch);
    render();
    openEditor({ ...patch, id, edited: true });
  }

  // Merge is two taps: press Merge, then tap the other set. The one tapped
  // folds into this one and stops taking up a column.
  function startMerge() {
    mergePick = editing;
    closeEditor();
    els.mergeBar.hidden = false;
    els.mergeWhat.textContent = `Tap the set to merge into “${mergePick.title}”`;
  }

  function stopMerge() {
    mergePick = null;
    els.mergeBar.hidden = true;
  }

  async function pickMerge(other) {
    if (other.id === mergePick.id) {
      stopMerge();
      return;
    }
    const a = mergePick;
    const spanStart = a.start !== null && other.start !== null ? (toMinutes(a.start) <= toMinutes(other.start) ? a.start : other.start) : a.start;
    const spanEnd = a.end !== null && other.end !== null ? (toMinutes(a.end) >= toMinutes(other.end) ? a.end : other.end) : a.end;
    remember();
    await setOverride(a.id, { title: `${a.title} b2b ${other.title}`, start: spanStart, end: spanEnd });
    await setOverride(other.id, { status: 'merged', mergedInto: a.id });
    stopMerge();
    render();
  }

  // ---------- Cloud sync ----------
  // Most phones here have no signal, so this is a button and never a
  // background poll. The check pulls a version string only.
  async function checkCloud(quiet) {
    try {
      const res = await fetch('/api/schedule?check=1', { cache: 'no-store' });
      if (res.status === 503) {
        if (!quiet) els.syncNote.textContent = 'No schedule sheet is set up for this festival yet.';
        return;
      }
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const info = await res.json();
      const known = cloud === null ? null : cloud.version;
      els.sync.classList.toggle('has-update', info.version !== known);
      els.syncNote.textContent = info.version === known
        ? 'Up to date with the published schedule.'
        : 'A newer schedule is published. Tap Sync to pull it.';
    } catch (err) {
      if (!quiet) els.syncNote.textContent = `Can't reach the schedule right now (${err.message}). Your copy still works.`;
    }
  }

  // ---------- Announcements ----------
  function unreadCount() {
    return announcements.filter((a) => a.status !== 'reverted' && !seen.has(`${a.id}:${a.revision}`)).length;
  }

  function paintBell() {
    const n = unreadCount();
    els.bell.classList.toggle('unread', n > 0);
    els.bellCount.hidden = n === 0;
    els.bellCount.textContent = String(n);
  }

  function fieldLabel(field) {
    const names = { start: 'Start', end: 'End', track: 'Stage', day: 'Day', title: 'Act', note: 'Note', status: 'Status' };
    return names[field] === undefined ? field : names[field];
  }

  // A change reads as the thing people care about -- which act, from what to
  // what -- not as a row id.
  function diffLine(change) {
    const li = document.createElement('li');
    const ev = data.events.find((e) => e.id === change.eventId);
    const who = document.createElement('strong');
    who.textContent = ev === undefined ? change.eventId : ev.title;
    li.append(who, document.createTextNode(` · ${fieldLabel(change.field)} `));
    const was = document.createElement('span');
    was.className = 'was';
    was.textContent = change.from === '' ? '—' : change.from;
    const now = document.createElement('span');
    now.className = 'now';
    now.textContent = change.to === '' ? '—' : change.to;
    li.append(was, document.createTextNode(' → '), now);
    return li;
  }

  function renderNews() {
    els.newsList.innerHTML = '';
    if (announcements.length === 0) {
      els.newsNote.textContent = cloud === null
        ? 'Nothing yet. Announcements arrive with a sync when you have signal.'
        : 'Nothing posted yet.';
      return;
    }
    els.newsNote.textContent = `${announcements.length} post${announcements.length === 1 ? '' : 's'}, newest first.`;
    for (const a of announcements) {
      const li = document.createElement('li');
      const fresh = !seen.has(`${a.id}:${a.revision}`);
      li.className = `${a.status === 'reverted' ? 'reverted' : ''}${fresh ? ' fresh' : ''}`;

      const h = document.createElement('h3');
      h.textContent = a.title;
      if (a.status === 'reverted') {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'reverted';
        h.appendChild(tag);
      } else if (a.revision > 1) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = `revision ${a.revision}`;
        h.appendChild(tag);
      }
      li.appendChild(h);

      const when = document.createElement('div');
      when.className = 'when';
      const d = new Date(a.at);
      when.textContent = Number.isNaN(d.getTime()) ? a.at : d.toLocaleString();
      li.appendChild(when);

      if (a.body !== '') {
        const body = document.createElement('p');
        body.className = 'body';
        body.textContent = a.body;
        li.appendChild(body);
      }

      const applied = a.changes.filter((c) => c.status !== 'reverted');
      if (applied.length > 0) {
        const diffs = document.createElement('ul');
        diffs.className = 'diffs';
        for (const c of applied) diffs.appendChild(diffLine(c));
        li.appendChild(diffs);
      }

      if (a.url !== '') {
        const link = document.createElement('a');
        link.className = 'src';
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'See the original post →';
        li.appendChild(link);
      }
      els.newsList.appendChild(li);
    }
  }

  async function openNews() {
    renderNews();
    els.news.hidden = false;
    // Seen is keyed by revision, so a corrected post lights the bell again.
    seen = new Set(announcements.map((a) => `${a.id}:${a.revision}`));
    await Store.putSeen([...seen]);
    paintBell();
  }

  async function syncNow() {
    els.syncNote.textContent = 'Syncing…';
    try {
      const res = await fetch('/api/schedule', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error);
      }
      const info = await res.json();
      await Store.putCloudSchedule(info.version, info.at, info.schedule, info.announcements);
      cloud = { version: info.version, at: info.at, schedule: info.schedule, announcements: info.announcements };
      data = info.schedule;
      announcements = info.announcements;
      paintBell();
      els.sync.classList.remove('has-update');
      // Edits survive a sync by design: they sit on top, keyed by event id.
      els.syncNote.textContent = `Synced. ${data.events.length} sets${editedCount() > 0 ? `, your ${editedCount()} change${editedCount() === 1 ? '' : 's'} kept on top` : ''}.`;
      render();
    } catch (err) {
      els.syncNote.textContent = `Sync failed: ${err.message}`;
    }
  }

  async function refresh() {
    const state = await Store.load();
    favorites = new Set(state.favorites);
    setlists = state.setlists;
    overrides = new Map(state.overrides.map((o) => [o.eventId, o]));
    cloud = state.cloud;
    paintHistory();
    announcements = cloud === null || cloud.announcements === undefined ? [] : cloud.announcements;
    seen = new Set(await Store.getSeen());
    paintBell();
    // A schedule pulled from the sheet outranks the one that shipped in the
    // build; without one, the build's copy is what there is.
    data = cloud === null ? bundled : cloud.schedule;
    render();
  }

  // What this phone has starred, for the sharing sheet.
  const myFavorites = () => [...favorites];
  const eventTitle = (id) => {
    const ev = data === null ? undefined : data.events.find((e) => e.id === id);
    return ev === undefined ? id : ev.title;
  };

  async function init() {
    for (const id of [
      'sched-days', 'sched-tracks', 'sched-friends', 'sched-friends-row', 'sched-grid', 'sched-tba',
      'sched-mine', 'sched-add', 'sched-sync', 'sched-sync-note', 'bell', 'bell-count', 'news', 'news-list', 'news-note', 'news-close', 'sched-editor', 'sched-merge-bar', 'sched-merge-what', 'sched-merge-stop',
      'sched-ed-title', 'sched-ed-note', 'sched-ed-day', 'sched-ed-track',
      'sched-ed-start-h', 'sched-ed-start-m', 'sched-ed-end-h', 'sched-ed-end-m',
      'sched-undo', 'sched-redo', 'sched-reset',
      'sched-ed-save', 'sched-ed-close', 'sched-ed-cancel', 'sched-ed-reset', 'sched-ed-merge', 'sched-ed-hint'
    ]) {
      els[id.replace('sched-', '').replace(/-(\w)/g, (m, c) => c.toUpperCase())] = $(id);
    }
    const res = await fetch('/public/schedule.json');
    if (!res.ok) throw new Error(`schedule.json returned ${res.status}`);
    bundled = await res.json();
    data = bundled;

    activeDay = data.days[0].id;
    // Stages that actually have sets are on; activity tracks and stages with
    // nothing programmed stay off, so the grid does not open with an empty
    // column eating a quarter of a phone's width.
    const programmed = new Set(data.events.map((e) => e.track));
    for (const t of data.tracks) {
      if (t.kind === 'stage' && programmed.has(t.id)) visibleTracks.add(t.id);
    }
    if (visibleTracks.size === 0) {
      for (const t of data.tracks) {
        if (t.kind === 'stage') visibleTracks.add(t.id);
      }
    }

    els.mine.addEventListener('click', () => {
      onlyMine = !onlyMine;
      render();
    });
    els.add.addEventListener('click', addEvent);
    els.sync.addEventListener('click', syncNow);
    els.edSave.addEventListener('click', saveEditor);
    els.edClose.addEventListener('click', closeEditor);
    els.edCancel.addEventListener('click', toggleCancelled);
    els.edReset.addEventListener('click', resetEvent);
    els.edMerge.addEventListener('click', startMerge);
    els.undo.addEventListener('click', undo);
    els.redo.addEventListener('click', redo);
    els.reset.addEventListener('click', resetEdits);
    els.mergeStop.addEventListener('click', stopMerge);

    els.bell.addEventListener('click', openNews);
    els.newsClose.addEventListener('click', () => { els.news.hidden = true; });

    await refresh();
    // Quiet: a phone with no signal should not open on an error.
    checkCloud(true);

    // Catching up whenever a signal turns up. There is no way to poll while
    // the app is closed -- iOS has neither Background Sync nor Periodic
    // Background Sync, so nothing runs in the background there -- but every
    // moment the app is actually on screen with a connection is used:
    // the network coming back, and the app returning to the foreground.
    let lastCheck = 0;
    const maybeCheck = () => {
      if (!navigator.onLine) return;
      // A phone flapping between bars should not fire a request a second.
      if (Date.now() - lastCheck < 60000) return;
      lastCheck = Date.now();
      checkCloud(true);
    };
    window.addEventListener('online', maybeCheck);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) maybeCheck();
    });
  }

  // Shared over QR alongside points and favourites.
  const myOverrides = () => [...overrides.values()];
  async function applyOverrides(list) {
    await Store.putOverrides(list);
    for (const o of list) overrides.set(o.eventId, o);
    render();
  }

  // Badge rules need the sets themselves, to spot a sunrise starring.
  const events = () => (data === null ? [] : data.events);

  return { init, refresh, myFavorites, myOverrides, applyOverrides, editedCount, eventTitle, checkCloud, unreadCount, events };
})();
