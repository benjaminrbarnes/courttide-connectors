import type { TransportProfile } from "../contract/types.js";
import { bounded } from "./async.js";
import { detectChallenge } from "./challenge.js";
import type { ResponseClock } from "./response.js";

const MAX_BYTES = 64 * 1024;
const MAX_CHUNKS = 4_096;

/** Inspect only a bounded prefix; an inconclusive probe is not evidence of a block. */
export async function rejectedChallenge(
  response: Response,
  profile: TransportProfile,
  clock: ResponseClock,
): Promise<boolean> {
  if (!response.body) return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (let chunks = 0; chunks < MAX_CHUNKS && size < MAX_BYTES; chunks += 1) {
      const part = await bounded(reader.read(), clock.signal, clock.abortError);
      clock.deadline();
      if (part.done)
        return detectChallenge(
          text + decoder.decode(),
          profile.challenge ?? {},
        );
      if (!(part.value instanceof Uint8Array)) return false;
      const prefix = part.value.subarray(0, MAX_BYTES - size);
      size += prefix.byteLength;
      text += decoder.decode(prefix, { stream: true });
      if (detectChallenge(text, profile.challenge ?? {})) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (reader) {
      try {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } catch {
        /* A cancelled or pending stream is already being disposed. */
      }
    }
  }
}
