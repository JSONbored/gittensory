import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_RULES,
  evaluateDenyHooks,
  synthesizeDenyRuleProposals,
  resolveEffectiveDenyRules,
  aggregateBlockerHistory,
} from "../../packages/gittensory-engine/src/index";

// Deny-hook pure-logic extraction (#5667). The evaluator + rule-proposal synthesis moved out of gittensory-miner
// into @loopover/engine. This regression test imports ONLY from the engine barrel (never the miner package) to
// prove the pure logic is callable from @loopover/engine alone -- no node:sqlite / node:fs / miner forge-config in
// the import graph -- and that the injected clock (nowMs) makes synthesis deterministic.

describe("deny-hook pure logic is callable from @loopover/engine alone (#5667)", () => {
  it("evaluateDenyHooks blocks a CI-workflow write and allows a benign path", () => {
    const blocked = evaluateDenyHooks({ name: "Write", input: { file_path: ".github/workflows/ci.yml" } });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy?.reason).toContain("CI workflows");

    const allowed = evaluateDenyHooks({ name: "Write", input: { file_path: "src/review/rag.ts" } });
    expect(allowed.allowed).toBe(true);
    expect(allowed.blockedBy).toBeUndefined();
  });

  it("synthesizeDenyRuleProposals stamps audit.synthesizedAt from the injected nowMs (pure, no SQLite)", () => {
    const nowMs = 1_700_000_000_000;
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ];

    const proposals = synthesizeDenyRuleProposals(history, {}, nowMs);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.rule.pathPattern).toBe("**/changelog.md");
    // The injected clock is the ONLY source of the timestamp -- proving no `new Date()` remains in the engine.
    expect(proposals[0]?.audit.synthesizedAt).toBe(new Date(nowMs).toISOString());

    // Deterministic: identical inputs (including nowMs) yield byte-identical proposals.
    expect(synthesizeDenyRuleProposals(history, {}, nowMs)).toEqual(proposals);
  });

  it("aggregateBlockerHistory and resolveEffectiveDenyRules are the same engine functions", () => {
    const history = [
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
      { blockerCodes: ["guardrail_hold"], changedPaths: ["CHANGELOG.md"] },
    ];
    expect(aggregateBlockerHistory(history).recordCount).toBe(2);
    // With nothing approved, effective rules fall back to the built-in defaults.
    expect(resolveEffectiveDenyRules()).toEqual(DEFAULT_DENY_RULES);
    const proposals = synthesizeDenyRuleProposals(history, {}, 1_700_000_000_000);
    expect(resolveEffectiveDenyRules({ approvedProposals: proposals })).toEqual(DEFAULT_DENY_RULES);
  });
});
