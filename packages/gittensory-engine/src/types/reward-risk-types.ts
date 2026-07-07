// Local type mirrors for the reward-risk engine module (#2281).
//
// Mirrored by hand from `src/types.ts` and `src/signals/engine.ts` — the engine package cannot import
// across into `src/`, so (as with `predicted-gate-types.ts`) these are kept in sync manually. Types that
// only ever reach the injected `src`-side builders (see `RewardRiskEngineDeps` in `../reward-risk.ts`) or
// `buildScorePreview` are subset mirrors carrying just the fields those consumers require: because the
// omitted `src` fields are all optional, a subset stays mutually assignable to the full `src` type, and the
// real runtime objects still flow through the injected builders untouched. Types that appear in this
// module's PUBLIC return surface (`RoleContext`, `LaneAdvice`, `QueueHealth`) are full verbatim copies so
// existing consumers can read every field.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ParticipationLane = "direct_pr" | "issue_discovery" | "split" | "inactive" | "unknown";
export type ContributorRole = "outside_contributor" | "repo_maintainer" | "org_member" | "collaborator" | "owner" | "unknown";

export type AdvisorySeverity = "info" | "warning" | "critical";

export type AdvisoryFinding = {
  code: string;
  title: string;
  severity: AdvisorySeverity;
  detail: string;
  action?: string;
  publicText?: string;
  confidence?: number;
};
export type SignalFinding = AdvisoryFinding;

// --- src/types.ts record mirrors (full verbatim: these records are constructed as inline object literals
//     by the reward-risk tests/callers, so a subset would trip TypeScript's excess-property check) ---

export type RepoTimeDecayOverrides = {
  gracePeriodHours?: number | null | undefined;
  sigmoidMidpointDays?: number | null | undefined;
  sigmoidSteepness?: number | null | undefined;
  minMultiplier?: number | null | undefined;
};

export type RegistryRepoConfig = {
  repo: string;
  emissionShare: number;
  issueDiscoveryShare: number;
  labelMultipliers: Record<string, number>;
  trustedLabelPipeline?: boolean | null;
  maintainerCut: number;
  defaultLabelMultiplier?: number | null;
  fixedBaseScore?: number | null;
  eligibilityMode?: string | null;
  timeDecay?: RepoTimeDecayOverrides | null;
  raw: Record<string, JsonValue>;
};

export type RepositoryRecord = {
  fullName: string;
  owner: string;
  name: string;
  installationId?: number | null | undefined;
  isInstalled: boolean;
  isRegistered: boolean;
  isPrivate: boolean;
  htmlUrl?: string | null | undefined;
  defaultBranch?: string | null | undefined;
  registryConfig?: RegistryRepoConfig | null | undefined;
};

export type PullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  headSha?: string | null | undefined;
  headRef?: string | null | undefined;
  baseRef?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  mergedAt?: string | null | undefined;
  isDraft?: boolean | null | undefined;
  mergeableState?: string | null | undefined;
  reviewDecision?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  linkedIssueClaimedAt?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  slopRisk?: number | null | undefined;
  slopBand?: string | null | undefined;
  mergeAttemptCount?: number | null | undefined;
  mergeBlockedSha?: string | null | undefined;
  mergeBlockedReason?: string | null | undefined;
  approvedHeadSha?: string | null | undefined;
  lastRegatedAt?: string | null | undefined;
  lastPublishedSurfaceSha?: string | null | undefined;
  changedFiles?: string[] | undefined;
};

export type IssueRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  labels: string[];
  linkedPrs: number[];
};

export type RecentMergedPullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  authorLogin?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  mergedAt?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  changedFiles: string[];
  payload: Record<string, JsonValue>;
};

export type PullRequestFileRecord = {
  repoFullName: string;
  pullNumber: number;
  path: string;
  status?: string | null | undefined;
  additions: number;
  deletions: number;
  changes: number;
  previousFilename?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type PullRequestReviewRecord = {
  id: string;
  repoFullName: string;
  pullNumber: number;
  reviewerLogin?: string | null | undefined;
  state: string;
  authorAssociation?: string | null | undefined;
  submittedAt?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type CheckSummaryRecord = {
  id: string;
  repoFullName: string;
  pullNumber?: number | null | undefined;
  headSha?: string | null | undefined;
  name: string;
  status: string;
  conclusion?: string | null | undefined;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  detailsUrl?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type ScoringModelSnapshotRecord = {
  id: string;
  sourceKind: "raw-github" | "api" | "fallback" | "test";
  sourceUrl: string;
  fetchedAt: string;
  activeModel: "current_density_model" | "pending_saturation_model" | "exponential_saturation_model" | "unknown";
  constants: Record<string, number>;
  programmingLanguages: Record<string, JsonValue>;
  registrySnapshotId?: string | null | undefined;
  warnings: string[];
  payload: Record<string, JsonValue>;
};

// --- src/github/public.ts + src/signals/engine.ts mirrors ---

export type PublicContributorProfile = {
  login: string;
  topLanguages: string[];
  source: "github" | "unavailable";
};

export type ContributorProfile = {
  login: string;
  generatedAt: string;
  github: PublicContributorProfile;
  source: "gittensor_api" | "github_cache";
  registeredRepoActivity: {
    pullRequests: number;
    mergedPullRequests: number;
    issues: number;
    reposTouched: string[];
    dominantLabels: string[];
  };
  trustSignals: {
    evidenceScore: number;
    level: "new" | "emerging" | "established";
    unlinkedOpenPullRequests: number;
    maintainerAssociatedPullRequests: number;
  };
};

export type ContributorScoringProfile = {
  evidence: {
    credibilityAssumption: number;
  };
};

export type ContributorFit = {
  profile: ContributorProfile;
  languageFit: Array<{ repoFullName: string; language?: string | null | undefined; match: boolean }>;
  opportunities: Array<{ repoFullName: string }>;
};

export type OutcomePattern = {
  repoFullName?: string | undefined;
  title: string;
  detail: string;
  confidence: "high" | "medium" | "low";
};

export type ContributorOutcomeHistory = {
  login: string;
  generatedAt: string;
  source: ContributorProfile["source"];
  totals: {
    pullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    closedPullRequests: number;
    closedPullRequestRate: number;
    issues: number;
    openIssues: number;
    closedIssues: number;
    solvedIssues: number;
    validSolvedIssues: number;
    credibility: number;
    issueCredibility: number;
  };
  repoOutcomes: Array<{
    repoFullName: string;
    role: ContributorRole;
    lane: ParticipationLane;
    maintainerLane: boolean;
    pullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    closedPullRequests: number;
    closedPullRequestRate: number;
    issues: number;
    openIssues: number;
    closedIssues: number;
    solvedIssues: number;
    validSolvedIssues: number;
    credibility: number;
    issueCredibility: number;
    isEligible: boolean;
    successLevel: "strong" | "emerging" | "weak" | "maintainer_context";
    strengths: string[];
    risks: string[];
  }>;
  successPatterns: OutcomePattern[];
  failurePatterns: OutcomePattern[];
  summary: string;
};

// --- collision report (flows only between injected builders) ---

export type CollisionItem = {
  type: "issue" | "pull_request" | "recent_merged_pull_request";
  number: number;
  title: string;
};

export type CollisionCluster = {
  id: string;
  risk: "low" | "medium" | "high";
  reason: string;
  items: CollisionItem[];
};

export type CollisionReport = {
  repoFullName: string;
  generatedAt: string;
  summary: {
    clusterCount: number;
    highRiskCount: number;
    itemsReviewed: number;
  };
  clusters: CollisionCluster[];
};

// --- full verbatim public-surface types (src/signals/engine.ts) ---

export type RoleContext = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  role: ContributorRole;
  maintainerLane: boolean;
  normalContributorEvidenceAllowed: boolean;
  source: "github_association" | "repo_owner_match" | "gittensor_api" | "cache" | "unknown";
  association?: string | null | undefined;
  reasons: string[];
  guidance: string;
};

export type LaneAdvice = {
  lane: ParticipationLane;
  repoFullName: string;
  issueDiscoveryShare?: number | undefined;
  directPrShare?: number | undefined;
  summary: string;
  contributorGuidance: string;
  maintainerGuidance: string;
};

export type QueueHealth = {
  repoFullName: string;
  generatedAt: string;
  burdenScore: number;
  level: "low" | "medium" | "high" | "critical";
  summary: string;
  signals: {
    openIssues: number;
    openPullRequests: number;
    unlinkedPullRequests: number;
    stalePullRequests: number;
    draftPullRequests: number;
    maintainerAuthoredPullRequests: number;
    collisionClusters: number;
    ageBuckets: {
      under7Days: number;
      days7To30: number;
      over30Days: number;
    };
    likelyReviewablePullRequests: number;
    cachedOpenPullRequests?: number | undefined;
    likelyReviewablePullRequestsSource?: "cache" | "sampled_cache" | "authoritative" | undefined;
  };
  findings: SignalFinding[];
  rankedPullRequests?: {
    number: number;
    title: string;
    authorLogin: string;
    recommendation: string;
  }[];
};

// Only `.recommendation` is read from the injected `buildRepoFitRecommendation`; the full src type carries
// many more fields, all covariantly assignable to this narrowed mirror.
export type RepoFitRecommendation = {
  recommendation: "pursue" | "cleanup_first" | "maintainer_lane" | "avoid_for_now" | "unknown";
};
