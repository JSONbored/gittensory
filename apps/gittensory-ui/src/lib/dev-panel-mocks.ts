import type {
  GittensorConfigRecommendationPayload,
  RegistrationReadinessPayload,
} from "./registration-workspace";

const MOCK_NOW = "2026-06-20T12:00:00.000Z";

export type MaintainerDashboardMock = {
  metrics: Array<{ label: string; value: number; spark: number[] }>;
  health: Array<{
    installationId: number;
    accountLogin: string;
    installedReposCount: number;
    status: "healthy" | "needs_attention" | "broken";
    missingPermissions: string[];
    missingEvents: string[];
    checkedAt: string;
  }>;
  reviewability: Array<{
    pr: string;
    title: string;
    author: string;
    bucket: string;
    reason: string;
    slop?: { risk: number; band: string } | null;
  }>;
  settingsPreview: { removed: string[]; added: string[] };
};

export type MinerDashboardMock = {
  status: "ready" | "needs_refresh";
  login: string;
  nextActions: Array<Record<string, unknown>>;
  blockers: Array<{
    group: string;
    items: Array<{ code: string; title: string; howToClear: string }>;
  }>;
  projections: Array<{ name: string; label: string; weight: number; note: string }>;
  repoFit: Array<Record<string, unknown>>;
  mcp?: { snapshot?: string | null; drift?: string | null; lastRun?: string | null };
};

export const MOCK_OWNER_REPO = "JSONbored/gittensory";

export const MAINTAINER_DASHBOARD_MOCK: MaintainerDashboardMock = {
  metrics: [
    { label: "Open PRs", value: 14, spark: [4, 6, 8, 11, 14, 12, 14] },
    { label: "Review-now", value: 3, spark: [1, 2, 2, 3, 3, 2, 3] },
    { label: "Installations", value: 2, spark: [2, 2, 2, 2, 2, 2, 2] },
    { label: "Repos tracked", value: 9, spark: [6, 7, 7, 8, 8, 9, 9] },
  ],
  health: [
    {
      installationId: 1001,
      accountLogin: "JSONbored",
      installedReposCount: 6,
      status: "healthy",
      missingPermissions: [],
      missingEvents: [],
      checkedAt: MOCK_NOW,
    },
    {
      installationId: 1002,
      accountLogin: "entrius",
      installedReposCount: 3,
      status: "needs_attention",
      missingPermissions: ["pull_requests:write"],
      missingEvents: ["pull_request"],
      checkedAt: MOCK_NOW,
    },
  ],
  reviewability: [
    {
      pr: "JSONbored/gittensory#142",
      title: "feat(ui): responsive tables and theme toggle",
      author: "kiannidev",
      bucket: "review-now",
      reason: "Merge-ready with linked issue and passing CI hints.",
      slop: { risk: 12, band: "low" },
    },
    {
      pr: "JSONbored/gittensory#138",
      title: "docs: clarify maintainer install trust checklist",
      author: "docs-bot",
      bucket: "watch",
      reason: "Low churn docs PR; no maintainer lane signal yet.",
      slop: { risk: 4, band: "clean" },
    },
    {
      pr: "entrius/allways-ui#57",
      title: "fix: tighten linked-issue gate for draft PRs",
      author: "lane-dev",
      bucket: "needs-author",
      reason: "Missing validation evidence in PR body.",
      slop: null,
    },
    {
      pr: "entrius/allways-ui#61",
      title: "chore: dependency refresh (automated)",
      author: "dependabot",
      bucket: "redirect",
      reason: "Bot author without maintainer lane context.",
      slop: { risk: 68, band: "elevated" },
    },
    {
      pr: "JSONbored/gittensory#130",
      title: "refactor: split registration workspace cards",
      author: "jsonbored",
      bucket: "review_now",
      reason: "Maintainer-authored follow-up with small diff.",
      slop: { risk: 81, band: "high" },
    },
  ],
  settingsPreview: {
    removed: ["linkedIssueGateMode: off", "publicSurface: off"],
    added: [
      "linkedIssueGateMode: block",
      "publicSurface: comment_and_label",
      "slopGateMode: advisory",
    ],
  },
};

export const MINER_DASHBOARD_MOCK: MinerDashboardMock = {
  status: "ready",
  login: "local-preview",
  nextActions: [
    {
      actionKind: "open_new_direct_pr",
      repoFullName: "JSONbored/gittensory",
      recommendation: "pursue",
      priorityScore: 84,
      change: {
        status: "changed",
        summary: "Queue pressure eased; direct-PR lane reopened.",
        labels: [
          { kind: "repo_state", label: "open PRs", before: "5", after: "2" },
          { kind: "validation_state", label: "preflight", before: "missing", after: "passed" },
        ],
      },
    },
    {
      actionKind: "cleanup_open_pr",
      repoFullName: "entrius/allways-ui",
      recommendation: "cleanup-first",
      priorityScore: 61,
      change: { status: "unchanged", summary: "Still blocked by open-PR pressure.", labels: [] },
    },
  ],
  blockers: [
    {
      group: "scoreability",
      items: [
        {
          code: "linked_issue_missing",
          title: "Linked issue required",
          howToClear: "Reference a repo issue in the PR body or title before opening.",
        },
      ],
    },
    {
      group: "decision-pack",
      items: [
        {
          code: "refresh_stale",
          title: "Decision pack is stale",
          howToClear: "Run Refresh on the miner dashboard or rebuild via MCP plan.",
        },
      ],
    },
  ],
  projections: [
    {
      name: "direct_pr",
      label: "Direct PR lane",
      weight: 0.62,
      note: "Best fit for code changes with tests.",
    },
    {
      name: "issue_discovery",
      label: "Issue discovery",
      weight: 0.24,
      note: "Use when triage-ready issues exist.",
    },
    {
      name: "maintainer_lane",
      label: "Maintainer lane",
      weight: 0.14,
      note: "Only when you are a listed maintainer.",
    },
  ],
  repoFit: [
    {
      repoFullName: "JSONbored/gittensory",
      lane: "pursue",
      recommendation: "pursue",
      why: "Low queue burden, trusted label pipeline, and strong preflight history.",
      change: { status: "changed", summary: "Moved from watch to pursue.", labels: [] },
    },
    {
      repoFullName: "entrius/allways-ui",
      lane: "cleanup-first",
      recommendation: "cleanup-first",
      why: "Open PR count exceeds dynamic threshold until one merge lands.",
      change: { status: "unchanged", summary: "Still cleanup-first.", labels: [] },
    },
    {
      repoFullName: "entrius/gittensor",
      lane: "maintainer-lane",
      recommendation: "maintainer-lane",
      why: "Maintainer association detected; use maintainer issue multiplier path.",
      change: { status: "new", summary: "New maintainer-lane signal.", labels: [] },
    },
    {
      repoFullName: "JSONbored/awesome-claude",
      lane: "avoid",
      recommendation: "avoid",
      why: "Issue-discovery-only repo with saturated intake this week.",
      change: { status: "unchanged", summary: "Avoid for now.", labels: [] },
    },
  ],
  mcp: {
    snapshot: "score-model-fixture",
    drift: "none",
    lastRun: MOCK_NOW,
  },
};

export const OWNER_REGISTRATION_READINESS_MOCK: RegistrationReadinessPayload = {
  repoFullName: MOCK_OWNER_REPO,
  generatedAt: MOCK_NOW,
  ready: false,
  recommendedRegistrationMode: "split",
  issuePolicy: "split_pr_and_issue_discovery_enabled",
  directPrReadiness: {
    ready: true,
    reasons: ["Direct-PR lane is healthy with linked-issue gate enabled."],
  },
  issueDiscoveryReadiness: {
    ready: true,
    recommendation: "recommended_with_guardrails",
    reasons: ["Issue queue is staffed and discovery share is non-zero."],
  },
  labelPolicy: {
    autoLabelEnabled: true,
    label: "gittensor",
    trustedPipelineReady: true,
    missingOrUnusedRegistryLabels: ["bug", "feature"],
  },
  maintainerCutReadiness: {
    ready: true,
    summary: "Maintainer cut can be reviewed without blocking intake.",
    reasons: ["Queue burden is moderate."],
    warnings: ["Consider documenting maintainer cut in CONTRIBUTING.md."],
    recommendedAction: "consider_small_cut",
  },
  testCoverageHealth: {
    status: "gate_ready",
    trustedLabelPipelineReady: true,
    checkRunMode: "enabled",
    requiredGate: ["npm run test:ci", "npm run ui:test"],
    note: "Use repo CI gates before widening contributor intake.",
    warnings: [],
  },
  queueHealth: {
    level: "moderate",
    burdenScore: 0.48,
    reviewablePullRequests: 5,
    summary: "Five PRs are reviewable; queue burden is moderate.",
  },
  contributorIntakeHealth: {
    level: "healthy",
    summary: "Contributor intake signals are stable.",
  },
  githubApp: {
    installed: true,
    publicSurface: "comment_and_label",
    commentMode: "detected_contributors_only",
    checkRunMode: "enabled",
    quietByDefault: true,
    behavior: "Quiet-by-default GitHub App assistance with check runs enabled.",
    warnings: [],
  },
  policyReadiness: {
    summary: "Focus manifest present with one warning.",
    publicWarnings: [
      {
        title: "Validation expectations missing",
        detail: "Add explicit validation commands to CONTRIBUTING.md.",
        action: "Document npm run test:ci as the minimum bar.",
        severity: "warn",
      },
    ],
  },
  blockers: ["Document maintainer cut policy before enabling maintainerCut > 0."],
  warnings: ["Registry emission share is below recommended minimum for new repos."],
  docsCompleteness: {
    status: "repo_docs_not_crawled",
    requiredDocs: ["CONTRIBUTING.md", "README.md"],
    note: "Gittensory validates public repo docs locally; remote crawl is not enabled yet.",
  },
  dataQuality: { status: "complete", partial: false, warnings: [] },
};

export const OWNER_CONFIG_RECOMMENDATION_MOCK: GittensorConfigRecommendationPayload = {
  repoFullName: MOCK_OWNER_REPO,
  generatedAt: MOCK_NOW,
  privateOnly: true,
  current: { participationMode: "direct_pr", maintainerCut: 0, issueDiscoveryShare: 0 },
  recommended: { participationMode: "split", maintainerCut: 0.15, issueDiscoveryShare: 0.25 },
  tradeoffs: [
    "Split mode opens issue-discovery flow but increases maintainer triage load.",
    "A 15% maintainer cut rewards upkeep while leaving most share for contributors.",
  ],
  reasons: [
    "Queue health supports a small issue-discovery slice without blocking direct PRs.",
    "Trusted label pipeline is ready for widened intake.",
  ],
  warnings: ["Confirm maintainer cut policy in public docs before applying."],
  dataQuality: { status: "complete", partial: false, warnings: [] },
};
