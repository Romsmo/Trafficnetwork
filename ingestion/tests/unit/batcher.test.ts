import { describe, expect, it } from "vitest";
import { Batcher } from "../../src/batching/batcher.js";

describe("Batcher", () => {
  it("returns undefined until the batch size is reached", () => {
    const batcher = new Batcher<number>(3);
    expect(batcher.add(1)).toBeUndefined();
    expect(batcher.add(2)).toBeUndefined();
  });

  it("returns a full batch exactly when it fills, then starts a new one", () => {
    const batcher = new Batcher<number>(2);
    expect(batcher.add(1)).toBeUndefined();
    expect(batcher.add(2)).toEqual([1, 2]);
    expect(batcher.add(3)).toBeUndefined();
    expect(batcher.add(4)).toEqual([3, 4]);
  });

  it("flush returns undefined when nothing is buffered", () => {
    const batcher = new Batcher<number>(5);
    expect(batcher.flush()).toBeUndefined();
  });

  it("flush returns the partial remainder and resets the buffer", () => {
    const batcher = new Batcher<number>(5);
    batcher.add(1);
    batcher.add(2);
    expect(batcher.flush()).toEqual([1, 2]);
    expect(batcher.flush()).toBeUndefined();
  });
});
