## LAS Well Log Analysis App

This Dash app allows you to upload and analyze LAS 2.0 well log files online.

### Features
- Upload LAS files
- Select and scale curves
- Shade between curves and constants
- Create calculated curves with expressions
- Export modified LAS files

### Run locally
```bash
pip install -r requirements.txt
python app.py
```

### Deploy free on Render
1. Push these files to a GitHub repository.
2. Create a new Render Web Service and connect your repo.
3. Set Build Command: `pip install -r requirements.txt`
4. Set Start Command: `gunicorn app:server`
5. Choose the free tier.

Your app will be live at https://your-app-name.onrender.com

---

## Onebit VFD Player (mobile MP3 player)

This repo also contains a standalone, client-side **MP3 player** styled after
the Rockbox Onebit / VFD theme, built for smartphone screens. It plays local
audio files and lets you create and save playlists — entirely on-device.

See [`mp3-player/`](mp3-player/README.md) for details. It's a static site:

```bash
cd mp3-player
python3 -m http.server 8000   # then open http://localhost:8000
```