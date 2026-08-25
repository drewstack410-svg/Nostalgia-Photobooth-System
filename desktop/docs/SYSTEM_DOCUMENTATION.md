# Nostalgia Photobooth — System Documentation

*A plain-language guide to how the whole system works. Written for owners/operators, not just developers — no coding knowledge needed to follow this.*

---

## 1. What this is, in one paragraph

Nostalgia Photobooth is the software that runs on the photobooth kiosk computer. A guest walks up, pays, picks a photo layout ("template"), takes some pictures, and walks away with a printed photo strip — plus a QR code they can scan to get digital copies on their phone. Behind the scenes, this app talks to three other pieces of hardware/software: a Canon camera, a DNP dye-sub printer, and a separate payment app called **LumaBooth Middleware** that handles cash and QR (GCash-style) payments.

This document explains every part of that journey, plus the admin/owner tools for managing prices, templates, and sales.

---

## 2. The guest's journey, screen by screen

1. **Title Screen** — "Nostalgia Photobooth" with a decorative wooden frame and a scrolling film-roll of recent photos in the background. Guest taps "Click Here to Start."
2. **Template Selection** — A carousel of photo layouts ("templates") to choose from — e.g. a heart-shaped 3-photo strip, a 2×2 grid, etc. Guest picks one.
3. **Payment Screen** — The guest is asked to pay. The screen shows the price for *that specific template* (if the owner has set one) and waits for money to come in via the bill acceptor or QR payment. Once paid, it automatically moves on.
4. **Camera Screen** — Live camera preview with a countdown timer, camera filters (Original, Sepia, B&W, Fujifilm), and faded guide-bars showing how much of the photo will actually get cropped into the print. The guest poses and photos are taken automatically, one per countdown.
5. **Printing Screen** — The chosen photos are combined into the final print layout and sent to the printer. A QR code is generated at the same time.
6. **QR Code Screen** — The guest can scan a QR code with their phone to open a web page showing their photos (and download them), separate from the physical print.
7. Back to the **Title Screen**, ready for the next guest.

---

## 3. Templates — the photo layouts

A "template" is a pre-designed layout: how many photos, what shape/frame, and what size paper. There are currently **7 built-in templates**:

| Template | Photos | Shape | Paper |
|---|---|---|---|
| Heart Strip | 3 | 3 hearts in a row | Strip (cut in half from a 4×6 sheet) |
| Classic Strip | 4 | 4 plain windows in a row | Strip (cut) |
| Horizontal Strip | 3 | 3 windows side-by-side | Full 4×6 sheet (landscape) |
| Simple Strip | 2 | 2 plain windows in a row | Strip (cut) |
| 2×2 Layout | 4 | 2-across, 2-down grid with a black border | Full 4×6 sheet (portrait) |
| Heart Grid | 6 | 6 heart-shaped windows in a 3×2 grid | Full 4×6 sheet (portrait) |
| 4×2 Layout | 8 | 8 small windows, edge-to-edge | Full 4×6 sheet (portrait) |

### What "strip" templates mean — the 2-inch cut

Some templates (Heart Strip, Classic Strip, Simple Strip) are designed as narrow photo strips, like the classic mall-photobooth strip. Since the printer's paper only comes in 4×6-inch sheets, the software prints the SAME strip **twice, side by side**, on one 4×6 sheet. The printer then has a feature that physically **cuts the sheet down the middle**, so the guest ends up with **two identical copies of their strip** from one print — one to keep, one to give away.

⚠️ Important operational note: that cutting feature is a setting on the printer itself (not something this app can turn on/off automatically). It must be manually enabled once in the printer's driver settings, and — this is the important caveat — **while it's turned on, it cuts EVERY 4×6 sheet in half**, including the full-page templates (2×2 Layout, Heart Grid, 4×2 Layout) which are NOT meant to be cut. So at any given time, the printer should be set up for either "strip templates" or "full-page templates," not a mix of both being actively offered to guests. This is a known limitation to be aware of when deciding which templates to keep active.

### Setting prices per template

Each template can have its own price, set by the admin (see Section 8). If a template's price is never set, it falls back to a default price.

---

## 4. Camera and filters

The camera is a real Canon camera (not a webcam), controlled directly by the software for a proper live preview and instant capture. Available filters:

- **Original** — no effect
- **Sepia** — warm vintage brown tone
- **B & W** — black and white
- **Fujifilm** — a cooler, filmic color grade

**Film grain**: Sepia, B & W, and Fujifilm all permanently include a subtle film-grain texture (like old analog photos) — both in the live preview and baked into the final saved photo. This is a fixed design choice, not a toggle — it cannot currently be turned off per-session.

**Crop guide bars**: while composing a shot, faded dark bars appear on the left and right of the preview. These show how much of the photo will be trimmed away to fit the chosen template's photo "window." The lit-up middle area is what will actually appear in the final print — the guest should keep themselves inside that lit area.

---

## 5. Payment system — how LumaBooth Middleware fits in

This is the newest and most important integration, so it deserves a careful explanation.

### The two programs involved

1. **Nostalgia Photobooth** (this app) — everything described so far: camera, templates, printing.
2. **LumaBooth Middleware** — a separate, third-party program (`luma_booth_api.exe`) that is installed on the same kiosk computer. It is the program that actually:
   - Talks to the physical bill acceptor (the machine that reads/validates cash bills)
   - Handles QR-code payments (GCash-style, via a payment processor called PayMongo)
   - Decides when a customer has paid enough money for one session

### How the two talk to each other

Here's the key idea: **LumaBooth Middleware doesn't know it's talking to Nostalgia Photobooth.** It was originally built to talk to a *different* photobooth program (called "LumaBooth"), and it only knows one way to say "the customer has paid": it sends a small, invisible network message to `http://localhost:1500/api/start` — the address where the real LumaBooth software would normally be listening.

Our app takes advantage of this: **Nostalgia Photobooth quietly listens on that exact same address**, pretending to be the LumaBooth software. So when LumaBooth Middleware sends its "customer paid" message, our app receives it, understands it, and unlocks the payment screen — without LumaBooth Middleware ever needing to be changed or reconfigured. Neither program shows any extra window for this; it all happens silently in the background.

### What this means for you day to day

- **LumaBooth Middleware must be running in the background** whenever the kiosk is in use (it can be set to start automatically with Windows). It does not need to be interacted with during normal operation.
- **The price shown on our payment screen and the price actually configured inside LumaBooth Middleware need to match.** Our app doesn't currently tell the middleware how much to charge — the middleware decides that on its own (in its own settings), and our app just displays the number the admin set per template (Section 8) and waits for the middleware's "paid" signal. If these two numbers are out of sync, guests could see the wrong price on screen even though the middleware charges correctly (or vice versa) — so when you set a price in our Dashboard, make sure the LumaBooth Middleware app is configured to charge the same amount for that session.
- If a technician ever needs to reconfigure LumaBooth Middleware to send its signal to a different network address/port, the port our app listens on can be changed too (currently `1500`, the standard the middleware expects).

### Fallback: testing without real hardware

For development/testing, there are on-screen "simulate a bill" buttons that let a developer fake a payment without needing real cash or the middleware running. These only appear during development, never on the real kiosk.

---

## 6. Printing — how it actually reaches paper

- The printer is a **DNP DS-RX1** dye-sublimation photo printer, standard 4×6-inch photo paper.
- Each template is designed to exactly fill either a 4×6 sheet portrait-wise, landscape-wise, or (for strip templates) fill both halves of a 4×6 sheet as described in Section 3.
- The software builds the final image (all the chosen photos arranged into the layout, with borders/frames added), sends it to the printer, and the printer handles the rest.
- Copies-per-print and which printer to use are configurable in the admin Settings.

---

## 7. The digital gallery and QR code

After printing, a QR code appears on screen. Scanning it with a phone opens a simple web page (hosted separately online, not on the kiosk itself) showing:

- The finished printed photo strip/layout, as one image (downloadable)
- Each individual photo taken during the session (downloadable)
- An animated GIF cycling through all the photos from that session

This page works on both iPhone and Android and is built to reliably save photos to the phone's camera roll on both. This gallery page is hosted online (currently via Netlify) — **when its code changes, someone has to re-upload it to the hosting site for the change to actually go live for guests** (unlike changes to the app itself, which just take effect when the kiosk app is next restarted).

---

## 8. The Admin Panel

Reached by tapping the small badge/logo on the title screen a few times in a row (no login required — the booth is assumed to be on private, operator-controlled hardware).

### Dashboard
- Shows sales totals: how many prints sold, total revenue, filterable by day/month/year.
- **"Sales by Template" table** — lists all 7 templates. Click **Edit** on any row to set that template's price (and, if needed, manually adjust how many were sold for record-keeping). This is also where "how much does this design cost" is decided (Section 5 explains why this must match what LumaBooth Middleware is configured to charge).
- Sales by custom "item" (e.g. add-on merchandise) and reprint pricing are tracked the same way.
- Export sales data to an Excel spreadsheet.

### Gallery (Reprint)
- Two tabs: **Session** (photos from recent guest sessions, kept on this device) and **Saved** (all photos ever saved to disk).
- Session photos also show a **"Printed"**-badged tile — the actual finished layout that got printed, not just the raw individual shots.
- **Reprint**: select photo(s) from a session and reprint extra copies. The system rebuilds the exact original layout using the original captured photos, so the reprint looks identical to the first print.
- **Delete**: remove unwanted photos from the on-device history.

### Settings
- **General**: logo, title-screen background image, fonts.
- **Camera**: manage filters, choose the camera frame style/border shown on the live view.
- **Printer**: choose which printer to use, how many copies to print per session.
- **Templates**: (currently simplified/locked down — new templates aren't added by staff through this screen; template layouts are built into the app by the developer.)

---

## 9. Where everything is stored

- **Printed photos and individual captures**: saved automatically to the kiosk computer's Pictures folder (`Pictures/NostalgiaPhotobooth`).
- **Session history / recent photos shown in the admin Gallery**: kept in the app's local storage on that specific kiosk device. This has a size limit, so older sessions eventually roll off (the newest 20 are kept); photos on disk are unaffected by this limit.
- **Sales numbers, prices, custom items**: also kept locally on the kiosk, with an optional sync to a central database (PocketBase) if the owner sets that up — useful for multiple kiosks reporting to one place. Without that setup, everything still works using just the local device.
- **Digital copies for guests (QR code gallery)**: uploaded to a cloud image service (Cloudinary) so the QR code page can show/download them from anywhere, not just on the kiosk.

---

## 10. Known limitations (being honest about what's not finished)

- **Strip templates vs. full-page templates conflict**, as explained in Section 3 — the printer's cut feature is all-or-nothing, so both types of templates shouldn't be actively offered to guests at the same time until this is resolved in software.
- **LumaBooth Middleware price and our Dashboard price are not automatically synced** — an admin must manually keep both in agreement (Section 5).
- **The gallery/QR web page must be manually re-uploaded** to its hosting site whenever its code is updated — it does not update itself alongside the kiosk app.
- Some behind-the-scenes bookkeeping edge cases (e.g. a reprint sale is recorded slightly before the print job is confirmed to have succeeded) exist but don't affect normal day-to-day use.

---

## 11. Quick glossary

| Term | Plain-language meaning |
|---|---|
| Template | A pre-designed photo layout (how many photos, what shape/frame) |
| Kiosk | The physical booth computer running this software |
| LumaBooth Middleware | The separate program that handles bill/QR payments |
| Cut sheet / 2-inch cut | The printer physically slicing a 4×6 sheet into two strips |
| Cloudinary | The cloud service that stores photos for the QR/digital gallery |
| PocketBase | An optional central database for syncing sales data across multiple kiosks |
| Reprint | Re-printing extra copies of a photo session that was already taken |
| Recent Strips / Session photos | The short-term on-device history of recent guest sessions, used for the admin Gallery and reprints |

---

*This document describes the system as of the most recent update. If new features are added or the payment/printing setup changes, this file should be updated to match.*
