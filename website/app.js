// Nostalgia Photobooth â€” public gallery viewer
// ---------------------------------------------
// Vanilla JS, no framework, no build step. Reads URL params:
//   ?base=<public_url>    (required for R2) Cloudflare R2 public base,
//                         e.g. https://pub-xxxx.r2.dev â€” no trailing slash.
//   ?cloud=<cloud_name>   (legacy) Cloudinary cloud name, kept so old
//                         printed QR codes still open.
//   &ids=<id1,id2,...>    (required) comma-separated object keys /
//                         public IDs of the individual captures.
//                         Order is preserved. Also listed individually
//                         under â€œsave individual photosâ€.
//   &tag=<session_tag>    (optional, unused by GIF anymore) kept for
//                         backward compatibility with older printed
//                         QR codes; harmless if present.
//   &print=<publicId>    (optional) public ID of the finished
//                         TEMPLATED print (frame applied) â€” shown as
//                         the "Template" view. This is what actually
//                         printed, not a raw stack of captures.
//   &vids=<key1,key2,..>  (optional) R2 object keys of per-shot
//                         highlight clips (posing + 4s freeze). A play
//                         button on the Template view plays them in
//                         the photo windows.
//   &title=<text>         (optional) overrides the page title.
//                         Defaults to "Nostalgia Photobooth".
//
// Example: gallery/?cloud=uprdu3kg&print=abc&ids=foo:bar,foo:baz
//
// UI is Template / Grid tabs, with a centered play control on the
// printed strip when highlight clips are present. One big
// "Save to Camera Roll" action for whichever is showing, plus a
// secondary link to save captures one at a time. Built deliberately
// tiny â€” the page should load fast on a phone over a venue's wifi
// after someone scans the QR code.
//
// The GIF tab used to stitch captures client-side via gif.js. It is
// parked in favour of highlight clips played on the template.

(function () {
  "use strict";

  // â”€â”€â”€ URL param parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const params = new URLSearchParams(window.location.search);
  const r2Base = (params.get("base") || "").trim().replace(/\/+$/, "");
  const cloud = (params.get("cloud") || "").trim();
  const tag = (params.get("tag") || "").trim();
  const idsRaw = (params.get("ids") || "").trim();
  const printId = (params.get("print") || "").trim();
  const vidsRaw = (params.get("vids") || "").trim();
  const slotsRaw = (params.get("slots") || "").trim();
  const parRaw = (params.get("par") || "").trim();
  const title = (params.get("title") || "Nostalgia Photobooth").trim();

  const ids = idsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const vids = vidsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const layoutSlots = parseSlots(slotsRaw);
  const printAspect = parsePrintAspect(parRaw);

  // â”€â”€â”€ DOM refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const titleEl = document.getElementById("title");
  const stageEl = document.getElementById("stage");
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
  const filmstripEl = document.getElementById("filmstrip");
  const lightboxEl = document.getElementById("hlLightbox");
  const lightboxStage = document.getElementById("hlLightboxStage");
  const lightboxClose = document.getElementById("hlLightboxClose");
  let lightboxCleanup = null;
  let stripResizeCleanup = null;

  titleEl.textContent = title;
  document.title = title;

  // â”€â”€â”€ Sanity checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if ((!r2Base && !cloud) || (ids.length === 0 && !printId && vids.length === 0)) {
    showFatal(
      "This link is missing photo references. Try scanning the QR code from your printed strip again.",
    );
    return;
  }

  // â”€â”€â”€ Build the view list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  const highlightUrls = vids.map((id) => imageUrl(id));

  // GIF tab parked â€” highlight clips play on the Template view instead.
  // if (ids.length > 0) {
  //   views.push({
  //     key: "gif",
  //     label: "GIF",
  //     kind: "gif",
  //     ids,
  //     downloadName: "nostalgia.gif",
  //   });
  // }

  if (views.length === 0 && highlightUrls.length > 0) {
    views.push({
      key: "template",
      label: "Template",
      kind: "image",
      url: "",
      downloadUrl: highlightUrls[0],
      downloadName: highlightDownloadName(vids[0]),
    });
  }

  if (views.length === 0) {
    showFatal("This link doesn't have anything to show yet.");
    return;
  }

  // â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let activeKey = views[0].key;

  // â”€â”€â”€ Render tabs (hidden entirely if there's only one view) â”€â”€â”€â”€â”€â”€
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

  if (highlightUrls.length) {
    individualToggle.innerHTML =
      '<span aria-hidden="true">✂</span> save photos & videos';
  }
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

    highlightUrls.forEach((url, i) => {
      const downloadName = highlightDownloadName(url, highlightUrls.length === 1 ? undefined : i + 1);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "individual-thumb is-video";
      btn.setAttribute("aria-label", "Save highlight " + (i + 1));

      const vid = document.createElement("video");
      vid.src = url;
      vid.muted = true;
      vid.playsInline = true;
      vid.setAttribute("playsinline", "");
      vid.preload = "metadata";
      btn.appendChild(vid);

      const badge = document.createElement("span");
      badge.className = "individual-thumb-play";
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="7,4 21,12 7,20"/></svg>';
      btn.appendChild(badge);

      const check = document.createElement("span");
      check.className = "individual-thumb-check";
      check.textContent = "Saved";
      btn.appendChild(check);

      btn.addEventListener("click", async () => {
        await saveByUrl(url, downloadName);
        btn.classList.add("saved");
      });

      individualPanel.appendChild(btn);
    });
  }

  // â”€â”€â”€ Footnote â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  footnoteEl.textContent = `${ids.length} ${ids.length === 1 ? "memory" : "memories"} from your session`;

  // â”€â”€â”€ Initial render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  setActive(activeKey);

  // â”€â”€â”€ Functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const view = getView(key);
    const liveOnTemplate =
      view && view.kind === "image" && highlightUrls.length > 0;
    stageEl.classList.toggle("is-video", false);
    stageEl.classList.toggle("is-highlight-strip", !!liveOnTemplate);
    stageEl.style.removeProperty("--strip-ar");
    if (stripResizeCleanup) {
      stripResizeCleanup();
      stripResizeCleanup = null;
    }
    if (filmstripEl) filmstripEl.hidden = true;
    if (filmstripEl) filmstripEl.innerHTML = "";
    closeHighlightLightbox();
    renderStage(view);
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

    if (view.kind === "image" && highlightUrls.length > 0) {
      renderTemplateWithPlay(view);
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

  function parseSlots(raw) {
    if (!raw) return [];
    return raw
      .split(",")
      .map((part) => {
        const n = part.split("_").map(Number);
        if (n.length < 4 || n.slice(0, 4).some((v) => !isFinite(v))) return null;
        return {
          x: n[0],
          y: n[1],
          w: n[2],
          h: n[3],
          r: n.length >= 5 && isFinite(n[4]) ? n[4] : 0,
        };
      })
      .filter(Boolean);
  }

  function parsePrintAspect(raw) {
    const m = String(raw || "").match(/^(\d+)x(\d+)$/i);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w < 1 || h < 1) return null;
    return { w, h };
  }

  function defaultSlots(n, portrait) {
    const count = Math.max(1, n);
    let cols = 1;
    let rows = count;
    if (count === 2) {
      cols = portrait ? 1 : 2;
      rows = portrait ? 2 : 1;
    } else if (count === 3) {
      cols = portrait ? 1 : 3;
      rows = portrait ? 3 : 1;
    } else if (count === 4) {
      cols = 2;
      rows = 2;
    } else if (count <= 6) {
      cols = portrait ? 2 : 3;
      rows = Math.ceil(count / cols);
    } else {
      cols = 2;
      rows = Math.ceil(count / cols);
    }
    const padX = 0.055;
    const padY = 0.07;
    const gapX = 0.035;
    const gapY = 0.055;
    const cw = (1 - padX * 2 - gapX * (cols - 1)) / cols;
    const ch = (1 - padY * 2 - gapY * (rows - 1)) / rows;
    return Array.from({ length: count }, (_, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      return {
        x: padX + c * (cw + gapX),
        y: padY + r * (ch + gapY),
        w: cw,
        h: ch,
        r: 0,
      };
    });
  }

  // When the QR has no slot list, read photo windows off the printed
  // PNG (black film frames with photos already in the holes).
  function detectSlotsFromPrint(img) {
    try {
      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;
      if (!srcW || !srcH) return [];
      const maxW = 280;
      const scale = Math.min(1, maxW / srcW);
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return [];
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const seen = new Uint8Array(w * h);
      const isContent = (idx) => {
        const o = idx * 4;
        return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] > 38;
      };
      const rects = [];
      const minArea = w * h * 0.012;
      const stack = new Int32Array(w * h);
      for (let start = 0; start < w * h; start++) {
        if (seen[start] || !isContent(start)) continue;
        let sp = 0;
        stack[sp++] = start;
        seen[start] = 1;
        let minX = w;
        let maxX = 0;
        let minY = h;
        let maxY = 0;
        let area = 0;
        while (sp > 0) {
          const p = stack[--sp];
          const x = p % w;
          const y = (p / w) | 0;
          area++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          const nbs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
          for (let k = 0; k < 4; k++) {
            const next = nbs[k];
            if (next < 0 || seen[next] || !isContent(next)) continue;
            seen[next] = 1;
            stack[sp++] = next;
          }
        }
        if (area < minArea) continue;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        if (bw / w < 0.12 || bh / h < 0.12) continue;
        rects.push({
          x: minX / w,
          y: minY / h,
          w: bw / w,
          h: bh / h,
          r: 0,
        });
      }
      rects.sort((a, b) => a.y - b.y || a.x - b.x);
      const rows = [];
      rects.forEach((r) => {
        const row = rows.find(
          (grp) => Math.abs(grp[0].y - r.y) < Math.min(grp[0].h, r.h) * 0.5,
        );
        if (row) row.push(r);
        else rows.push([r]);
      });
      rows.forEach((row) => row.sort((a, b) => a.x - b.x));
      return rows.flat();
    } catch (err) {
      return [];
    }
  }

  function formatPlayerTime(secs) {
    if (!isFinite(secs) || secs < 0) return "0:00";
    const s = Math.floor(secs);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function closeHighlightLightbox() {
    if (lightboxCleanup) {
      lightboxCleanup();
      lightboxCleanup = null;
    }
    if (lightboxStage) lightboxStage.innerHTML = "";
    if (lightboxEl) lightboxEl.hidden = true;
    document.body.classList.remove("hl-lightbox-open");
  }

  if (lightboxClose) {
    lightboxClose.addEventListener("click", closeHighlightLightbox);
  }
  if (lightboxEl) {
    lightboxEl.addEventListener("click", (e) => {
      if (e.target === lightboxEl) closeHighlightLightbox();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHighlightLightbox();
  });

  function openHighlightLightbox(urls, startIndex) {
    closeHighlightLightbox();
    if (!lightboxEl || !lightboxStage || !urls.length) return;
    lightboxEl.hidden = false;
    document.body.classList.add("hl-lightbox-open");
    lightboxCleanup = mountHighlightPlayer(lightboxStage, urls, startIndex);
  }

  function containFitBox(nw, nh, maxW, maxH) {
    const scale = Math.min(maxW / nw, maxH / nh);
    return { w: Math.max(1, nw * scale), h: Math.max(1, nh * scale) };
  }

  function sizeHighlightStrip(strip, nw, nh) {
    const box = stageInner.getBoundingClientRect();
    const fit = containFitBox(nw, nh, box.width, box.height);
    strip.style.width = fit.w + "px";
    strip.style.height = fit.h + "px";
    strip.style.aspectRatio = nw + " / " + nh;
  }

  function renderTemplateWithPlay(view) {
    loadingEl.hidden = true;
    updateSaveLabel(view);
    const urls = highlightUrls;
    if (!urls.length) {
      errorEl.hidden = false;
      return;
    }

    const strip = document.createElement("div");
    strip.className = "highlight-strip";

    const playSvg =
      '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><polygon points="7,4 21,12 7,20"/></svg>';
    const pauseSvg =
      '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "template-play-btn";
    playBtn.setAttribute("aria-label", "Play highlights");
    playBtn.innerHTML = playSvg;

    const vid = document.createElement("video");
    vid.className = "highlight-strip-video";
    vid.src = urls[0];
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.setAttribute("playsinline", "");
    vid.setAttribute("webkit-playsinline", "");
    vid.preload = "auto";
    vid.setAttribute("controlslist", "nodownload");
    vid.hidden = true;

    let playing = false;

    function setPlaying(on) {
      playing = on;
      strip.classList.toggle("is-playing", on);
      playBtn.innerHTML = on ? pauseSvg : playSvg;
      playBtn.setAttribute("aria-label", on ? "Pause" : "Play highlights");
      vid.hidden = !on;
      if (on) {
        try {
          vid.currentTime = 0;
        } catch (_) {
          /* ignore */
        }
        vid.play().catch(() => {});
      } else {
        vid.pause();
        try {
          vid.currentTime = 0;
        } catch (_) {
          /* ignore */
        }
      }
    }

    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setPlaying(!playing);
    });
    vid.addEventListener("click", (e) => {
      e.stopPropagation();
      if (playing) setPlaying(false);
    });

    function watchStripSize(nw, nh) {
      sizeHighlightStrip(strip, nw, nh);
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => sizeHighlightStrip(strip, nw, nh));
      ro.observe(stageInner);
      stripResizeCleanup = () => {
        ro.disconnect();
        setPlaying(false);
      };
    }

    const frameUrl = view.url || (printId ? imageUrl(printId) : "");
    if (frameUrl) {
      loadingEl.hidden = false;
      const frame = document.createElement("img");
      frame.className = "highlight-strip-frame";
      frame.alt = view.label || "Template";
      frame.onload = () => {
        loadingEl.hidden = true;
        watchStripSize(frame.naturalWidth, frame.naturalHeight);
      };
      frame.onerror = () => {
        loadingEl.hidden = true;
        const ar = printAspect || { w: 2, h: 3 };
        watchStripSize(ar.w, ar.h);
      };
      frame.src = frameUrl;
      strip.appendChild(frame);
    } else {
      vid.addEventListener("loadedmetadata", () => {
        watchStripSize(vid.videoWidth || 2, vid.videoHeight || 3);
      });
    }

    strip.appendChild(vid);
    strip.appendChild(playBtn);
    stageInner.appendChild(strip);
  }

  function mountHighlightPlayer(host, urls, startIndex) {
    const player = document.createElement("div");
    player.className = "player player-lightbox";

    const video = document.createElement("video");
    video.className = "stage-video";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.muted = false;
    video.preload = "auto";
    video.setAttribute("controlslist", "nodownload");

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "player-nav player-prev";
    prevBtn.setAttribute("aria-label", "Previous clip");
    prevBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "player-nav player-next";
    nextBtn.setAttribute("aria-label", "Next clip");
    nextBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

    const bar = document.createElement("div");
    bar.className = "player-bar";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "player-btn";
    playBtn.setAttribute("aria-label", "Play");

    const muteBtn = document.createElement("button");
    muteBtn.type = "button";
    muteBtn.className = "player-btn";
    muteBtn.setAttribute("aria-label", "Mute");

    const timeEl = document.createElement("span");
    timeEl.className = "player-time";
    timeEl.textContent = "0:00 / 0:00";

    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "player-seek";
    seek.min = "0";
    seek.max = "1000";
    seek.value = "0";
    seek.setAttribute("aria-label", "Seek");

    bar.appendChild(playBtn);
    bar.appendChild(muteBtn);
    bar.appendChild(timeEl);
    bar.appendChild(seek);

    player.appendChild(video);
    player.appendChild(prevBtn);
    player.appendChild(nextBtn);
    player.appendChild(bar);
    host.appendChild(player);

    let clipIndex = startIndex || 0;
    let seeking = false;
    const playIcon =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
    const pauseIcon =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    const muteIcon =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    const unmuteIcon =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19 5a8 8 0 0 1 0 14"/></svg>';

    function setPlayUi() {
      const paused = video.paused;
      playBtn.innerHTML = paused ? playIcon : pauseIcon;
      playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
    }
    function setMuteUi() {
      muteBtn.innerHTML = video.muted ? muteIcon : unmuteIcon;
      muteBtn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    }
    function updateTime() {
      const dur = video.duration || 0;
      timeEl.textContent =
        formatPlayerTime(video.currentTime) + " / " + formatPlayerTime(dur);
      if (!seeking && dur > 0) {
        seek.value = String(Math.round((video.currentTime / dur) * 1000));
      }
      const pct = Number(seek.value) / 10;
      seek.style.background =
        "linear-gradient(90deg, #d2917a " +
        pct +
        "%, rgba(242, 212, 196, 0.28) " +
        pct +
        "%)";
    }
    function playClip(i) {
      clipIndex = ((i % urls.length) + urls.length) % urls.length;
      video.src = urls[clipIndex];
      video.play().catch(() => setPlayUi());
      setPlayUi();
      prevBtn.hidden = urls.length < 2;
      nextBtn.hidden = urls.length < 2;
    }

    playBtn.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    muteBtn.addEventListener("click", () => {
      video.muted = !video.muted;
      setMuteUi();
    });
    prevBtn.addEventListener("click", () => playClip(clipIndex - 1));
    nextBtn.addEventListener("click", () => playClip(clipIndex + 1));
    video.addEventListener("ended", () => playClip(clipIndex + 1));
    video.addEventListener("play", setPlayUi);
    video.addEventListener("pause", setPlayUi);
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("loadedmetadata", updateTime);
    seek.addEventListener("input", () => {
      seeking = true;
      const dur = video.duration || 0;
      if (dur) video.currentTime = (Number(seek.value) / 1000) * dur;
    });
    seek.addEventListener("change", () => {
      seeking = false;
    });

    setMuteUi();
    setPlayUi();
    playClip(clipIndex);

    return function cleanup() {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }

  // Builds (once) and caches the client-side GIF Blob for a view, so
  // switching tabs back and forth or hitting Save doesn't re-encode.
  function getGifBlob(view) {
    if (!view._blobPromise) view._blobPromise = buildGifBlob(view.ids);
    return view._blobPromise;
  }

  saveBtn.addEventListener("click", () => saveActiveView());
  shareBtn.addEventListener("click", () => shareActiveView());

  async function fetchAsFile(url, filename, fallbackType) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed");
    const blob = await res.blob();
    return new File([blob], filename, {
      type: blob.type || fallbackType || "application/octet-stream",
    });
  }

  async function saveFiles(files) {
    const list = files.filter(Boolean);
    if (!list.length) return;
    if (
      navigator.share &&
      navigator.canShare &&
      typeof File !== "undefined"
    ) {
      try {
        if (navigator.canShare({ files: list })) {
          await navigator.share({ files: list, title });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    for (let i = 0; i < list.length; i++) {
      await saveBlob(list[i], list[i].name, list[i].type);
      if (i < list.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 280));
      }
    }
  }

  async function highlightFiles() {
    const files = [];
    for (let i = 0; i < highlightUrls.length; i++) {
      const url = highlightUrls[i];
      const name = highlightDownloadName(
        url,
        highlightUrls.length === 1 ? undefined : i + 1,
      );
      try {
        files.push(await fetchAsFile(url, name, "video/mp4"));
      } catch (_) {
        await saveByUrl(url, name);
      }
    }
    return files;
  }

  async function saveHighlightClips() {
    const files = await highlightFiles();
    if (files.length) await saveFiles(files);
  }

  async function saveStripAndHighlights(view) {
    const files = [];
    if (highlightUrls.length) {
      files.push(...(await highlightFiles()));
    }
    if (view.downloadUrl) {
      try {
        files.push(
          await fetchAsFile(
            view.downloadUrl,
            view.downloadName || "nostalgia_template.png",
            "image/png",
          ),
        );
      } catch (_) {
        await saveByUrl(view.downloadUrl, view.downloadName);
      }
    }
    if (files.length) await saveFiles(files);
  }

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
        await saveHighlightClips();
      } else {
        await saveStripAndHighlights(view);
      }
    } catch (err) {
      alert(
        "Couldn't save that â€” check your connection and try again, or use â€œsave individual photosâ€ below.",
      );
    } finally {
      setSaveBusy(false);
    }
  }

  async function shareActiveView() {
    const view = getView(activeKey);
    if (!navigator.share || view.kind === "grid") return;
    try {
      const files = [];
      if (view.url) {
        try {
          files.push(
            await fetchAsFile(
              view.url,
              view.downloadName || "nostalgia_template.png",
              "image/png",
            ),
          );
        } catch (_) {
          /* skip strip if CORS blocks it */
        }
      }
      if (view.kind === "image" && highlightUrls.length) {
        files.push(...(await highlightFiles()));
      }
      if (files.length && navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({ files, title });
        return;
      }
      if (view.url) await navigator.share({ url: view.url, title });
    } catch (err) {
      // User cancelled or the platform blocked.
    }
  }

  function setSaveBusy(busy, message) {
    saveBtn.disabled = busy;
    saveBtnLabel.textContent = busy
      ? message || "Preparing…"
      : "Save to Camera Roll";
  }

  // Detect iOS (incl. iPadOS, which reports as "MacIntel" with touch).
  // On iOS the ONLY way to land an image in the Photos library is the
  // share sheet â€” a normal download drops it into Files instead.
  function isIOS() {
    const ua = navigator.userAgent || "";
    return (
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  // Save a hosted asset by URL â€” Template / individual captures.
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
  // image) â€” no fetch needed, just route to share-sheet or download.
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
      if (err && err.name === "AbortError") return true; // user cancelled â€” don't fall through to a second prompt
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
  // bundled gif.js (vendored locally as gif.js / gif.worker.js â€” no
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
      // so this doesn't taint the canvas â€” required for toBlob().
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function drawCoverFit(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth || img.videoWidth || 0;
    const ih = img.naturalHeight || img.videoHeight || 0;
    if (!iw || !ih || w <= 0 || h <= 0) return;
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
    const ext = extMatch ? extMatch[1].toLowerCase() : "mp4";
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
