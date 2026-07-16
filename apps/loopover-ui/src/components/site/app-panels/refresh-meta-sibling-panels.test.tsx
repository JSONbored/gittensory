import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useApiResource, useSession } = vi.hoisted(() => ({
  useApiResource: vi.fn(),
  useSession: vi.fn(),
}));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));
vi.mock("@/components/site/mcp-version-badge", () => ({
  McpVersionBadge: () => <span>mcp</span>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode; to?: string }) => (
    <a href={props.to ?? "#"}>{children}</a>
  ),
}));

import { DigestPanel } from "@/components/site/app-panels/digest-panel";
import { MinerPanel } from "@/components/site/app-panels/miner-panel";
import { OwnerPanel } from "@/components/site/app-panels/owner-panel";
import type { RegistrationReadinessPayload } from "@/lib/registration-workspace";

function readyRegistrationFixture(): RegistrationReadinessPayload {
  return {
    repoFullName: "entrius/gittensor",
    generatedAt: "2026-07-16T00:00:00.000Z",
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
      note: "LoopOver validates public repo docs locally; remote crawl is not enabled yet.",
    },
    dataQuality: { status: "complete", partial: false, warnings: [] },
  };
}

describe("RefreshMeta adoption on sibling panels (#6181)", () => {
  it("DigestPanel renders RefreshMeta when digest data is ready", () => {
    const reload = vi.fn();
    useApiResource.mockReturnValue({
      status: "ready",
      data: {
        date: "2026-07-16",
        signal: "ready",
        items: [{ kind: "summary", title: "Quiet day", detail: "No open review work." }],
        subscriptions: [],
        delivery: { mode: "store_only", emailDeliveryEnabled: false },
      },
      error: null,
      loadedAt: Date.now() - 60_000,
      reload,
    });
    render(<DigestPanel />);
    expect(screen.getByText(/last refresh/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("MinerPanel renders RefreshMeta when dashboard data is ready", () => {
    const reload = vi.fn();
    useSession.mockReturnValue({
      session: { login: "miner", roles: ["miner"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "ready",
      data: {
        status: "ready",
        login: "miner",
        nextActions: [{ actionKind: "open_pr", rationale: "Ship the fix.", repoFullName: "acme/widgets" }],
        blockers: [],
        projections: [],
        repoFit: [],
      },
      error: null,
      loadedAt: Date.now() - 120_000,
      reload,
    });
    render(<MinerPanel />);
    expect(screen.getByText(/last refresh/i)).toBeTruthy();
    // MinerPanelActions also has a rebuild "Refresh"; RefreshMeta's button is still labeled Refresh.
    const refreshButtons = screen.getAllByRole("button", { name: /^Refresh$/i });
    expect(refreshButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(refreshButtons[refreshButtons.length - 1]!);
    expect(reload).toHaveBeenCalled();
  });

  it("OwnerPanel renders RefreshMeta when registration workspace is ready", () => {
    const reload = vi.fn();
    useApiResource.mockImplementation((_path: string, label: string) => {
      if (label === "Registration readiness") {
        return {
          status: "ready",
          data: readyRegistrationFixture(),
          error: null,
          loadedAt: Date.now() - 30_000,
          reload,
        };
      }
      return {
        status: "ready",
        data: null,
        error: null,
        loadedAt: Date.now() - 30_000,
        reload: vi.fn(),
      };
    });

    render(<OwnerPanel />);
    expect(screen.getByText(/last refresh/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/i }));
    expect(reload).toHaveBeenCalled();
  });
});
