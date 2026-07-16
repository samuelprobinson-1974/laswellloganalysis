/* ============================================================
   Onebit VFD Player  —  client-side MP3 player
   - Loads local audio files from the phone
   - Persists tracks + playlists in IndexedDB (survive reloads)
   - Rockbox Onebit / VFD styled, touch + hardware-button nav
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- IndexedDB ---------------- */
  const DB_NAME = 'onebit-vfd';
  const DB_VER = 1;
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const dbPut = (store, val) => new Promise((res, rej) => { const r = tx(store, 'readwrite').put(val); r.onsuccess = () => res(val); r.onerror = () => rej(r.error); });
  const dbGet = (store, key) => new Promise((res, rej) => { const r = tx(store, 'readonly').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const dbAll = (store) => new Promise((res, rej) => { const r = tx(store, 'readonly').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
  const dbDel = (store, key) => new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });

  /* ---------------- ID3v2 tag parser (compact) ---------------- */
  function decodeText(bytes, enc) {
    try {
      if (enc === 0) return new TextDecoder('iso-8859-1').decode(bytes).replace(/\0+$/, '');
      if (enc === 1) return new TextDecoder('utf-16').decode(bytes).replace(/\0+$/, '');
      if (enc === 2) return new TextDecoder('utf-16be').decode(bytes).replace(/\0+$/, '');
      return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
    } catch { return ''; }
  }
  function synchsafe(b0, b1, b2, b3) { return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3; }

  function parseID3(buf) {
    const out = { title: '', artist: '', album: '', picBlob: null };
    try {
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      if (String.fromCharCode(u8[0], u8[1], u8[2]) !== 'ID3') return out;
      const major = u8[3];
      const tagSize = synchsafe(u8[6], u8[7], u8[8], u8[9]);
      let pos = 10;
      const end = Math.min(10 + tagSize, u8.length);
      const frameHeader = 10;
      while (pos + frameHeader <= end) {
        const id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        let size;
        if (major === 4) size = synchsafe(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
        else size = dv.getUint32(pos + 4);
        if (size <= 0 || pos + frameHeader + size > end + 1) break;
        const body = u8.subarray(pos + frameHeader, pos + frameHeader + size);
        if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
          const val = decodeText(body.subarray(1), body[0]);
          if (id === 'TIT2') out.title = val;
          else if (id === 'TPE1') out.artist = val;
          else out.album = val;
        } else if (id === 'APIC' && !out.picBlob) {
          try {
            const enc = body[0];
            let p = 1;
            while (p < body.length && body[p] !== 0) p++;          // mime
            const mime = decodeText(body.subarray(1, p), 0) || 'image/jpeg';
            p++;                                                    // skip null
            p++;                                                    // picture type
            // description: null-terminated (1 or 2 bytes depending on enc)
            if (enc === 1 || enc === 2) { while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2; p += 2; }
            else { while (p < body.length && body[p] !== 0) p++; p++; }
            const pic = body.subarray(p);
            if (pic.length > 0) out.picBlob = new Blob([pic], { type: mime });
          } catch {}
        }
        pos += frameHeader + size;
      }
    } catch {}
    return out;
  }

  /* ---------------- State ---------------- */
  const state = {
    tracks: new Map(),          // id -> meta
    order: [],                  // library display order (ids)
    playlists: [],              // {id,name,trackIds:[]}
    queue: [],                  // ids in play order
    qIndex: -1,
    shuffle: false,
    repeat: 'off',              // off | all | one
    volume: 0.8,
    view: 'wps',
    stack: [],
    sel: {},                    // view -> selected index
    curPlaylistId: null,
    curArtUrl: null,
  };

  /* ---------------- DOM refs ---------------- */
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const views = {
    wps: $('view-wps'), menu: $('view-menu'), library: $('view-library'),
    playlists: $('view-playlists'), playlist: $('view-playlist'),
    queue: $('view-queue'), settings: $('view-settings'),
  };

  /* ---------------- Utilities ---------------- */
  const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }
  function baseName(name) { return name.replace(/\.[a-z0-9]+$/i, ''); }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1900);
  }

  /* ---------------- Import files ---------------- */
  async function addFiles(fileList) {
    const files = Array.from(fileList).filter(f => /audio|\.(mp3|m4a|aac|ogg|oga|wav|flac|opus)$/i.test(f.type + ' ' + f.name));
    if (!files.length) { toast('NO AUDIO FILES'); return; }
    toast('IMPORTING ' + files.length + '...');
    let added = 0;
    for (const f of files) {
      try {
        let tags = { title: '', artist: '', album: '', picBlob: null };
        if (/mp3|mpeg/i.test(f.type) || /\.mp3$/i.test(f.name)) {
          const slice = f.slice(0, Math.min(f.size, 3 * 1024 * 1024));
          tags = parseID3(await slice.arrayBuffer());
        }
        const meta = {
          id: uid(),
          name: f.name,
          size: f.size,
          type: f.type || 'audio/mpeg',
          title: tags.title || baseName(f.name),
          artist: tags.artist || 'Unknown Artist',
          album: tags.album || 'Unknown Album',
          duration: null,
          picBlob: tags.picBlob || null,
          blob: f,
          addedAt: Date.now(),
        };
        await dbPut('tracks', meta);
        state.tracks.set(meta.id, meta);
        state.order.push(meta.id);
        added++;
      } catch (e) { console.warn('import failed', f.name, e); }
    }
    toast(added + ' TRACK' + (added === 1 ? '' : 'S') + ' ADDED');
    renderLibrary();
    renderMenu();
  }

  /* ---------------- Playback ---------------- */
  function trackUrl(meta) {
    if (!meta._url) meta._url = URL.createObjectURL(meta.blob);
    return meta._url;
  }

  function buildQueue(ids, startId) {
    let q = ids.slice();
    if (state.shuffle) {
      // Fisher-Yates but keep startId first
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j], q[i]];
      }
      if (startId) { q = q.filter(x => x !== startId); q.unshift(startId); }
    }
    state.queue = q;
    state.qIndex = startId ? q.indexOf(startId) : 0;
  }

  function playQueueAt(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.qIndex = i;
    const meta = state.tracks.get(state.queue[i]);
    if (!meta) return;
    audio.src = trackUrl(meta);
    audio.play().catch(() => {});
    updateWps();
    renderCurrentListPlaying();
    saveKv('last', { queue: state.queue, qIndex: state.qIndex });
  }

  function playFrom(ids, startId) {
    buildQueue(ids, startId);
    playQueueAt(state.qIndex);
    setView('wps');
  }

  function togglePlay() {
    if (!audio.src) {
      if (state.queue.length) playQueueAt(state.qIndex >= 0 ? state.qIndex : 0);
      else if (state.order.length) playFrom(state.order, state.order[0]);
      return;
    }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  }

  function next(auto) {
    if (!state.queue.length) return;
    if (state.repeat === 'one' && auto) { audio.currentTime = 0; audio.play(); return; }
    let i = state.qIndex + 1;
    if (i >= state.queue.length) {
      if (state.repeat === 'all' || !auto) i = 0;
      else { audio.pause(); return; }
    }
    playQueueAt(i);
  }
  function prev() {
    if (!state.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    let i = state.qIndex - 1;
    if (i < 0) i = state.repeat === 'all' ? state.queue.length - 1 : 0;
    playQueueAt(i);
  }

  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', () => {
    const meta = curMeta();
    if (meta && (meta.duration == null || !isFinite(meta.duration))) {
      meta.duration = audio.duration;
      dbGet('tracks', meta.id).then(t => { if (t) { t.duration = audio.duration; dbPut('tracks', t); } });
    }
    updateProgress();
  });
  audio.addEventListener('play', () => { setState('play'); updateWps(); });
  audio.addEventListener('pause', () => { setState('pause'); });

  function curMeta() { return state.qIndex >= 0 ? state.tracks.get(state.queue[state.qIndex]) : null; }

  /* ---------------- Now Playing render ---------------- */
  function setState(s) {
    $('sbState').innerHTML = s === 'play' ? '&#9654;' : '&#9646;&#9646;';
  }
  function updateProgress() {
    const d = audio.duration || (curMeta() && curMeta().duration) || 0;
    const c = audio.currentTime || 0;
    const pct = d ? (c / d) * 100 : 0;
    $('progressFill').style.width = pct + '%';
    $('progressKnob').style.left = pct + '%';
    $('tElapsed').textContent = fmtTime(c);
    $('tTotal').textContent = fmtTime(d);
    $('tIndex').textContent = state.queue.length ? (state.qIndex + 1) + ' / ' + state.queue.length : '0 / 0';
  }
  function updateWps() {
    const meta = curMeta();
    const titleEl = $('wpsTitle'), wrap = $('wpsTitleWrap');
    if (!meta) {
      titleEl.textContent = 'NO TRACK LOADED';
      $('wpsArtist').textContent = '—';
      $('wpsAlbum').textContent = '—';
      $('sbTitle').textContent = 'ONEBIT VFD';
      showArt(null);
      return;
    }
    titleEl.textContent = meta.title;
    $('wpsArtist').textContent = meta.artist;
    $('wpsAlbum').textContent = meta.album;
    $('sbTitle').textContent = meta.title;
    // marquee if overflow
    requestAnimationFrame(() => {
      const overflow = titleEl.scrollWidth - wrap.clientWidth;
      if (overflow > 4) { wrap.classList.add('scroll'); wrap.style.setProperty('--shift', (-overflow - 6) + 'px'); }
      else wrap.classList.remove('scroll');
    });
    showArt(meta.picBlob);
    updateFlags();
    updateMediaSession(meta);
  }
  function showArt(picBlob) {
    const img = $('artImg'), fb = $('artFallback');
    if (state.curArtUrl) { URL.revokeObjectURL(state.curArtUrl); state.curArtUrl = null; }
    if (picBlob) {
      state.curArtUrl = URL.createObjectURL(picBlob);
      img.src = state.curArtUrl; img.hidden = false; fb.hidden = true;
    } else { img.hidden = true; fb.hidden = false; }
  }
  function updateFlags() {
    $('flagShuffle').classList.toggle('on', state.shuffle);
    const r = $('flagRepeat');
    r.classList.toggle('on', state.repeat !== 'off');
    r.textContent = state.repeat === 'one' ? 'RPT1' : 'RPT';
    $('flagVol').textContent = 'VOL ' + Math.round(state.volume * 100);
  }

  /* ---------------- Media Session (lock screen) ---------------- */
  function updateMediaSession(meta) {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = [];
      if (state.curArtUrl) art.push({ src: state.curArtUrl, sizes: '512x512' });
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title, artist: meta.artist, album: meta.album, artwork: art,
      });
    } catch {}
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => audio.play());
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('previoustrack', () => prev());
    ms.setActionHandler('nexttrack', () => next(false));
  }

  /* ---------------- Seek / progress interaction ---------------- */
  const pbar = $('progressBar');
  function seekFromEvent(e) {
    const rect = pbar.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const d = audio.duration || (curMeta() && curMeta().duration) || 0;
    if (d) audio.currentTime = pct * d;
  }
  pbar.addEventListener('click', seekFromEvent);

  /* ---------------- Views / navigation ---------------- */
  function setView(name, push) {
    if (push && state.view !== name) state.stack.push(state.view);
    state.view = name;
    for (const k in views) views[k].classList.toggle('active', k === name);
    if (name === 'library') renderLibrary();
    else if (name === 'playlists') renderPlaylists();
    else if (name === 'menu') renderMenu();
    else if (name === 'queue') renderQueue();
    else if (name === 'settings') renderSettings();
    else if (name === 'playlist') renderPlaylist();
    ensureSel(name);
    highlight(name);
  }
  function back() {
    if (state.view === 'wps') return;
    const prevView = state.stack.pop() || 'wps';
    state.view = prevView;
    setView(prevView);
  }

  function listEl(view) {
    return { menu: $('menuList'), library: $('libraryList'), playlists: $('playlistList'),
      playlist: $('playlistTracks'), queue: $('queueList'), settings: $('settingsList') }[view];
  }
  function rows(view) { const el = listEl(view); return el ? Array.from(el.children).filter(c => c.classList.contains('row')) : []; }
  function ensureSel(view) { if (state.sel[view] == null) state.sel[view] = 0; const n = rows(view).length; if (state.sel[view] >= n) state.sel[view] = Math.max(0, n - 1); }
  function highlight(view) {
    const rs = rows(view);
    rs.forEach((r, i) => r.classList.toggle('sel', i === state.sel[view]));
    const cur = rs[state.sel[view]];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function move(dir) {
    if (state.view === 'wps') { // up/down on WPS = volume
      setVolume(state.volume + (dir < 0 ? 0.05 : -0.05));
      return;
    }
    const rs = rows(state.view);
    if (!rs.length) return;
    state.sel[state.view] = (state.sel[state.view] + dir + rs.length) % rs.length;
    highlight(state.view);
  }
  function activate() {
    if (state.view === 'wps') { togglePlay(); return; }
    const rs = rows(state.view);
    const cur = rs[state.sel[state.view]];
    if (cur && cur._action) cur._action();
  }

  function setVolume(v) {
    state.volume = Math.max(0, Math.min(1, v));
    audio.volume = state.volume;
    updateFlags();
    saveKv('volume', state.volume);
    if (state.view === 'wps') toast('VOL ' + Math.round(state.volume * 100));
  }

  /* ---------------- Row builder ---------------- */
  function makeRow({ ic, main, sub, end, action, playing }) {
    const li = document.createElement('li');
    li.className = 'row' + (playing ? ' playing' : '');
    const icEl = document.createElement('span'); icEl.className = 'row-ic'; icEl.innerHTML = ic || '';
    const col = document.createElement('div'); col.className = 'row-col';
    const mainEl = document.createElement('div'); mainEl.className = 'row-main'; mainEl.textContent = main;
    col.appendChild(mainEl);
    if (sub) { const s = document.createElement('div'); s.className = 'row-sub'; s.textContent = sub; col.appendChild(s); }
    li.appendChild(icEl); li.appendChild(col);
    if (end) { const e = document.createElement('span'); e.className = 'row-end'; e.textContent = end; li.appendChild(e); }
    li._action = action;
    li.addEventListener('click', () => {
      const idx = rows(state.view).indexOf(li);
      if (idx >= 0) { state.sel[state.view] = idx; highlight(state.view); }
      if (action) action();
    });
    return li;
  }

  /* ---------------- Renderers ---------------- */
  function renderMenu() {
    const el = $('menuList'); el.innerHTML = '';
    el.appendChild(makeRow({ ic: '&#9654;', main: 'NOW PLAYING', end: curMeta() ? '' : '', action: () => setView('wps', true) }));
    el.appendChild(makeRow({ ic: '&#9835;', main: 'LIBRARY', end: state.tracks.size + '', action: () => setView('library', true) }));
    el.appendChild(makeRow({ ic: '&#9776;', main: 'PLAYLISTS', end: state.playlists.length + '', action: () => setView('playlists', true) }));
    el.appendChild(makeRow({ ic: '&#9834;', main: 'PLAY QUEUE', end: state.queue.length + '', action: () => setView('queue', true) }));
    el.appendChild(makeRow({ ic: '+', main: 'ADD FILES', action: () => $('fileInput').click() }));
    el.appendChild(makeRow({ ic: '&#9881;', main: 'SETTINGS', action: () => setView('settings', true) }));
    if (state.view === 'menu') highlight('menu');
  }

  function renderLibrary() {
    const el = $('libraryList'); el.innerHTML = '';
    $('libTitle').innerHTML = '&#9654; LIBRARY &nbsp;[' + state.tracks.size + ']';
    if (!state.order.length) {
      el.innerHTML = '<li class="empty-hint">NO TRACKS YET.<br>USE "ADD FILES" TO LOAD<br>MUSIC FROM YOUR PHONE.</li>';
      return;
    }
    const curId = state.queue[state.qIndex];
    for (const id of state.order) {
      const m = state.tracks.get(id); if (!m) continue;
      el.appendChild(makeRow({
        ic: id === curId ? '&#9654;' : '&#9834;',
        main: m.title, sub: m.artist,
        playing: id === curId,
        action: () => openTrackMenu(id, 'library'),
      }));
    }
    if (state.view === 'library') highlight('library');
  }

  function renderQueue() {
    const el = $('queueList'); el.innerHTML = '';
    if (!state.queue.length) { el.innerHTML = '<li class="empty-hint">QUEUE IS EMPTY.</li>'; return; }
    state.queue.forEach((id, i) => {
      const m = state.tracks.get(id); if (!m) return;
      el.appendChild(makeRow({
        ic: i === state.qIndex ? '&#9654;' : (i + 1) + '',
        main: m.title, sub: m.artist, playing: i === state.qIndex,
        action: () => { playQueueAt(i); setView('wps'); },
      }));
    });
    if (state.view === 'queue') highlight('queue');
  }

  function renderPlaylists() {
    const el = $('playlistList'); el.innerHTML = '';
    el.appendChild(makeRow({ ic: '+', main: 'NEW PLAYLIST', action: () => createPlaylistPrompt() }));
    if (state.queue.length) {
      el.appendChild(makeRow({ ic: '&#9733;', main: 'SAVE CURRENT QUEUE', sub: state.queue.length + ' tracks', action: () => saveQueueAsPlaylist() }));
    }
    for (const pl of state.playlists) {
      el.appendChild(makeRow({
        ic: '&#9776;', main: pl.name, end: pl.trackIds.length + '',
        action: () => { state.curPlaylistId = pl.id; setView('playlist', true); },
      }));
    }
    if (state.view === 'playlists') highlight('playlists');
  }

  function renderPlaylist() {
    const el = $('playlistTracks'); el.innerHTML = '';
    const pl = state.playlists.find(p => p.id === state.curPlaylistId);
    if (!pl) { back(); return; }
    $('plTitle').innerHTML = '&#9654; ' + esc(pl.name.toUpperCase());
    el.appendChild(makeRow({ ic: '&#9654;', main: 'PLAY ALL', sub: pl.trackIds.length + ' tracks',
      action: () => { if (pl.trackIds.length) playFrom(pl.trackIds, pl.trackIds[0]); else toast('EMPTY'); } }));
    el.appendChild(makeRow({ ic: '&#9835;', main: 'ADD FROM LIBRARY', action: () => addToPlaylistPicker(pl.id) }));
    el.appendChild(makeRow({ ic: '&#10005;', main: 'DELETE PLAYLIST', action: () => confirmDeletePlaylist(pl) }));
    const curId = state.queue[state.qIndex];
    if (!pl.trackIds.length) {
      const li = document.createElement('li'); li.className = 'empty-hint'; li.textContent = 'NO TRACKS. ADD SOME.';
      el.appendChild(li);
    }
    pl.trackIds.forEach((id) => {
      const m = state.tracks.get(id); if (!m) return;
      el.appendChild(makeRow({
        ic: id === curId ? '&#9654;' : '&#9834;', main: m.title, sub: m.artist, playing: id === curId,
        action: () => openPlaylistTrackMenu(pl, id),
      }));
    });
    if (state.view === 'playlist') highlight('playlist');
  }

  function renderSettings() {
    const el = $('settingsList'); el.innerHTML = '';
    el.appendChild(makeRow({ ic: '&#8646;', main: 'SHUFFLE', end: state.shuffle ? 'ON' : 'OFF',
      action: () => { state.shuffle = !state.shuffle; saveKv('shuffle', state.shuffle); if (state.queue.length) buildQueue(state.order.length ? state.queue : state.order, curMeta() && curMeta().id); updateFlags(); renderSettings(); toast('SHUFFLE ' + (state.shuffle ? 'ON' : 'OFF')); } }));
    el.appendChild(makeRow({ ic: '&#8635;', main: 'REPEAT', end: state.repeat.toUpperCase(),
      action: () => { state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off'; saveKv('repeat', state.repeat); updateFlags(); renderSettings(); toast('REPEAT ' + state.repeat.toUpperCase()); } }));
    el.appendChild(makeRow({ ic: '&#128266;', main: 'VOLUME', end: Math.round(state.volume * 100) + '%',
      action: () => setVolume(state.volume >= 1 ? 0.1 : state.volume + 0.1) }));
    el.appendChild(makeRow({ ic: '+', main: 'ADD FILES', action: () => $('fileInput').click() }));
    el.appendChild(makeRow({ ic: '&#10005;', main: 'CLEAR LIBRARY', sub: 'removes all tracks + playlists', action: () => confirmClearAll() }));
    el.appendChild(makeRow({ ic: 'i', main: 'ABOUT', action: () => showModal('ABOUT', '<div style="line-height:1.7">ONEBIT VFD PLAYER<br>ROCKBOX-STYLE MP3 PLAYER<br>PLAYS LOCAL FILES &bull; SAVES PLAYLISTS<br>100% ON-DEVICE &bull; NOTHING UPLOADED</div>', [{ label: 'OK', action: hideModal }]) }));
    if (state.view === 'settings') highlight('settings');
  }

  // Refresh playing highlight in whatever list is showing
  function renderCurrentListPlaying() {
    if (state.view === 'library') renderLibrary();
    else if (state.view === 'queue') renderQueue();
    else if (state.view === 'playlist') renderPlaylist();
  }

  /* ---------------- Track context menus ---------------- */
  function openTrackMenu(id, from) {
    const m = state.tracks.get(id); if (!m) return;
    showModal(m.title.slice(0, 40), '', [
      { label: 'PLAY', action: () => { hideModal(); playFrom(state.order, id); } },
      { label: 'ADD TO PLAYLIST', action: () => { hideModal(); choosePlaylistFor(id); } },
      { label: 'REMOVE', action: () => { hideModal(); deleteTrack(id); } },
      { label: 'CANCEL', action: hideModal },
    ]);
  }
  function openPlaylistTrackMenu(pl, id) {
    const m = state.tracks.get(id); if (!m) return;
    showModal(m.title.slice(0, 40), '', [
      { label: 'PLAY', action: () => { hideModal(); playFrom(pl.trackIds, id); } },
      { label: 'REMOVE FROM PLAYLIST', action: () => { hideModal(); removeFromPlaylist(pl.id, id); } },
      { label: 'CANCEL', action: hideModal },
    ]);
  }

  /* ---------------- Playlist ops ---------------- */
  async function persistPlaylist(pl) { await dbPut('playlists', { id: pl.id, name: pl.name, trackIds: pl.trackIds }); }

  function createPlaylistPrompt(afterCreate) {
    showPrompt('NEW PLAYLIST', 'PLAYLIST NAME', '', async (name) => {
      name = (name || '').trim();
      if (!name) return;
      const pl = { id: 'p' + Date.now().toString(36), name, trackIds: [] };
      state.playlists.push(pl);
      await persistPlaylist(pl);
      renderPlaylists();
      toast('CREATED "' + name + '"');
      if (afterCreate) afterCreate(pl);
    });
  }

  async function saveQueueAsPlaylist() {
    if (!state.queue.length) return;
    showPrompt('SAVE QUEUE', 'PLAYLIST NAME', 'Queue ' + new Date().toLocaleDateString(), async (name) => {
      name = (name || '').trim(); if (!name) return;
      const pl = { id: 'p' + Date.now().toString(36), name, trackIds: state.queue.slice() };
      state.playlists.push(pl); await persistPlaylist(pl); renderPlaylists();
      toast('SAVED ' + pl.trackIds.length + ' TRACKS');
    });
  }

  function choosePlaylistFor(trackId) {
    const opts = state.playlists.map(pl => ({
      label: pl.name + '  (' + pl.trackIds.length + ')',
      action: () => { hideModal(); addToPlaylist(pl.id, trackId); },
    }));
    opts.unshift({ label: '+ NEW PLAYLIST', action: () => { hideModal(); createPlaylistPrompt((pl) => addToPlaylist(pl.id, trackId)); } });
    opts.push({ label: 'CANCEL', action: hideModal });
    showModal('ADD TO PLAYLIST', '', opts);
  }

  async function addToPlaylist(plId, trackId) {
    const pl = state.playlists.find(p => p.id === plId); if (!pl) return;
    if (!pl.trackIds.includes(trackId)) pl.trackIds.push(trackId);
    await persistPlaylist(pl);
    toast('ADDED TO ' + pl.name.toUpperCase());
    if (state.view === 'playlist') renderPlaylist();
    if (state.view === 'playlists') renderPlaylists();
  }
  async function removeFromPlaylist(plId, trackId) {
    const pl = state.playlists.find(p => p.id === plId); if (!pl) return;
    pl.trackIds = pl.trackIds.filter(x => x !== trackId);
    await persistPlaylist(pl);
    renderPlaylist();
    toast('REMOVED');
  }

  // Multi-add from library into a playlist
  function addToPlaylistPicker(plId) {
    const pl = state.playlists.find(p => p.id === plId); if (!pl) return;
    if (!state.order.length) { toast('LIBRARY EMPTY'); return; }
    const chosen = new Set();
    const body = document.createElement('div');
    for (const id of state.order) {
      const m = state.tracks.get(id); if (!m) continue;
      const row = document.createElement('div'); row.className = 'opt';
      const box = document.createElement('span'); box.textContent = pl.trackIds.includes(id) ? '[x]' : '[ ]';
      if (pl.trackIds.includes(id)) chosen.add(id);
      const label = document.createElement('span'); label.textContent = m.title;
      row.appendChild(box); row.appendChild(label);
      row.addEventListener('click', () => {
        if (chosen.has(id)) { chosen.delete(id); box.textContent = '[ ]'; }
        else { chosen.add(id); box.textContent = '[x]'; }
      });
      body.appendChild(row);
    }
    showModal('ADD TRACKS', body, [
      { label: 'SAVE', action: async () => { pl.trackIds = Array.from(chosen); await persistPlaylist(pl); hideModal(); renderPlaylist(); toast('SAVED ' + pl.trackIds.length + ' TRACKS'); } },
      { label: 'CANCEL', action: hideModal },
    ]);
  }

  function confirmDeletePlaylist(pl) {
    showModal('DELETE PLAYLIST?', 'REMOVE "' + esc(pl.name) + '"? TRACKS STAY IN LIBRARY.', [
      { label: 'DELETE', action: async () => { state.playlists = state.playlists.filter(p => p.id !== pl.id); await dbDel('playlists', pl.id); hideModal(); setView('playlists'); toast('DELETED'); } },
      { label: 'CANCEL', action: hideModal },
    ]);
  }

  async function deleteTrack(id) {
    const m = state.tracks.get(id);
    if (m && m._url) { URL.revokeObjectURL(m._url); }
    state.tracks.delete(id);
    state.order = state.order.filter(x => x !== id);
    state.queue = state.queue.filter(x => x !== id);
    await dbDel('tracks', id);
    // strip from playlists
    for (const pl of state.playlists) {
      if (pl.trackIds.includes(id)) { pl.trackIds = pl.trackIds.filter(x => x !== id); await persistPlaylist(pl); }
    }
    renderLibrary(); renderMenu();
    toast('REMOVED');
  }

  function confirmClearAll() {
    showModal('CLEAR EVERYTHING?', 'DELETES ALL TRACKS AND PLAYLISTS FROM THIS DEVICE.', [
      { label: 'CLEAR ALL', action: async () => {
        audio.pause(); audio.removeAttribute('src'); audio.load();
        for (const m of state.tracks.values()) if (m._url) URL.revokeObjectURL(m._url);
        state.tracks.clear(); state.order = []; state.queue = []; state.qIndex = -1; state.playlists = [];
        const t = db.transaction(['tracks', 'playlists'], 'readwrite');
        t.objectStore('tracks').clear(); t.objectStore('playlists').clear();
        hideModal(); updateWps(); renderMenu(); setView('menu'); toast('CLEARED');
      } },
      { label: 'CANCEL', action: hideModal },
    ]);
  }

  /* ---------------- Modal / prompt ---------------- */
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function showModal(title, body, actions) {
    $('modalTitle').textContent = title;
    const b = $('modalBody');
    b.innerHTML = '';
    if (typeof body === 'string') b.innerHTML = body;
    else if (body instanceof Node) b.appendChild(body);
    const acts = $('modalActions'); acts.innerHTML = '';
    (actions || []).forEach(a => {
      const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = a.label;
      btn.addEventListener('click', a.action); acts.appendChild(btn);
    });
    $('modal').hidden = false;
  }
  function hideModal() { $('modal').hidden = true; }
  function showPrompt(title, placeholder, initial, onOk) {
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = placeholder; input.value = initial || '';
    wrap.appendChild(input);
    showModal(title, wrap, [
      { label: 'OK', action: () => { const v = input.value; hideModal(); onOk(v); } },
      { label: 'CANCEL', action: hideModal },
    ]);
    setTimeout(() => { input.focus(); input.select(); }, 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = input.value; hideModal(); onOk(v); } });
  }

  /* ---------------- KV persistence ---------------- */
  function saveKv(k, v) { try { dbPut('kv', { k, v }); } catch {} }

  /* ---------------- Boot ---------------- */
  async function boot() {
    try { db = await openDB(); } catch (e) { toast('STORAGE UNAVAILABLE'); }
    // load tracks
    if (db) {
      const tracks = await dbAll('tracks');
      tracks.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      for (const t of tracks) { state.tracks.set(t.id, t); state.order.push(t.id); }
      state.playlists = (await dbAll('playlists')) || [];
      const shuffle = await dbGet('kv', 'shuffle'); if (shuffle) state.shuffle = shuffle.v;
      const repeat = await dbGet('kv', 'repeat'); if (repeat) state.repeat = repeat.v;
      const vol = await dbGet('kv', 'volume'); if (vol && typeof vol.v === 'number') state.volume = vol.v;
      // Restore last queue (paused, ready to resume)
      const last = await dbGet('kv', 'last');
      if (last && last.v && Array.isArray(last.v.queue)) {
        state.queue = last.v.queue.filter(id => state.tracks.has(id));
        state.qIndex = Math.min(Math.max(0, last.v.qIndex | 0), state.queue.length - 1);
        const m = curMeta();
        if (m) { audio.src = trackUrl(m); }
      }
    }
    audio.volume = state.volume;
    updateFlags();
    updateWps();
    renderMenu();
    // start on menu if there is a library, else stay on WPS with hint
    setView(state.order.length ? 'menu' : 'wps');
    clock();
    setInterval(clock, 15000);
  }

  function clock() {
    const d = new Date();
    $('sbClock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------------- Wire up controls ---------------- */
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('btnMenu').addEventListener('click', () => setView('menu'));
  $('btnBack').addEventListener('click', back);
  $('btnUp').addEventListener('click', () => move(-1));
  $('btnDown').addEventListener('click', () => move(1));
  $('btnSelect').addEventListener('click', activate);
  $('btnPrev').addEventListener('click', () => { if (state.view === 'wps') prev(); else move(-1); });
  $('btnNext').addEventListener('click', () => { if (state.view === 'wps') next(false); else move(1); });

  // long-press select on WPS toggles nothing; keyboard support for desktop
  document.addEventListener('keydown', (e) => {
    if (!$('modal').hidden) return;
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowLeft': state.view === 'wps' ? prev() : move(-1); break;
      case 'ArrowRight': state.view === 'wps' ? next(false) : move(1); break;
      case 'Enter': case ' ': e.preventDefault(); activate(); break;
      case 'Backspace': case 'Escape': back(); break;
      case 'm': case 'M': setView('menu'); break;
    }
  });

  // swipe on now-playing art for prev/next
  let touchX = null;
  $('albumart').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('albumart').addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) { dx < 0 ? next(false) : prev(); }
    touchX = null;
  });

  // Register service worker for offline / installable PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  boot();
})();
