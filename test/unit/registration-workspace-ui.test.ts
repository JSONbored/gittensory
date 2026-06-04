import { describe, expect, it } from "vitest";

import {
  buildRegistrationOwnerWorkflow,
  buildRegistrationWorkspaceView,
  collectRegistrationOwnerWorkflowPublicText,
  collectRegistrationWorkspacePublicText,
  isRegistrationWorkspacePublicSafe,
  resolveRegistrationWorkspaceFreshness,
  sanitizeRegistrationWorkspaceText,
  type GittensorConfigRecommendationPayload,
  type RegistrationReadinessPayload,
} from "../../apps/gittensory-ui/src/lib/registration-workspace";

const FORBIDDEN =
  /wallet|hotkey|raw trust score|payout|\breward\b|reward estimate|farming|private reviewability|public score estimate/i;

function readyFixture(overrides: Partial<RegistrationReadinessPayload> = {}): RegistrationReadinessPayload {
  return {
    repoFullName: "JSONbored/gittensory",
    generatedAt: "2026-06-01T00:00:00.000Z",
    ready: true,
    recommendedRegistrationMode: "direct_pr",
    issuePolicy: "direct_pr_no_issue_required",
    directPrReadiness: { ready: true, reasons: ["Direct-PR intake is healthy."] },
    issueDiscoveryReadiness: {
      ready: false,
      recommendation: "not_recommended",
      reasons: ["Issue discovery should stay off until intake is excellent."],
    },
    labelPolicy: {
      autoLabelEnabled: true,
      label: "gittensor",
      trustedPipelineReady: true,
      missingOrUnusedRegistryLabels: [],
    },
    maintainerCutReadiness: {
      ready: true,
      summary: "Maintainer cut can be reviewed without blocking intake.",
      reasons: ["Queue burden is low."],
      warnings: [],
      recommendedAction: "consider_small_cut",
    },
    testCoverageHealth: {
      status: "gate_ready",
      trustedLabelPipelineReady: true,
      checkRunMode: "enabled",
      requiredGate: ["npm run test:ci"],
      note: "Use repo CI gates before widening contributor intake.",
      warnings: [],
    },
    queueHealth: {
      level: "low",
      burdenScore: 0.2,
      reviewablePullRequests: 3,
      summary: "Queue burden is low.",
    },
    contributorIntakeHealth: { level: "healthy", summary: "Contributor intake is healthy." },
    githubApp: {
      installed: true,
      publicSurface: "comment_and_label",
      commentMode: "detected_contributors_only",
      checkRunMode: "enabled",
      quietByDefault: true,
      behavior: "Quiet-by-default GitHub App assistance.",
      warnings: [],
    },
    policyReadiness: null,
    blockers: [],
    warnings: [],
    docsCompleteness: {
      status: "repo_docs_not_crawled",
      requiredDocs: ["CONTRIBUTING.md", "README.md"],
      note: "Gittensory validates public repo docs locally; remote crawl is not enabled yet.",
    },
    dataQuality: { status: "complete", partial: false, warnings: [] },
    ...overrides,
  };
}

function configFixture(): GittensorConfigRecommendationPayload {
  return {
    repoFullName: "JSONbored/gittensory",
    generatedAt: "2026-06-01T00:00:00.000Z",
    privateOnly: true,
    current: { maintainerCut: 0 },
    recommended: { participationMode: "direct_pr", maintainerCut: 0.3, issueDiscoveryShare: 0 },
    tradeoffs: [
      "Staying direct-PR-only keeps maintainer triage low but forgoes issue-discovery contributor flow.",
      "Introducing a maintainer cut rewards upkeep but reduces the share available to contributor miners.",
    ],
    reasons: ["Direct-PR mode is the safest default until issue-discovery intake is intentionally staffed."],
    warnings: [],
    dataQuality: { status: "complete", partial: false, warnings: [] },
  };
}

describe("registration workspace UI helpers", () => {
  it("ready fixture produces an advisory workspace view with separated lanes", () => {
    const view = buildRegistrationWorkspaceView(readyFixture(), configFixture());
    expect(view.summary.ready).toBe(true);
    expect(view.lanes.directPr.status).toBe("ready");
    expect(view.lanes.issueDiscovery.title).toMatch(/Issue discovery/i);
    expect(view.lanes.maintainerEconomics.title).toMatch(/Maintainer economics/i);
    expect(view.lanes.minerGuidance.title).toMatch(/Miner scoreability/i);
    expect(view.config?.tradeoffs.length).toBeGreaterThan(0);
    expect(view.advisoryBanner).toMatch(/Advisory/i);
  });

  it("not-ready fixture surfaces blockers and blocked summary status", () => {
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        ready: false,
        blockers: ["Repository config quality needs attention before registration promotion."],
        directPrReadiness: { ready: false, reasons: ["Config quality is fragile."] },
      }),
      null,
    );
    expect(view.summary.ready).toBe(false);
    expect(view.summary.status).toBe("blocked");
    expect(view.summary.headline).toMatch(/Resolve blockers/i);
  });

  it("stale data fixture marks freshness degraded and keeps warnings", () => {
    const freshness = resolveRegistrationWorkspaceFreshness(
      { status: "degraded", partial: true, warnings: ["Burden forecast unavailable for JSONbored/gittensory."] },
      { status: "complete", partial: false, warnings: [] },
    );
    expect(freshness.status).toBe("degraded");
    expect(freshness.warnings[0]).toMatch(/Burden forecast unavailable/i);

    const view = buildRegistrationWorkspaceView(
      readyFixture({
        dataQuality: { status: "degraded", partial: true, warnings: freshness.warnings },
      }),
      configFixture(),
    );
    expect(view.freshness.status).toBe("degraded");
    expect(view.freshness.warnings.length).toBeGreaterThan(0);
  });

  it("public text hygiene regression drops forbidden language from workspace output", () => {
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        warnings: ["wallet hotkey payout estimate should be removed"],
        directPrReadiness: { ready: true, reasons: ["Safe reason only."] },
      }),
      configFixture(),
    );
    const publicText = collectRegistrationWorkspacePublicText(view).join("\n");
    expect(publicText).not.toMatch(FORBIDDEN);
    expect(sanitizeRegistrationWorkspaceText("estimate your reward")).toBeNull();
    expect(isRegistrationWorkspacePublicSafe("Queue burden is low.")).toBe(true);
  });

  it("guided workflow groups readiness into five buckets with remediation", () => {
    const workflow = buildRegistrationOwnerWorkflow(readyFixture(), configFixture());
    expect(workflow.buckets.map((bucket) => bucket.id)).toEqual([
      "policy",
      "data_quality",
      "queue_health",
      "docs_onboarding",
      "maintainer_capacity",
    ]);
    const docs = workflow.buckets.find((bucket) => bucket.id === "docs_onboarding");
    expect(docs?.state).toBe("needs_cleanup");
    expect(docs?.items[0]?.remediationKind).toBe("manual");
    expect(workflow.overallState).toBe("needs_cleanup");
    expect(workflow.nextSteps.length).toBeGreaterThan(0);
  });

  it("blocked readiness maps workflow to not ready with concrete blocker remediation", () => {
    const workflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        ready: false,
        blockers: ["Repository config quality needs attention before registration promotion."],
        directPrReadiness: { ready: false, reasons: ["Config quality is fragile."] },
        queueHealth: {
          level: "critical",
          burdenScore: 0.95,
          reviewablePullRequests: 40,
          summary: "Queue burden is critical.",
        },
      }),
      null,
    );
    expect(workflow.overallState).toBe("not_ready");
    expect(workflow.buckets.find((bucket) => bucket.id === "queue_health")?.state).toBe("not_ready");
    const policy = workflow.buckets.find((bucket) => bucket.id === "policy");
    expect(policy?.items.some((item) => item.title === "Registration blocker")).toBe(true);
    expect(collectRegistrationOwnerWorkflowPublicText(workflow).join(" ")).not.toMatch(FORBIDDEN);
  });

  it("accepted workflow when readiness is ready and buckets are clear", () => {
    const workflow = buildRegistrationOwnerWorkflow(
      readyFixture({
        docsCompleteness: {
          status: "verified",
          requiredDocs: ["CONTRIBUTING.md"],
          note: "Docs verified locally.",
        },
        testCoverageHealth: {
          status: "gate_ready",
          trustedLabelPipelineReady: true,
          checkRunMode: "enabled",
          requiredGate: ["npm run test:ci"],
          note: "Gates ready.",
          warnings: [],
        },
      }),
      configFixture(),
    );
    expect(workflow.overallState).toBe("accepted");
    expect(workflow.buckets.every((bucket) => bucket.state === "accepted")).toBe(true);
    const view = buildRegistrationWorkspaceView(
      readyFixture({
        ready: true,
        docsCompleteness: { status: "verified", requiredDocs: ["CONTRIBUTING.md"], note: "Docs verified locally." },
      }),
      configFixture(),
    );
    expect(view.workflow.overallState).toBe("accepted");
  });

  it("never emits forbidden language across randomized warning injections", () => {
    const injections = [
      "wallet",
      "hotkey",
      "raw trust score",
      "payout",
      "reward estimate",
      "farming",
      "private reviewability",
      "public score estimate",
    ];
    for (const injection of injections) {
      const view = buildRegistrationWorkspaceView(
        readyFixture({ warnings: [`Blocked phrase ${injection} must not render`] }),
        configFixture(),
      );
      expect(collectRegistrationWorkspacePublicText(view).join(" ")).not.toMatch(FORBIDDEN);
      expect(collectRegistrationOwnerWorkflowPublicText(view.workflow).join(" ")).not.toMatch(FORBIDDEN);
    }
  });
});
