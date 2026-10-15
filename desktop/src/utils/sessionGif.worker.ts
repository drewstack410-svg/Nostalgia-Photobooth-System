/// <reference lib="webworker" />
import { encodeFrames, type SessionGifOptions } from "./sessionGif";

type EncodeMsg = {
  frames: Uint8ClampedArray[];
  width: number;
  height: number;
  options: SessionGifOptions;
};

self.onmessage = (event: MessageEvent<EncodeMsg>) => {
  try {
    const { frames, width, height, options } = event.data;
    const bytes = encodeFrames(frames, width, height, options);
    self.postMessage({ ok: true as const, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
