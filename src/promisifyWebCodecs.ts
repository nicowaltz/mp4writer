/**
 * Copyright (c) 2026 Nicholas Waltz
 * https://nicholaswaltz.com
 *
 * promisifyWebCodecs.ts
 */

export function isConfigured(
  configurable: AudioEncoder | VideoEncoder | VideoDecoder | AudioDecoder,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (configurable.state === "configured") {
      resolve();
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const checkState = () => {
      if (configurable.state === "configured") {
        resolve();
      } else if (configurable.state === "closed") {
        reject(new Error("Encoder/decoder closed before configuration"));
      } else if (Date.now() >= deadline) {
        reject(new Error(`isConfigured timed out after ${timeoutMs}ms (state: ${configurable.state})`));
      } else {
        setTimeout(checkState, 10);
      }
    };

    checkState();
  });
}
