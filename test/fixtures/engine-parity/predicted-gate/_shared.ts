import { parseFocusManifest, type FocusManifest } from "../../../../src/signals/focus-manifest";
import type { PredictedGateInput, PredictedGateVerdict } from "../../../../src/rules/predicted-gate";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../../../src/types";

export type PredictedGateFixture = {
  id: string;
  title: string;
  branch: string;
  input: PredictedGateInput;
  manifest: FocusManifest;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  changedPaths?: string[] | undefined;
  expected: {
    conclusion: PredictedGateVerdict["conclusion"];
    pack: PredictedGateVerdict["pack"];
    blockerCodes: string[];
    warningCodes: string[];
    funnelPresent: boolean;
    noteIncludes?: string[] | undefined;
    noteExcludes?: string[] | undefined;
  };
};

export const BASE_INPUT: PredictedGateInput = {
  repoFullName: "acme/widgets",
  contributorLogin: "miner1",
  title: "Add retry to the upload client",
  body: "Closes #7",
  linkedIssues: [7],
};

export const BASE_REPO: RepositoryRecord = {
  fullName: "acme/widgets",
  owner: "acme",
  name: "widgets",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "acme/widgets",
    emissionShare: 0.1,
    issueDiscoveryShare: 0,
    labelMultipliers: {},
    maintainerCut: 0,
    raw: {},
  },
};

export function definePredictedGateFixture(fixture: PredictedGateFixture): PredictedGateFixture {
  return fixture;
}

export function parseManifest(raw: Record<string, unknown>): FocusManifest {
  return parseFocusManifest(raw);
}

export function openIssue(number: number, title: string, authorLogin: string | null = "reporter"): IssueRecord {
  return {
    repoFullName: "acme/widgets",
    number,
    title,
    state: "open",
    labels: [],
    linkedPrs: [],
    authorAssociation: null,
    authorLogin,
  };
}

export function openPr(number: number, title: string, linkedIssues: number[] = [], authorLogin = "someone"): PullRequestRecord {
  return {
    repoFullName: "acme/widgets",
    number,
    title,
    state: "open",
    authorLogin,
    linkedIssues,
    labels: [],
  };
}
