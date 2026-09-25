import { describe, expect, it } from "vitest";
import { decideBuild } from "../../src/modules/static-data/package-worker.js";

const base = { needsInitialBuild: false, dirty: 0, ageOfNewestMarkSeconds: null, ageOfOldestMarkSeconds: null, debounceSeconds: 30, maxWaitSeconds: 900 };

describe("decideBuild (the worker's debounce rules)", () => {
  it("does nothing when nothing changed", () => {
    expect(decideBuild(base)).toBe("idle");
  });

  it("builds at once when there is no complete package set yet and nothing is being written", () => {
    expect(decideBuild({ ...base, needsInitialBuild: true })).toBe("build");
  });

  it("waits while static data is still being written — a bulk import must not trigger a rebuild per batch", () => {
    expect(decideBuild({ ...base, dirty: 40, ageOfNewestMarkSeconds: 2, ageOfOldestMarkSeconds: 600 })).toBe("wait");
    expect(decideBuild({ ...base, needsInitialBuild: true, dirty: 40, ageOfNewestMarkSeconds: 29, ageOfOldestMarkSeconds: 100 })).toBe("wait");
  });

  it("builds once the writes have been quiet for the debounce time", () => {
    expect(decideBuild({ ...base, dirty: 3, ageOfNewestMarkSeconds: 30, ageOfOldestMarkSeconds: 45 })).toBe("build");
  });

  it("never starves: builds after the maximum wait even while writes keep arriving", () => {
    expect(decideBuild({ ...base, dirty: 3, ageOfNewestMarkSeconds: 1, ageOfOldestMarkSeconds: 900 })).toBe("build");
    expect(decideBuild({ ...base, dirty: 3, ageOfNewestMarkSeconds: 1, ageOfOldestMarkSeconds: 899 })).toBe("wait");
  });

  it("a debounce of zero builds immediately", () => {
    expect(decideBuild({ ...base, dirty: 1, ageOfNewestMarkSeconds: 0, ageOfOldestMarkSeconds: 0, debounceSeconds: 0 })).toBe("build");
  });
});
