import { describe, expect, it, vi } from "vitest";
import {
  assessSubnetClaims,
  buildSubnetClaimFinding,
  detectSubnetClaims,
  MAX_RECOGNIZED_NETUID,
  type NetuidValidation,
} from "../../src/signals/subnet-claim";
import { isPublicSafeText } from "../../src/signals/redaction";

function assertPublicSafe(finding: { title: string; detail: string; action?: string; publicText?: string }) {
  for (const text of [finding.title, finding.detail, finding.action ?? "", finding.publicText ?? ""]) {
    expect(isPublicSafeText(text)).toBe(true);
  }
}

describe("detectSubnetClaims", () => {
  it("returns nothing for empty/blank input", () => {
    expect(detectSubnetClaims(null)).toEqual([]);
    expect(detectSubnetClaims(undefined)).toEqual([]);
    expect(detectSubnetClaims("")).toEqual([]);
    expect(detectSubnetClaims("just a normal description with no claims")).toEqual([]);
  });

  it("detects the common subnet/netuid phrasings", () => {
    expect(detectSubnetClaims("This integrates subnet 42 cleanly")).toEqual([{ netuid: 42, raw: "subnet 42" }]);
    expect(detectSubnetClaims("targets netuid 5")[0]?.netuid).toBe(5);
    expect(detectSubnetClaims("net uid 9")[0]?.netuid).toBe(9);
    expect(detectSubnetClaims("netuid: 12")[0]?.netuid).toBe(12);
    expect(detectSubnetClaims("netuid=7")[0]?.netuid).toBe(7);
    expect(detectSubnetClaims("subnet #3")[0]?.netuid).toBe(3);
    expect(detectSubnetClaims("subnet-8")[0]?.netuid).toBe(8);
    expect(detectSubnetClaims("supports subnets 2")[0]?.netuid).toBe(2);
    expect(detectSubnetClaims("built for SN74")[0]?.netuid).toBe(74);
    expect(detectSubnetClaims("sn 11")[0]?.netuid).toBe(11);
    expect(detectSubnetClaims("subnet number 7")[0]?.netuid).toBe(7);
  });

  it("deduplicates by netuid and sorts ascending", () => {
    expect(detectSubnetClaims("subnet 42 and later netuid 42, plus subnet 5")).toEqual([
      { netuid: 5, raw: "subnet 5" },
      { netuid: 42, raw: "subnet 42" },
    ]);
  });

  it("ignores out-of-range numbers and non-claim words", () => {
    expect(detectSubnetClaims("released in subnet 2024")).toEqual([]); // year-like, > MAX
    expect(detectSubnetClaims(`subnet ${MAX_RECOGNIZED_NETUID + 1}`)).toEqual([]);
    expect(detectSubnetClaims(`subnet ${MAX_RECOGNIZED_NETUID}`)).toEqual([{ netuid: MAX_RECOGNIZED_NETUID, raw: `subnet ${MAX_RECOGNIZED_NETUID}` }]);
    expect(detectSubnetClaims("refactored the subnetwork module")).toEqual([]);
    expect(detectSubnetClaims("took a snapshot at step 5")).toEqual([]);
    expect(detectSubnetClaims("netuid zero")).toEqual([]); // no digit
  });

  it("accepts the root subnet (netuid 0)", () => {
    expect(detectSubnetClaims("binds netuid 0")).toEqual([{ netuid: 0, raw: "netuid 0" }]);
  });
});

describe("buildSubnetClaimFinding", () => {
  it("surfaces a public-safe warning for a non-existent subnet", () => {
    const finding = buildSubnetClaimFinding({ netuid: 999, status: "not_found", detail: "metagraphed reports subnet 999 does not exist." });
    expect(finding).not.toBeNull();
    expect(finding!.code).toBe("subnet_claim_not_found");
    expect(finding!.severity).toBe("warning");
    expect(finding!.title).toContain("999");
    expect(finding!.detail).toContain("metagraphed");
    assertPublicSafe(finding!);
  });

  it("surfaces a public-safe warning for an unhealthy subnet", () => {
    const finding = buildSubnetClaimFinding({ netuid: 12, status: "exists_unhealthy", detail: "metagraphed reports subnet 12 interface health did not pass." });
    expect(finding!.code).toBe("subnet_claim_unhealthy");
    expect(finding!.severity).toBe("warning");
    assertPublicSafe(finding!);
  });

  it("produces no finding for healthy or unavailable verdicts", () => {
    expect(buildSubnetClaimFinding({ netuid: 7, status: "exists_healthy", detail: "ok" })).toBeNull();
    expect(buildSubnetClaimFinding({ netuid: 7, status: "unavailable", detail: "down" })).toBeNull();
  });
});

describe("assessSubnetClaims", () => {
  const validatorFor = (statuses: Record<number, NetuidValidation["status"]>) =>
    vi.fn(async (netuid: number): Promise<NetuidValidation> => ({ netuid, status: statuses[netuid] ?? "exists_healthy", detail: `verdict for ${netuid}` }));

  it("returns no findings when there are no claims (and never calls the validator)", async () => {
    const validate = validatorFor({});
    expect(await assessSubnetClaims({ title: "plain title", body: "plain body" }, validate)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  it("validates each distinct claimed netuid across title + body and collects only actionable findings", async () => {
    const validate = validatorFor({ 42: "not_found", 7: "exists_healthy", 9: "exists_unhealthy" });
    const findings = await assessSubnetClaims({ title: "integrates subnet 42", body: "also subnet 7 and subnet 9" }, validate);
    expect(validate).toHaveBeenCalledTimes(3); // 7, 9, 42 distinct
    expect(findings.map((f) => f.code)).toEqual(["subnet_claim_unhealthy", "subnet_claim_not_found"]); // netuid 7 healthy → omitted, sorted 9 then 42
  });

  it("tolerates a missing title (body only)", async () => {
    const validate = validatorFor({ 5: "not_found" });
    const findings = await assessSubnetClaims({ body: "needs subnet 5" }, validate);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("subnet_claim_not_found");
  });

  it("tolerates a missing body (title only)", async () => {
    const validate = validatorFor({ 8: "not_found" });
    const findings = await assessSubnetClaims({ title: "integrates subnet 8" }, validate);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("subnet_claim_not_found");
  });
});
