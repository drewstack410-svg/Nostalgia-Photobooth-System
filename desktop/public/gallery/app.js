// Nostalgia Photobooth — public gallery viewer
// ---------------------------------------------
// Vanilla JS, no framework, no build step. Reads URL params:
//   ?base=<public_url>    (required for R2) Cloudflare R2 public base,
//                         e.g. https://pub-xxxx.r2.dev — no trailing slash.
//   ?cloud=<cloud_name>   (legacy) Cloudinary cloud name, kept so old
//                         printed QR codes still open.
//   &ids=<id1,id2,...>    (required) comma-separated object keys /
//                         public IDs of the individual captures.
//                         Order is preserved. Also listed individually
//                         under “save individual photos”.
//   &tag=<session_tag>    (optional, unused by GIF anymore) kept for
//                         backward compatibility with older printed
//                         QR codes; harmless if present.
//   &print=<publicId>    (optional) public ID of the finished
//                         TEMPLATED print (frame applied) — shown as
//                         the "Template" view. This is what actually
//                         printed, not a raw stack of captures.
//   &vids=<key1,key2,..>  (optional) R2 object keys of per-shot
//                         highlight clips (posing + 4s freeze). Played
//                         in order as the Highlight tab.
//   &title=<text>         (optional) overrides the page title.
//                         Defaults to "Nostalgia Photobooth".
//
// Example: gallery/?cloud=uprdu3kg&print=abc&ids=foo:bar,foo:baz
//
// UI is three tabs — Template / Grid / Highlight — with one big
// "Save to Camera Roll" action for whichever is showing, plus a
// secondary link to save captures one at a time. Built deliberately
// tiny — the page should load fast on a phone over a venue's wifi
// after someone scans the QR code.
//
// The GIF tab used to stitch captures client-side via gif.js. It is
// parked in favour of a real highlight video recorded at the booth.

(function () {
  "use strict";

  // ─── URL param parsing ────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const r2Base = (params.get("base") || "").trim().replace(/\/+$/, "");
  const cloud = (params.get("cloud") || "").trim();
  const tag = (params.get("tag") || "").trim();
  const idsRaw = (params.get("ids") || "").trim();
  const printId = (params.get("print") || "").trim();
  const vidsRaw = (params.get("vids") || "").trim();
  const title = (params.get("title") || "Nostalgia Photobooth").trim();

  const ids = idsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const vids = vidsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // ─── DOM refs ─────────────────────────────────────────────────────
  const titleEl = document.getElementById("title");
  const stageInner = document.getElementById("stageInner");
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const tabsEl = document.getElementById("tabs");
  const saveBtn = document.getElementById("saveBtn");
  const saveBtnLabel = document.getElementById("saveBtnLabel");
  const shareBtn = document.getElementById("shareBtn");
  const individualToggle = document.getElementById("individualToggle");
  const individualPanel = document.getElementById("individualPanel");
  const footnoteEl = document.getElementById("footnote");

  titleEl.textContent = title;
  document.title = title;

  // ─── Sanity checks ────────────────────────────────────────────────
  if ((!r2Base && !cloud) || (ids.length === 0 && !printId && vids.length === 0)) {
    showFatal(
      "This link is missing photo references. Try scanning the QR code from your printed strip again.",
    );
    return;
  }

  // ─── Build the view list ──────────────────────────────────────────
  // Each view: { key, label, kind: 'image' | 'grid' | 'gif', ... }
  // Order sets tab order AND which one is active by default.
  const views = [];

  if (printId) {
    views.push({
      key: "template",
      label: "Template",
      kind: "image",
      url: imageUrl(printId),
      downloadUrl: imageUrl(printId, {
        download: true,
        name: "nostalgia_template",
      }),
      downloadName: "nostalgia_template.png",
    });
  }

  if (ids.length > 0) {
    views.push({
      key: "grid",
      label: "Grid",
      kind: "grid",
      ids,
      downloadName: "nostalgia_grid.jpg",
    });
  }

  // GIF tab parked — highlight video from the booth replaces it.
  // if (ids.length > 0) {
  //   views.push({
  //     key: "gif",
  //     label: "GIF",
  //     kind: "gif",
  //     ids,
  //     downloadName: "nostalgia.gif",
  //   });
  // }

  if (vids.length > 0) {
    views.push({
      key: "highlight",
      label: "Highlight",
      kind: "highlight",
      urls: vids.map((id) => imageUrl(id)),
      downloadName: highlightDownloadName(vids[0]),
    });
  }

  if (views.length === 0) {
    showFatal("This link doesn't have anything to show yet.");
    return;
  }

  // ─── State ────────────────────────────────────────────────────────
  let activeKey = views[0].key;

  // ─── Render tabs (hidden entirely if there's only one view) ──────
  if (views.length > 1) {
    views.forEach((view) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab-btn";
      btn.textContent = view.label;
      btn.setAttribute("role", "tab");
      btn.dataset.key = view.key;
      btn.addEventListener("click", () => setActive(view.key));
      tabsEl.appendChild(btn);
    });
  }

  // ─── Individual-photos panel (revealed on demand) ────────────────
  let individualPanelBuilt = false;
  individualToggle.addEventListener("click", () => {
    const willShow = individualPanel.hidden;
    individualPanel.hidden = !willShow;
    individualToggle.classList.toggle("open", willShow);
    if (willShow && !individualPanelBuilt) buildIndividualPanel();
  });

  function buildIndividualPanel() {
    individualPanelBuilt = true;
    ids.forEach((id, i) => {
      const url = imageUrl(id);
      const downloadUrl = imageUrl(id, {
        download: true,
        name: `nostalgia_${i + 1}`,
      });
      const downloadName = `nostalgia_${i + 1}.jpg`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "individual-thumb";
      btn.setAttribute("aria-label", `Save capture ${i + 1}`);

      const img = document.createElement("img");
      img.alt = `Capture ${i + 1}`;
      img.loading = "lazy";
      img.src = url;
      btn.appendChild(img);

      const check = document.createElement("span");
      check.className = "individual-thumb-check";
      check.textContent = "Saved";
      btn.appendChild(check);

      btn.addEventListener("click", async () => {
        await saveByUrl(downloadUrl, downloadName);
        btn.classList.add("saved");
      });

      individualPanel.appendChild(btn);
    });
  }

  // ─── Footnote ─────────────────────────────────────────────────────
  footnoteEl.textContent = `${ids.length} ${ids.length === 1 ? "memory" : "memories"} from your session`;

  // ─── Initial render ──────────────────────────────────────────────
  setActive(activeKey);

  // ─── Functions ────────────────────────────────────────────────────
  function getView(key) {
    return views.find((v) => v.key === key);
  }

  function setActive(key) {
    activeKey = key;
    Array.from(tabsEl.children).forEach((el) => {
      const isActive = el.dataset.key === key;
      el.classList.toggle("active", isActive);
      el.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    renderStage(getView(key));
  }

  function renderStage(view) {
    errorEl.hidden = true;
    stageInner.innerHTML = "";

    if (view.kind === "grid") {
      loadingEl.hidden = true; // CSS grid renders instantly; each <img> loads on its own
      const grid = document.createElement("div");
      grid.className = "stage-grid";
      const cols = view.ids.length <= 1 ? 1 : view.ids.length === 3 ? 3 : 2;
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      view.ids.forEach((id, i) => {
        const img = document.createElement("img");
        img.alt = `Capture ${i + 1}`;
        img.loading = "lazy";
        img.src = imageUrl(id);
        grid.appendChild(img);
      });
      stageInner.appendChild(grid);
      updateSaveLabel(view);
      return;
    }

    if (view.kind === "gif") {
      loadingEl.hidden = false;
      updateSaveLabel(view);
      getGifBlob(view)
        .then((blob) => {
          if (activeKey !== view.key) return; // guest already switched tabs
          const img = document.createElement("img");
          img.className = "stage-img";
          img.alt = view.label;
          img.src = URL.createObjectURL(blob);
          stageInner.appendChild(img);
          loadingEl.hidden = true;
        })
        .catch((err) => {
          if (activeKey !== view.key) return;
          console.error("[Gallery] Failed to build GIF:", err);
          loadingEl.hidden = true;
          errorEl.hidden = false;
        });
      return;
    }

    if (view.kind === "highlight") {
      loadingEl.hidden = true;
      updateSaveLabel(view);
      if (!view.urls || view.urls.length === 0) {
        errorEl.hidden = false;
        return;
      }
      const video = document.createElement("video");
      video.className = "stage-video";
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.muted = true;
      video.autoplay = true;
      video.controls = true;
      video.preload = "auto";
      let clipIndex = 0;
      const playClip = (i) => {
        clipIndex = i;
        video.src = view.urls[i];
        video.play().catch(() => {
          /* autoplay may need a tap; controls are visible */
        });
      };
      video.addEventListener("ended", () => {
        playClip((clipIndex + 1) % view.urls.length);
      });
      video.addEventListener("error", () => {
        if (activeKey !== view.key) return;
        errorEl.hidden = false;
      });
      stageInner.appendChild(video);
      playClip(0);
      return;
    }

    // image (Template): single <img>, preload so we can show a loading state
    loadingEl.hidden = false;
    const img = document.createElement("img");
    img.className = "stage-img";
    img.alt = view.label;
    const probe = new Image();
    probe.onload = () => {
      img.src = view.url;
      stageInner.appendChild(img);
      loadingEl.hidden = true;
    };
    probe.onerror = () => {
      loadingEl.hidden = true;
      errorEl.hidden = false;
    };
    probe.src = view.url;
    updateSaveLabel(view);
  }

  function updateSaveLabel(view) {
    saveBtnLabel.textContent = "Save to Camera Roll";
    // Sharing a freshly-composited Grid/GIF would need the same async
    // build as saving it; keeping the share icon scoped to the
    // single-file Template view keeps this simple and fast.
    shareBtn.style.display = view.kind === "image" ? "flex" : "none";
  }

  // Builds (once) and caches the client-side GIF Blob for a view, so
  // switching tabs back and forth or hitting Save doesn't re-encode.
  function getGifBlob(view) {
    if (!view._blobPromise) view._blobPromise = buildGifBlob(view.ids);
    return view._blobPromise;
  }

  saveBtn.addEventListener("click", () => saveActiveView());
  shareBtn.addEventListener("click", () => shareActiveView());

  async function saveActiveView() {
    const view = getView(activeKey);
    setSaveBusy(true);
    try {
      if (view.kind === "grid") {
        const blob = await buildGridBlob(view.ids);
        await saveBlob(blob, view.downloadName, "image/jpeg");
      } else if (view.kind === "gif") {
        const blob = await getGifBlob(view);
        await saveBlob(blob, view.downloadName, "image/gif");
      } else if (view.kind === "highlight") {
        for (let i = 0; i < view.urls.length; i++) {
          const url = view.urls[i];
          const name =
            view.urls.length === 1
              ? view.downloadName
              : highlightDownloadName(url, i + 1);
          await saveByUrl(url, name);
        }
      } else {
        await saveByUrl(view.downloadUrl, view.downloadName);
      }
    } catch (err) {
      alert(
        "Couldn't save that — check your connection and try again, or use “save individual photos” below.",
      );
    } finally {
      setSaveBusy(false);
    }
  }

  async function shareActiveView() {
    const view = getView(activeKey);
    if (!navigator.share || view.kind === "grid") return;
    try {
      try {
        const res = await fetch(view.url);
        const blob = await res.blob();
        const file = new File([blob], view.downloadName, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
      } catch (_) {
        /* fall through to url share */
      }
      await navigator.share({ url: view.url, title });
    } catch (err) {
      // User cancelled or the platform blocked — silent.
    }
  }

  function setSaveBusy(busy) {
    saveBtn.disabled = busy;
    saveBtnLabel.textContent = busy ? "Preparing…" : "Save to Camera Roll";
  }

  // Detect iOS (incl. iPadOS, which reports as "MacIntel" with touch).
  // On iOS the ONLY way to land an image in the Photos library is the
  // share sheet — a normal download drops it into Files instead.
  function isIOS() {
    const ua = navigator.userAgent || "";
    return (
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  // Save a hosted asset by URL — Template / individual captures.
  // R2 has no attachment transform, so we fetch as a blob when CORS
  // allows (required for the gallery Grid/GIF canvas too).
  async function saveByUrl(url, filename) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        await saveBlob(blob, filename, blob.type || "image/jpeg");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }

    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  // Save a blob we already built client-side (the composited Grid
  // image) — no fetch needed, just route to share-sheet or download.
  async function saveBlob(blob, filename, mimeType) {
    if (isIOS() && navigator.share && navigator.canShare && typeof File !== "undefined") {
      const shared = await trySaveBlobViaShare(blob, filename, mimeType);
      if (shared) return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function trySaveBlobViaShare(blob, filename, mimeType) {
    try {
      const file = new File([blob], filename, {
        type: mimeType || blob.type || "image/jpeg",
      });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title });
        return true;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return true; // user cancelled — don't fall through to a second prompt
    }
    return false;
  }

  // Composite every capture into one grid image, client-side. Cloudinary's
  // `multi` endpoint only stitches ANIMATED assets, not a static collage,
  // so this mirrors the same cover-fit-into-cell math the kiosk app uses
  // when building templates (see PrintingView.vue / SettingsView.vue).
  async function buildGridBlob(photoIds) {
    const imgs = await Promise.all(
      photoIds.map((id) => loadCorsImage(imageUrl(id))),
    );
    const cols = imgs.length <= 1 ? 1 : imgs.length === 3 ? 3 : 2;
    const rows = Math.ceil(imgs.length / cols);
    const cellW = 900;
    const cellH = 900;
    const gap = 10;
    const W = cols * cellW + (cols - 1) * gap;
    const H = rows * cellH + (rows - 1) * gap;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    imgs.forEach((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (cellW + gap);
      const y = row * (cellH + gap);
      drawCoverFit(ctx, img, x, y, cellW, cellH);
    });

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
        "image/jpeg",
        0.92,
      );
    });
  }

  // Build an animated GIF client-side from every capture, using the
  // bundled gif.js (vendored locally as gif.js / gif.worker.js — no
  // CDN dependency, works offline once the page itself has loaded).
  // Frames are downscaled to keep encode time and file size
  // reasonable on a phone's CPU/data plan.
  const GIF_FRAME_MAX = 480;
  const GIF_FRAME_DELAY_MS = 800;

  function buildGifBlob(photoIds) {
    return new Promise((resolve, reject) => {
      Promise.all(photoIds.map((id) => loadCorsImage(imageUrl(id))))
        .then((imgs) => {
          if (typeof GIF === "undefined") {
            reject(new Error("GIF encoder failed to load"));
            return;
          }
          // All captures share the same aspect ratio (same camera/crop),
          // so size the shared canvas off the first frame.
          const first = imgs[0];
          const scale = Math.min(1, GIF_FRAME_MAX / first.naturalWidth);
          const w = Math.round(first.naturalWidth * scale);
          const h = Math.round(first.naturalHeight * scale);

          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");

          const gif = new GIF({
            workers: 2,
            quality: 10,
            width: w,
            height: h,
            workerScript: "gif.worker.js",
          });

          imgs.forEach((img) => {
            ctx.clearRect(0, 0, w, h);
            drawCoverFit(ctx, img, 0, 0, w, h);
            gif.addFrame(ctx, { copy: true, delay: GIF_FRAME_DELAY_MS });
          });

          gif.on("finished", (blob) => resolve(blob));
          gif.on("abort", () => reject(new Error("GIF encoding aborted")));
          gif.render();
        })
        .catch(reject);
    });
  }

  function loadCorsImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // R2 public URLs need bucket CORS (GET from the gallery origin)
      // so this doesn't taint the canvas — required for toBlob().
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function drawCoverFit(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const imgAspect = iw / ih;
    const cellAspect = w / h;
    let sx = 0,
      sy = 0,
      sw = iw,
      sh = ih;
    if (imgAspect > cellAspect) {
      sw = ih * cellAspect;
      sx = (iw - sw) / 2;
    } else {
      sh = iw / cellAspect;
      sy = (ih - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  function showFatal(message) {
    document.querySelector(".page").innerHTML =
      `<div class="stage" style="aspect-ratio:auto;padding:48px 24px;text-align:center;"><p>${escapeHtml(message)}</p></div>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlightDownloadName(idOrUrl, index) {
    const src = String(idOrUrl || "");
    const extMatch = src.match(/\.(mp4|webm|mov)(?:\?|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "webm";
    const n = typeof index === "number" ? `_${index}` : "";
    return `nostalgia_highlight${n}.${ext}`;
  }

  // Public image URL. New sessions use Cloudflare R2 (`base`).
  // Older printed QR codes still pass Cloudinary `cloud` + public IDs.
  function imageUrl(publicId, options = {}) {
    if (r2Base) {
      const key = String(publicId || "").replace(/^\/+/, "");
      return `${r2Base}/${key}`;
    }
    return cloudinaryImageUrl(cloud, publicId, options);
  }

  // Legacy Cloudinary delivery URL for QR codes printed before R2.
  function cloudinaryImageUrl(cloud, publicId, options = {}) {
    const transforms = [];
    if (options.download) {
      transforms.push(
        options.name ? `fl_attachment:${options.name}` : "fl_attachment",
      );
    } else {
      transforms.push("q_auto", "f_auto");
    }
    const transformPath = transforms.join(",");
    return `https://res.cloudinary.com/${cloud}/image/upload/${transformPath}/${publicId}`;
  }
})();
