# Nostalgia Photobooth — Public Gallery

Static HTML/CSS/JS that shows a session’s photos on the guest’s phone after they scan the printed QR. Three tabs: **Template** (framed print), **Grid** (captures), **Highlight** (booth-recorded video).

Photos are **not** stored on Netlify. Uploads go to **Cloudflare R2**. The QR link is only a short session code (`?s=xxxxxx`); this page fetches a JSON manifest from R2, then loads photos and video from that file.

## Files

- `index.html` — page shell
- `style.css` — booth styles
- `app.js` — loads the session (short code → R2 manifest, or legacy query params) and renders the gallery
- `config.js` — R2 public URL + folder (not taken from the QR)
- `vercel.json` — Vercel static deploy config

## URL

New sessions:

```
https://nostalgia-qr.netlify.app/?s=n7k2mx
```

The page reads `config.js` for the R2 public URL, then fetches:

```
https://<r2-public>/<folder>/s/n7k2mx.json
```

That manifest lists print/capture/video object keys. Image and video URLs are **not** in the QR.

Older printed QRs that still have `base` / `ids` / `print` / `vids` (or Cloudinary `cloud`) keep working.

| Param | Required | Notes |
|-------|----------|-------|
| `s` | yes (new) | 6-character session code |
| `base` | legacy | R2 public base, for old QRs |
| `ids` | legacy | Comma-separated capture keys |
| `print` | legacy | Framed print key |
| `vids` | legacy | Highlight video keys |
| `cloud` | legacy | Old Cloudinary QRs |

After changing `config.js` (R2 public URL / folder), redeploy this site.

## Deploying to Vercel

1. Push this repo to GitHub (if it is not already).
2. [Vercel](https://vercel.com/new) → Import the repo.
3. Leave **Root Directory** empty (the repo-root `vercel.json` publishes the `website/` folder). Framework: Other. Leave **Build Command** empty.
4. Deploy. Copy the URL, e.g. `https://nostalgia-photobooth-gallery.vercel.app`.
5. In `desktop/.env` set:

```
VITE_GALLERY_BASE_URL=https://your-project.vercel.app
VITE_R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
```

Restart the kiosk (`npm run electron:dev` or a new packaged build) so Vite picks up the env vars.

### Cloudflare R2 CORS (required)

The Grid/Highlight tabs fetch photos and video in the browser. On the R2 bucket → Settings → CORS:

- **Allowed Origins:** `https://your-project.vercel.app` (and `http://localhost:5173` for local kiosk gallery)
- **Allowed Methods:** `GET`, `HEAD`
- **Allowed Headers:** `*`

Also enable the bucket **public development URL** (or a custom domain) so `VITE_R2_PUBLIC_URL` loads in a phone browser.

## Local preview

Open `website/index.html` via any static server, or after a session the kiosk can fall back to `/gallery/` on the Vite origin. For a real phone scan, use the Vercel URL.
