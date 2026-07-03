import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as appModule from "../../src/github/app";
import {
  DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION,
  fetchLinkedIssueLabelsForPropagation,
  normalizeLinkedIssueLabelPropagationConfig,
} from "../../src/review/linked-issue-label-propagation";

describe("normalizeLinkedIssueLabelPropagationConfig (#priority-linked-issue-gate)", () => {
  it("returns the disabled default when the input is omitted", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueLabelPropagationConfig(undefined, warnings)).toEqual(DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION);
    expect(warnings).toEqual([]);
  });

  it("warns and returns the disabled default for a non-object input", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueLabelPropagationConfig("nope", warnings)).toEqual(DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION);
    expect(warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation"))).toBe(true);
  });

  it("warns and returns the disabled default for an array input", () => {
    const warnings: string[] = [];
    expect(normalizeLinkedIssueLabelPropagationConfig([1, 2], warnings)).toEqual(DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("passes through a full, valid config unchanged", () => {
    const warnings: string[] = [];
    const input = {
      enabled: true,
      mode: "exclusive_type_label",
      mappings: [{ issueLabel: "gittensor:priority", prLabel: "gittensor:priority", removeOtherTypeLabels: true }],
    };
    expect(normalizeLinkedIssueLabelPropagationConfig(input, warnings)).toEqual(input);
    expect(warnings).toEqual([]);
  });

  it("warns and falls back to the default mode for an unrecognized mode value", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mode: "something_else", mappings: [] }, warnings);
    expect(result.mode).toBe("exclusive_type_label");
    expect(warnings.some((w) => w.includes("mode"))).toBe(true);
  });

  it("drops a malformed mapping entry (missing prLabel) with a warning, keeping the other valid entries", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig(
      {
        enabled: true,
        mappings: [
          { issueLabel: "gittensor:priority" },
          { issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false },
        ],
      },
      warnings,
    );
    expect(result.mappings).toEqual([{ issueLabel: "customer:vip", prLabel: "triage:vip", removeOtherTypeLabels: false }]);
    expect(warnings.some((w) => w.includes("mappings[0]"))).toBe(true);
  });

  it("drops a non-object mapping entry with a warning", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: ["not-an-object"] }, warnings);
    expect(result.mappings).toEqual([]);
    expect(warnings.some((w) => w.includes("mappings[0]"))).toBe(true);
  });

  it("warns and uses no mappings when mappings is not an array", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: "nope" }, warnings);
    expect(result.mappings).toEqual([]);
    expect(warnings.some((w) => w.includes("settings.linkedIssueLabelPropagation.mappings"))).toBe(true);
  });

  it("defaults removeOtherTypeLabels to false when omitted from a mapping", () => {
    const warnings: string[] = [];
    const result = normalizeLinkedIssueLabelPropagationConfig({ enabled: true, mappings: [{ issueLabel: "a", prLabel: "b" }] }, warnings);
    expect(result.mappings).toEqual([{ issueLabel: "a", prLabel: "b", removeOtherTypeLabels: false }]);
  });
});

describe("fetchLinkedIssueLabelsForPropagation (#priority-linked-issue-gate)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(input.toString(), init?.method ?? "GET"));
  }

  it("returns [] and fetches nothing when there are no linked issues", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [], installationId: 123 });
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the flattened labels for a single found linked issue", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1")) return Response.json({ number: 1, state: "open", labels: ["gittensor:priority", "help wanted"] });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1], installationId: 123 });
    expect(result).toEqual(["gittensor:priority", "help wanted"]);
  });

  it("surfaces only the successful issue's labels when one of several linked issues fails to fetch (partial fail-open)", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1")) return Response.json({ number: 1, state: "open", labels: ["gittensor:priority"] });
      if (url.endsWith("/issues/2")) return new Response("server error", { status: 500 });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1, 2], installationId: 123 });
    expect(result).toEqual(["gittensor:priority"]);
  });

  it("returns [] when every linked issue fails to fetch (fully fail-open — never applies a sensitive label without a verified source)", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("server error", { status: 500 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1, 2], installationId: 123 });
    expect(result).toEqual([]);
  });

  it("falls back to the public token and still fails open (never throws) when the installation-token mint fails", async () => {
    const spy = vi.spyOn(appModule, "createInstallationToken").mockRejectedValue(new Error("mint failed"));
    stubFetch((url) => (url.endsWith("/issues/1") ? Response.json({ number: 1, state: "open", labels: ["gittensor:priority"] }) : new Response("not found", { status: 404 })));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1], installationId: 123 });
    expect(result).toEqual(["gittensor:priority"]);
    spy.mockRestore();
  });
});
