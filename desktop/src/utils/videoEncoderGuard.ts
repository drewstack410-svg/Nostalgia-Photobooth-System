/**
 * Intel iGPU / missing drivers can accept VideoEncoder.configure() then
 * never drain the encode queue or return from flush(). Gaming laptops
 * with NVIDIA usually finish; kiosk mini-PCs can sit here forever and
 * the gallery upload never starts.
 */

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitEncoderDrain(
  encoder: VideoEncoder,
  maxQueue = 12,
  timeoutMs = 2500,
): Promise<boolean> {
  const started = performance.now();
  while (encoder.encodeQueueSize > maxQueue) {
    if (encoder.state !== "configured") return false;
    if (performance.now() - started > timeoutMs) {
      console.warn(
        `[VideoEncoder] Queue stuck at ${encoder.encodeQueueSize} for ${timeoutMs}ms`,
      );
      return false;
    }
    await sleepMs(8);
  }
  return true;
}

export async function flushEncoder(
  encoder: VideoEncoder,
  timeoutMs = 4000,
): Promise<boolean> {
  if (encoder.state !== "configured") return false;
  try {
    await Promise.race([
      encoder.flush(),
      sleepMs(timeoutMs).then(() => {
        throw new Error(`flush timed out after ${timeoutMs}ms`);
      }),
    ]);
    return true;
  } catch (e) {
    console.warn("[VideoEncoder] flush:", e);
    return false;
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[Deadline] ${label} timed out after ${ms}ms`);
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
