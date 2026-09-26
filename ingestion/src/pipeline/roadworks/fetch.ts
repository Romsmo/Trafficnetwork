import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

// The polite GET moved to src/http/polite.ts (shared with the official-source workers); re-exported so roadworks code keeps its imports.
export { PermanentHttpError, politeGet, USER_AGENT, type HttpOptions } from "../../http/polite.js";

/**
 * The response body as text chunks, gunzipped if it is gzip. Detected by the gzip magic number, not by URL or headers: NDW serves
 * `.xml.gz` as plain `application/xml` without `Content-Encoding`, while other servers compress transparently (which fetch undoes itself).
 */
export async function* bodyChunks(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const head = first.value as Buffer;
  const rest = (async function* () {
    yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value as Buffer;
    }
  })();
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const gunzip = createGunzip();
    Readable.from(rest).pipe(gunzip);
    for await (const chunk of gunzip) yield chunk as Buffer;
  } else {
    yield* rest;
  }
}
