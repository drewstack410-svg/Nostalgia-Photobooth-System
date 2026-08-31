/**
 * Shared webcam open path used by the shooting screen and the
 * Settings → Filters live preview. One high-res getUserMedia often
 * fails on Windows (NotFound / NotReadable); walk the same fallbacks
 * CameraView already uses.
 */

export function webcamErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "NotReadableError" || /could not start video source/i.test(msg)) {
    return "Could not start this computer's camera. Close other apps using it (Camera, Teams, Zoom, Chrome), then retry. On Windows: Settings → Privacy & security → Camera → allow desktop apps.";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow camera access for this app and retry.";
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    /device not found/i.test(msg)
  ) {
    return "No camera was found on this computer.";
  }
  if (name === "OverconstrainedError") {
    return "This camera does not support the requested resolution. Retry to try a simpler mode.";
  }
  return msg || "Failed to start the camera.";
}

export function stopWebcamTracks(media?: MediaStream | null) {
  media?.getTracks().forEach((track) => track.stop());
}

export async function openVideoStream(
  previous?: MediaStream | null,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access is not available in this environment.");
  }

  stopWebcamTracks(previous);

  const attempts: MediaStreamConstraints[] = [
    { audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { audio: false, video: { facingMode: "user" } },
    { audio: false, video: true },
  ];

  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      console.log("[Camera] getUserMedia", JSON.stringify(constraints));
      const media = await navigator.mediaDevices.getUserMedia(constraints);
      const label = media.getVideoTracks()[0]?.label || "(unnamed)";
      console.log("[Camera] Webcam started:", label);
      return media;
    } catch (err) {
      lastError = err;
      console.warn(
        "[Camera] getUserMedia failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
    }
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    console.log(
      "[Camera] Video devices:",
      cams.map((c) => c.label || c.deviceId.slice(0, 8)),
    );
    for (const cam of cams) {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: cam.deviceId } },
        });
        console.log("[Camera] Webcam started on", cam.label || cam.deviceId);
        return media;
      } catch (err) {
        lastError = err;
        console.warn(
          "[Camera] Device failed:",
          cam.label || cam.deviceId,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    lastError = err;
  }

  throw new Error(webcamErrorMessage(lastError));
}
