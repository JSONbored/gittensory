import { describe, expect, it } from "vitest";
import { buildReviewThreadBlocker, reviewThreadBlockerFinding, type ReviewThreadBlocker } from "../../src/review/review-thread-findings";

describe("buildReviewThreadBlocker", () => {
  it("returns null when there are no comments", () => {
    expect(buildReviewThreadBlocker({ comments: [] })).toBeNull();
  });

  it("returns null when every comment is empty or whitespace-only", () => {
    expect(buildReviewThreadBlocker({ comments: [{ body: "" }, { body: "   " }, { body: null }, { body: undefined }] })).toBeNull();
  });

  it("picks the scanner-marker comment over an earlier non-scanner comment and parses its markdown priority/title", () => {
    const blocker = buildReviewThreadBlocker({
      path: "src/app.ts",
      line: 12,
      comments: [
        { body: "just a human note", authorLogin: "alice", url: "https://gh/1" },
        { body: "<!-- brin-pr-finding fp=abc -->\n**P1:** Guard the null branch", authorLogin: "review-bot", url: "https://gh/2" },
      ],
    });
    expect(blocker).toEqual({
      title: "Guard the null branch",
      priority: "P1",
      path: "src/app.ts",
      line: 12,
      authorLogin: "review-bot",
      url: "https://gh/2",
      scannerFinding: true,
    });
  });

  it("also treats a superagent-finding-fingerprint marker as a scanner comment", () => {
    const blocker = buildReviewThreadBlocker({
      comments: [{ body: "<!-- superagent-finding-fingerprint: deadbeef -->\nSomething", authorLogin: "bot", url: null }],
    });
    expect(blocker?.scannerFinding).toBe(true);
  });

  it("falls back to the first comment and parses an XML priority/title when no scanner marker is present", () => {
    const blocker = buildReviewThreadBlocker({
      comments: [{ body: "<priority>P2</priority><title>Broken layout</title>", authorLogin: "carol", url: "https://gh/3" }],
    });
    expect(blocker).toMatchObject({
      title: "Broken layout",
      priority: "P2",
      authorLogin: "carol",
      url: "https://gh/3",
      scannerFinding: false,
    });
  });

  it("uses the first meaningful line as the title (skipping comment/details/summary/fence lines) and omits priority when none is present", () => {
    const blocker = buildReviewThreadBlocker({
      comments: [{ body: "<!-- hidden -->\n<details>\n<summary>context</summary>\n```\nUnresolved: needs a real fix here" }],
    });
    expect(blocker?.title).toBe("Unresolved: needs a real fix here");
    expect(blocker).not.toHaveProperty("priority");
  });

  it("falls back to the literal \"review thread\" title when the body has no meaningful line", () => {
    const blocker = buildReviewThreadBlocker({
      comments: [{ body: "<!-- only a comment -->\n```\n```" }],
    });
    expect(blocker?.title).toBe("review thread");
  });
});

describe("reviewThreadBlockerFinding", () => {
  const base: ReviewThreadBlocker = { title: "Guard the null branch", scannerFinding: false };

  it("prefixes the actor and priority and appends a path:line location when all are present", () => {
    const finding = reviewThreadBlockerFinding({ ...base, authorLogin: "review-bot", priority: "P1", path: "src/app.ts", line: 12 });
    expect(finding.code).toBe("review_thread_unresolved");
    expect(finding.severity).toBe("critical");
    expect(finding.title).toBe("review-bot review thread unresolved: P1 Guard the null branch (src/app.ts:12)");
    expect(finding.detail).toContain("at src/app.ts:12");
  });

  it("uses a path-only location when the line is missing", () => {
    const finding = reviewThreadBlockerFinding({ ...base, path: "src/app.ts" });
    expect(finding.title).toBe("review thread unresolved: Guard the null branch (src/app.ts)");
    expect(finding.detail).toContain("at src/app.ts");
  });

  it("uses a path-only location when the line is zero or not finite", () => {
    expect(reviewThreadBlockerFinding({ ...base, path: "src/app.ts", line: 0 }).title).toBe(
      "review thread unresolved: Guard the null branch (src/app.ts)",
    );
    expect(reviewThreadBlockerFinding({ ...base, path: "src/app.ts", line: Number.NaN }).title).toBe(
      "review thread unresolved: Guard the null branch (src/app.ts)",
    );
  });

  it("emits no actor, priority, or location when the blocker carries none of them (line without a path is ignored)", () => {
    const finding = reviewThreadBlockerFinding({ ...base, line: 12 });
    expect(finding.title).toBe("review thread unresolved: Guard the null branch");
    expect(finding.detail).not.toContain(" at ");
  });
});
