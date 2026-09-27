import { describe, expect, it } from "vitest";
import {
  candidateKey,
  correctionId,
  currentStance,
  decideWinners,
  deriveStatus,
  tallyVotes,
  type VoteInput,
} from "../../src/modules/speed-limit-corrections/tally.js";

let counter = 0;
function vote(reporterId: string, kind: "support" | "deny", value: number, over: Partial<VoteInput> = {}): VoteInput {
  counter += 1;
  return { id: `v${String(counter).padStart(4, "0")}`, reporterId, kind, value, unit: "kmh", timestamp: 1_000 + counter, ...over };
}

const K = (value: number, unit: "kmh" | "mph" = "kmh") => candidateKey(unit, value);

describe("tallyVotes", () => {
  it("counts distinct reporters, not votes", () => {
    const votes = [vote("a", "support", 50), vote("a", "support", 50), vote("b", "support", 50)];
    const t = tallyVotes(votes).get(K(50))!;
    expect(t.support).toBe(2);
    expect(t.net).toBe(2);
  });

  it("lets a reporter support only one value per segment — a later support withdraws the earlier one", () => {
    const votes = [vote("a", "support", 50), vote("a", "support", 60)];
    const tallies = tallyVotes(votes);
    expect(tallies.get(K(50))!.support).toBe(0);
    expect(tallies.get(K(60))!.support).toBe(1);
  });

  it("a denial removes the reporter's own support for that value and counts against it", () => {
    const votes = [vote("a", "support", 50), vote("a", "deny", 50)];
    const t = tallyVotes(votes).get(K(50))!;
    expect(t.support).toBe(0);
    expect(t.deny).toBe(1);
    expect(t.net).toBe(-1);
  });

  it("a later support overrides the same reporter's earlier denial of the same value", () => {
    const votes = [vote("a", "deny", 50), vote("a", "support", 50)];
    const t = tallyVotes(votes).get(K(50))!;
    expect(t.support).toBe(1);
    expect(t.deny).toBe(0);
  });

  it("supporting another value does not erase the reporter's earlier denial", () => {
    const votes = [vote("a", "deny", 50), vote("a", "support", 60)];
    const tallies = tallyVotes(votes);
    expect(tallies.get(K(50))!.deny).toBe(1);
    expect(tallies.get(K(60))!.support).toBe(1);
  });

  it("orders by signed timestamp, not by arrival order", () => {
    const early = vote("a", "support", 50, { timestamp: 1 });
    const late = vote("a", "deny", 50, { timestamp: 2 });
    expect(tallyVotes([early, late]).get(K(50))!.net).toBe(-1);
    expect(tallyVotes([late, early]).get(K(50))!.net).toBe(-1);
  });

  it("breaks timestamp ties by vote id so equal-timestamp votes are still deterministic", () => {
    const a = vote("a", "support", 50, { id: "aaa", timestamp: 5 });
    const b = vote("a", "deny", 50, { id: "bbb", timestamp: 5 });
    expect(tallyVotes([a, b]).get(K(50))!.net).toBe(-1);
    expect(tallyVotes([b, a]).get(K(50))!.net).toBe(-1);
  });

  it("records the first/last vote time and the earliest supplied reason", () => {
    const votes = [
      vote("a", "support", 50, { timestamp: 10 }),
      vote("b", "support", 50, { timestamp: 20, reason: "wrong_value" }),
      vote("c", "support", 50, { timestamp: 30, reason: "other" }),
    ];
    const t = tallyVotes(votes).get(K(50))!;
    expect(t.firstVoteAt).toBe(10);
    expect(t.lastVoteAt).toBe(30);
    expect(t.reason).toBe("wrong_value");
  });

  it("gives the same result for every permutation of the same vote set (convergence)", () => {
    const votes: VoteInput[] = [
      vote("a", "support", 50, { timestamp: 1 }),
      vote("b", "support", 50, { timestamp: 2 }),
      vote("c", "support", 60, { timestamp: 3 }),
      vote("a", "support", 60, { timestamp: 4 }),
      vote("d", "deny", 50, { timestamp: 5 }),
      vote("c", "deny", 60, { timestamp: 6 }),
      vote("e", "support", 50, { timestamp: 6 }),
    ];
    const permute = (arr: VoteInput[]): VoteInput[][] =>
      arr.length <= 1 ? [arr] : arr.flatMap((v, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [v, ...rest]));
    const canonical = JSON.stringify([...tallyVotes(votes.slice(0, 6))].sort());
    const permutations = permute(votes.slice(0, 6));
    expect(permutations).toHaveLength(720);
    for (const p of permutations) {
      expect(JSON.stringify([...tallyVotes(p)].sort())).toBe(canonical);
    }
  });
});

describe("decideWinners", () => {
  const threshold = 3;
  const winnerOf = (votes: VoteInput[], blocked: string[] = [], unit: "kmh" | "mph" = "kmh") =>
    decideWinners(tallyVotes(votes), threshold, new Set(blocked)).get(unit) ?? null;

  it("applies nothing below the threshold — one or two devices change nothing", () => {
    expect(winnerOf([vote("a", "support", 50)])).toBeNull();
    expect(winnerOf([vote("a", "support", 50), vote("b", "support", 50)])).toBeNull();
  });

  it("applies at exactly the threshold of distinct devices", () => {
    expect(winnerOf([vote("a", "support", 50), vote("b", "support", 50), vote("c", "support", 50)])).toBe(K(50));
  });

  it("three votes from one device are not three devices", () => {
    expect(winnerOf([vote("a", "support", 50), vote("a", "support", 50), vote("a", "support", 50)])).toBeNull();
  });

  it("competing values: the one with the most confirmations wins once it is at the threshold", () => {
    const votes = [
      ...["a", "b", "c"].map((r) => vote(r, "support", 50)),
      ...["d", "e", "f", "g"].map((r) => vote(r, "support", 60)),
    ];
    expect(winnerOf(votes)).toBe(K(60));
  });

  it("a competitor below the threshold never beats a value at the threshold", () => {
    const votes = [...["a", "b", "c"].map((r) => vote(r, "support", 50)), vote("d", "support", 60), vote("e", "support", 60)];
    expect(winnerOf(votes)).toBe(K(50));
  });

  it("a tie for first place has no winner — the imported value stays", () => {
    const votes = [...["a", "b", "c"].map((r) => vote(r, "support", 50)), ...["d", "e", "f"].map((r) => vote(r, "support", 60))];
    expect(winnerOf(votes)).toBeNull();
  });

  it("a denial flips an applied correction back below the threshold", () => {
    const supporters = ["a", "b", "c"].map((r) => vote(r, "support", 50));
    expect(winnerOf(supporters)).toBe(K(50));
    expect(winnerOf([...supporters, vote("d", "deny", 50)])).toBeNull();
    // ...and one more supporter puts it back on top of the objection.
    expect(winnerOf([...supporters, vote("d", "deny", 50), vote("e", "support", 50)])).toBe(K(50));
  });

  it("when the leader is flipped, the runner-up at the threshold takes over", () => {
    const votes = [
      ...["a", "b", "c", "d"].map((r) => vote(r, "support", 50)),
      ...["e", "f", "g"].map((r) => vote(r, "support", 60)),
      vote("h", "deny", 50),
      vote("i", "deny", 50),
    ];
    // 50: 4 − 2 = 2 (below threshold); 60: 3.
    expect(winnerOf(votes)).toBe(K(60));
  });

  it("an operator-blocked candidate can never win", () => {
    const votes = ["a", "b", "c"].map((r) => vote(r, "support", 50));
    expect(winnerOf(votes, [K(50)])).toBeNull();
  });

  it("decides each unit independently", () => {
    const votes = [
      ...["a", "b", "c"].map((r) => vote(r, "support", 50)),
      ...["d", "e", "f"].map((r) => vote(r, "support", 30, { unit: "mph" })),
    ];
    const winners = decideWinners(tallyVotes(votes), threshold, new Set());
    expect(winners.get("kmh")).toBe(K(50));
    expect(winners.get("mph")).toBe(K(30, "mph"));
  });

  it("a threshold of 1 lets a single device apply — the operator's call, not a code constant", () => {
    expect(decideWinners(tallyVotes([vote("a", "support", 50)]), 1, new Set()).get("kmh")).toBe(K(50));
  });
});

describe("deriveStatus", () => {
  const tallyOf = (votes: VoteInput[], value: number) => tallyVotes(votes).get(K(value))!;
  const three = (value: number) => ["a", "b", "c"].map((r) => vote(r, "support", value));

  it("proposed while below the threshold", () => {
    const t = tallyOf([vote("a", "support", 50)], 50);
    expect(deriveStatus({ tally: t, winnerKey: null, threshold: 3, blocked: false, wasApplied: false })).toBe("proposed");
  });

  it("applied for the winner", () => {
    const t = tallyOf(three(50), 50);
    expect(deriveStatus({ tally: t, winnerKey: K(50), threshold: 3, blocked: false, wasApplied: false })).toBe("applied");
  });

  it("reverted when a formerly applied value is no longer in effect", () => {
    const t = tallyOf([...three(50), vote("d", "deny", 50)], 50);
    expect(deriveStatus({ tally: t, winnerKey: null, threshold: 3, blocked: false, wasApplied: true })).toBe("reverted");
  });

  it("superseded when another value took over", () => {
    const t = tallyOf(three(50), 50);
    expect(deriveStatus({ tally: t, winnerKey: K(60), threshold: 3, blocked: false, wasApplied: true })).toBe("superseded");
    expect(deriveStatus({ tally: t, winnerKey: K(60), threshold: 3, blocked: false, wasApplied: false })).toBe("superseded");
  });

  it("a weak candidate beside a winner stays proposed", () => {
    const t = tallyOf([vote("a", "support", 70)], 70);
    expect(deriveStatus({ tally: t, winnerKey: K(50), threshold: 3, blocked: false, wasApplied: false })).toBe("proposed");
  });

  it("an operator block is always reverted", () => {
    const t = tallyOf(three(50), 50);
    expect(deriveStatus({ tally: t, winnerKey: K(50), threshold: 3, blocked: true, wasApplied: true })).toBe("reverted");
  });
});

describe("currentStance", () => {
  it("reports what the reporter currently holds, so repeats can be detected as no-ops", () => {
    const votes = [vote("a", "support", 50), vote("b", "deny", 50), vote("a", "support", 60)];
    expect(currentStance(votes, "a", "kmh", 50)).toBeNull();
    expect(currentStance(votes, "a", "kmh", 60)).toBe("support");
    expect(currentStance(votes, "b", "kmh", 50)).toBe("deny");
    expect(currentStance(votes, "c", "kmh", 50)).toBeNull();
  });
});

describe("correctionId", () => {
  it("is deterministic and depends on segment, unit and value", () => {
    const id = correctionId("abc", "kmh", 50);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(correctionId("abc", "kmh", 50)).toBe(id);
    expect(correctionId("abc", "kmh", 60)).not.toBe(id);
    expect(correctionId("abc", "mph", 50)).not.toBe(id);
    expect(correctionId("abd", "kmh", 50)).not.toBe(id);
  });
});
