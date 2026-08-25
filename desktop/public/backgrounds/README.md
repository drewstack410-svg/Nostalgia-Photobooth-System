# Background videos — not in this repository

The two default background videos are **deliberately excluded from git** and
are not part of a clone or a source download. They are client-supplied media,
about **62 MB each**; GitHub warns above 50 MB, and anything committed stays in
the repository history permanently even if deleted later.

**Ask the client for these files.** They are the same videos already running on
the booth — copy them from an existing installation or from the client's
original asset hand-off.

## What is missing

Put both files in **this folder** (`public/backgrounds/`), with these exact
names — the app builds the paths from them, so a rename or a different
extension will not be picked up:

| File | Used by |
|---|---|
| `default-title-background.mp4` | Home / title screen |
| `default-payment-background.mp4` | Payment screen |

Both are referenced in `src/stores/photobooth.ts` as
`DEFAULT_TITLE_BG_URL` and `DEFAULT_PAYMENT_BG_URL`.

## What happens if they are missing

The app still builds and runs — it will not crash. But the title and payment
screens will look **broken rather than obviously empty**: the code treats the
default background as always present, so it hides the wooden frame and the
film-roll animation to make way for a video that never loads. You get a blank
area where the branding should be.

So if you are looking at an empty title screen on a fresh checkout, this is
almost certainly why. Drop the two files in and restart.

## Grabbing them from an existing build

They ship inside the packaged app, so any installed copy has them. From the
build folder:

```
resources/app.asar  →  dist/backgrounds/default-title-background.mp4
                       dist/backgrounds/default-payment-background.mp4
```

Extract with `npx @electron/asar extract-file` (or any asar tool) and copy both
into `public/backgrounds/`.

## Replacing them

An operator can override either background at runtime from
**Admin → Settings → Title screen background / Payment screen background**.
Those uploads are stored on disk under the app's `userData` folder, not here,
and they take precedence over these defaults. These two files are only the
fallback shipped with a fresh install.
