/** Accumulates items and hands back full batches as soon as they're ready, plus a final partial batch on flush(). One instance per row kind (segments/signs/cameras post to different endpoints, so must never share a batch). */
export class Batcher<T> {
  private buffer: T[] = [];

  constructor(private readonly batchSize: number) {}

  /** Returns a full batch if adding `item` filled it, else undefined. */
  add(item: T): T[] | undefined {
    this.buffer.push(item);
    if (this.buffer.length >= this.batchSize) {
      const batch = this.buffer;
      this.buffer = [];
      return batch;
    }
    return undefined;
  }

  /** Returns whatever's left (possibly empty → undefined) — call once after the input stream is exhausted. */
  flush(): T[] | undefined {
    if (this.buffer.length === 0) return undefined;
    const batch = this.buffer;
    this.buffer = [];
    return batch;
  }
}
