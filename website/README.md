# Nostalgia Photobooth — Public Gallery

Static HTML/CSS/JS that shows a session’s photos on the guest’s phone after they scan the printed QR. Three tabs: **Template** (framed print), **Grid** (captures), **Highlight** (booth-recorded video).

Photos are **not** stored on Vercel. Uploads go to **Cloudflare R2**; the QR link opens this Vercel page with the R2 public URL and object keys in the query string.

## Files

- `index.html` — page shell
- `style.css` — booth styles
- `app.js` — reads URL params and renders the gallery
- `vercel.json` — Vercel static deploy config

## URL parameters

```
https://<your-project>.vercel.app/?base=<r2_public_url>&ids=<key1,key2,...>&print=<key>&vids=<key1,key2,...>&title=Nostalgia%20Photobooth
```

| Param | Required | Notes |
|-------|----------|-------|
| `base` | yes (R2) | Cloudflare R2 public base, e.g. `https://pub-xxxx.r2.dev` — no trailing slash |
| `ids` | yes* | Comma-separated R2 object keys for the captures. *Required if `print` and `vids` are also absent |
| `print` | no | R2 object key of the finished framed print (Template tab) |
| `vids` | no | Comma-separated R2 object keys for highlight clips (Highlight tab) |
| `tag` | no | Session tag; kept for older QR codes |
| `title` | no | Page heading. Defaults to "Nostalgia Photobooth" |
| `cloud` | legacy | Old Cloudinary QR codes still work if `base` is missing |

The kiosk builds this URL automatically (`VITE_GALLERY_BASE_URL` + `VITE_R2_PUBLIC_URL`).

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
