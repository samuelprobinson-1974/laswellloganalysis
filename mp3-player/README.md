# Onebit VFD Player 🎵

A mobile MP3 player styled after the **Rockbox Onebit / VFD** theme — a
monochrome cyan phosphor glow on black, 1-bit inverse-highlight lists, and
physical-button navigation. It runs entirely in the browser, plays audio files
straight off your phone, and lets you build and save playlists that persist
between sessions.

Nothing is uploaded — all files and playlists live on your device (IndexedDB).

## Features

- **Play local files** — load `.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`, `.flac`,
  `.opus` directly from your phone via **MENU → ADD FILES**.
- **ID3 tags & album art** — MP3 title / artist / album and embedded cover art
  are read automatically (falls back to the filename).
- **Create & save playlists** — make named playlists, add tracks from the
  library (multi-select), or save the current play queue as a playlist.
  Everything is stored on-device and survives reloads.
- **Full transport** — play / pause, next / prev, seekable progress bar,
  shuffle, and repeat (off / all / one).
- **Rockbox-style UI** — VFD status bar (clock, battery, play state), scrolling
  "while playing" screen, and hardware-button pad (MENU / ◄◄ / ►❙❙ / ►► / BACK
  plus ▲▼ scroll).
- **Installable PWA** — "Add to Home Screen" for a full-screen, offline app.
  Lock-screen / headphone controls via the Media Session API.

## Controls

| Button        | In lists            | On Now Playing        |
|---------------|---------------------|-----------------------|
| `▲ / ▼`       | Move selection      | Volume up / down      |
| `►❙❙` (select)| Open / play item    | Play / pause          |
| `◄◄` / `►►`   | Move selection      | Previous / next track |
| `MENU`        | Main menu           | Main menu             |
| `BACK`        | Previous screen     | —                     |

You can also **tap** any list row, tap the progress bar to seek, and
**swipe** the album art left / right to change tracks. On desktop the arrow
keys, `Enter`/`Space`, `Esc`/`Backspace`, and `M` work too.

## Run it

It's a static site — no build step, no server-side code.

**On your phone (recommended):** host the `mp3-player/` folder over HTTPS (any
static host — GitHub Pages, Netlify, etc.), open it in your mobile browser, and
choose *Add to Home Screen*. A secure origin is required for the installable
PWA / service worker.

**Locally:**

```bash
cd mp3-player
python3 -m http.server 8000
# open http://localhost:8000
```

> Opening `index.html` from `file://` works for playback, but the service
> worker (offline/install) only registers over `http(s)://`.

## Notes on privacy & storage

- Audio files are copied into the browser's IndexedDB so playlists keep working
  after you close the tab. Use **SETTINGS → CLEAR LIBRARY** to wipe everything.
- Available storage depends on the browser/device. Large libraries may prompt
  for persistent-storage permission.
