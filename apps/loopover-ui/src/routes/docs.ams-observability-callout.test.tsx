import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AMS_OBSERVABILITY_DOC_URL,
  AmsObservabilityCallout,
} from "../components/site/ams-observability-callout";
import { MinerQuickstart } from "./docs.miner-quickstart";
import { MinerWorkflow } from "./docs.miner-workflow";
import { SelfHostingOperations } from "./docs.self-hosting-operations";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  };
});

vi.mock("@/components/site/docs-page", () => ({
  DocsPage: ({ children, title }: { children: ReactNode; title: string }) => (
    <div data-testid="docs-page">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@/components/site/primitives", () => ({
  Callout: ({ children, title }: { children: ReactNode; title?: string }) => (
    <section data-testid="callout">
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </section>
  ),
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  FeatureRow: ({ items }: { items: Array<{ title: string; description: string }> }) => (
    <dl>
      {items.map((item) => (
        <div key={item.title}>
          <dt>{item.title}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  ),
}));

vi.mock("@/components/site/workflow-mirror", () => ({
  WorkflowMirror: () => <div data-testid="workflow-mirror" />,
}));

// Every route that embeds the shared callout, so a new route add/remove can't silently skip one (#5191).
const ROUTES_WITH_CALLOUT: ReadonlyArray<[string, () => ReactNode]> = [
  ["/docs/self-hosting-operations", SelfHostingOperations],
  ["/docs/miner-quickstart", MinerQuickstart],
  ["/docs/miner-workflow", MinerWorkflow],
];

describe("AMS observability cross-reference callout", () => {
  it("renders a link to the Observing your miner guide", () => {
    render(<AmsObservabilityCallout />);
    const link = screen.getByRole("link", { name: "Observing your miner" });
    expect(link.getAttribute("href")).toBe(AMS_OBSERVABILITY_DOC_URL);
  });

  it("targets a well-formed, non-empty absolute https URL (guards against a blank/copy-paste link)", () => {
    expect(AMS_OBSERVABILITY_DOC_URL).toBeTruthy();
    const url = new URL(AMS_OBSERVABILITY_DOC_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("github.com");
  });

  it.each(ROUTES_WITH_CALLOUT)("wires the callout into %s", (_path, RouteComponent) => {
    const { container } = render(<RouteComponent />);
    const link = container.querySelector(`a[href="${AMS_OBSERVABILITY_DOC_URL}"]`);
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Observing your miner");
  });
});
