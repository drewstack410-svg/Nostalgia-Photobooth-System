# Nostalgia Photobooth — Public Gallery

Static HTML/CSS/JS that renders a session's photos on the guest's phone as three tabs — **Template** (the actual finished/framed print), **Grid** (all captures collaged together), and **GIF** (animated) — with one big "Save to Camera Roll" action plus a secondary link to save captures one at a time. Deployed to Netlify, linked from the QR code on the printed strip.

## Files

- `index.html` — page shell
- `style.css` — photo-booth-themed styles
- `app.js` — vanilla JS (no framework, no build) that reads URL params and renders the gallery
- `netlify.toml` — Netlify deploy config (publish dir = this folder, no build command)

## URL parameters

```
https://<your-site>.netlify.app/?cloud=<cloud_name>&ids=<id1,id2,...>&print=<publicId>&tag=<session_tag>&title=<title>
```

| Param | Required | Notes |
|-------|----------|-------|
| `cloud` | yes | Cloudinary cloud name |
| `ids`   | yes* | Comma-separated public IDs of the individual captures. Powers the **Grid** tab and the "save individual photos" panel. *Only required if `print` is also absent. |
| `print` | no  | Public ID of the finished TEMPLATED print (frame applied) — powers the **Template** tab. This is what actually printed, not a raw stack of captures. |
| `tag`   | no  | Cloudinary tag shared by all session captures. When present, the **GIF** tab is added via Cloudinary's `multi` endpoint. **Requires "Multi" enabled in Cloudinary's account-level Security settings.** |
| `title` | no  | Page title/heading. Defaults to "Nostalgia Photobooth" |

Tabs only appear for whichever of `print` / `ids` / `tag` are present — e.g. a link with only `ids` shows a single Grid view and no tab row at all. The **Grid** save button composites the captures into one image client-side (canvas), since Cloudinary's `multi` endpoint only stitches animated assets, not a static collage.

## Deploying to Netlify

**Option A — Connect repo (recommended):**
1. Netlify → Add new site → Import from Git → pick this repo
2. Branch: `main` (or whichever you ship from)
3. Base directory: *(leave empty — root of repo)*
4. Publish directory: `public/gallery` (already set in `/netlify.toml`)
5. Build command: *(leave empty)*
6. Deploy

**Option B — Drag and drop:**
1. Open https://app.netlify.com/drop
2. Drag the entire `public/gallery/` folder onto the page
3. Note the assigned `*.netlify.app` URL

After the first deploy, copy the URL into the photobooth app's `.env`:

```
VITE_GALLERY_BASE_URL=https://your-site.netlify.app
```

…and restart the dev environment so Vite picks up the new env var.

## Cloudinary "Multi" feature

The animated-GIF tile uses Cloudinary's `multi` endpoint which stitches all images sharing a tag into a single animated GIF.

`Multi` is **available by default** on most Cloudinary accounts — it's not in the "Restricted image types" list under Settings → Security. Just confirm:

1. Cloudinary console → Settings → Security → "Restricted image types"
2. **`Multi` should NOT be checked.** (If `Sprite`, `Fetched URL`, or `Resource list` are checked, that's fine — we don't use those.)
3. Cloudinary console → Settings → Upload → your unsigned preset
4. **"Tags" should be allowed** (default — they're not considered a privileged operation)

To verify it works after your first session, open this URL in any browser:

```
https://res.cloudinary.com/<your-cloud>/image/multi/session_<timestamp>.gif
```

…where `<timestamp>` matches the session tag printed in the photobooth's dev console (`[Save] Capture 0 uploaded: …`). The first hit takes 1–3 seconds while Cloudinary renders the GIF; subsequent loads are CDN-cached.

If the URL returns an error, the gallery falls back to showing the first capture in the GIF tile's place.
