/**
 * Apply the latest Canon EVF frame on the next display refresh.
 * Extra IPC frames are dropped so the preview stays in time with the
 * camera instead of queuing a delay.
 */
export function onCanonLiveViewFrames(apply: (dataUrl: string) => void): void {
  const api = window.electronAPI;
  if (!api?.onLiveViewFrame) return;
  let pending: string | null = null;
  let raf = 0;

  api.onLiveViewFrame((dataUrl: string) => {
    pending = dataUrl;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const frame = pending;
      pending = null;
      if (frame) apply(frame);
    });
  });
}

/** Paint EVF JPEGs onto <img> tags without a Vue re-render each frame. */
export function paintCanonEvfImages(dataUrl: string, root?: ParentNode | null) {
  const scope = root ?? document;
  scope.querySelectorAll("img.js-canon-evf").forEach((el) => {
    if (el instanceof HTMLImageElement && el.src !== dataUrl) el.src = dataUrl;
  });
}
