import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDashboards } from "../../scripts/validate-observability-configs.mjs";

// #5189: cross-link the AMS miner-usage dashboard from the resource hub, the same way the hub already
// cross-links its other integrated dashboards -- additive only, inside the EXISTING "Observability & dashboards"
// markdown panel (panel 2), matching that panel's own established `- **[Title](/d/uid)** — note.` bullet style.
// Not a new panel/panel-type: the hub's own pattern for "another dashboard exists" is a markdown bullet, not a
// dashboard-link widget (that convention is used for grafana.com dashboard tags, which doesn't apply here).

type TextPanel = { id: number; type: string; title: string; options?: { mode?: string; content?: string } };
type Dashboard = { uid: string; title: string; panels: TextPanel[] };

const hubPath = join(process.cwd(), "grafana/dashboards/resource-hub.json");
const minerUsagePath = join(process.cwd(), "grafana/dashboards/miner-usage.json");

function readHub(): Dashboard {
  return JSON.parse(readFileSync(hubPath, "utf8")) as Dashboard;
}

function dashboardsPanel(hub = readHub()): TextPanel {
  const panel = hub.panels.find((p) => p.title === "Observability & dashboards");
  if (!panel) throw new Error('panel "Observability & dashboards" not found');
  return panel;
}

describe("LoopOver — Resource hub: AMS/miner-usage cross-link (#5189)", () => {
  it("passes the repo's own dashboard-JSON structural validator", () => {
    expect(validateDashboards("grafana/dashboards")).toEqual([]);
  });

  it("adds exactly one new bullet to the existing 'Observability & dashboards' panel -- no new panel, no panel-type change", () => {
    const hub = readHub();
    expect(hub.panels).toHaveLength(2);
    expect(hub.panels.map((p) => p.type)).toEqual(["text", "text"]);
    expect(hub.panels.map((p) => p.title)).toEqual(["Integrated services", "Observability & dashboards"]);
  });

  it("does not modify the 'Integrated services' panel at all (additive-only change, req 5)", () => {
    const integrated = readHub().panels.find((p) => p.title === "Integrated services");
    expect(integrated?.options?.content).not.toMatch(/miner|AMS|gittensory-miner/i);
  });

  it("the new bullet references miner-usage.json by its real uid -- a typo'd path can't silently ship as a dead link", () => {
    const content = dashboardsPanel().options?.content ?? "";
    const linkMatch = content.match(/\[Miner usage \(AMS\)\]\((\/d\/[a-z0-9-]+)\)/);
    expect(linkMatch, "expected a '[Miner usage (AMS)](/d/<uid>)' bullet").not.toBeNull();
    const linkedUid = linkMatch![1]!.replace("/d/", "");

    const minerUsageDashboard = JSON.parse(readFileSync(minerUsagePath, "utf8")) as { uid: string };
    expect(linkedUid).toBe(minerUsageDashboard.uid);
    expect(minerUsageDashboard.uid).toBe("loopover-miner-usage");
  });

  it("includes a brief AMS-is-a-separate-local-CLI note, matching the panel's own bullet tone/length", () => {
    const content = dashboardsPanel().options?.content ?? "";
    const bulletLine = content.split("\n").find((line) => line.includes("Miner usage (AMS)"));
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("separate local CLI");
    expect(bulletLine).toContain("gittensory-miner");
    // Context, not a full feature description: short, like every sibling bullet in this panel.
    expect(bulletLine!.length).toBeLessThan(320);
  });

  it("the new bullet sits with its dashboard-linking siblings (immediately after AI usage, before the infra dashboards), not appended out of place", () => {
    const content = dashboardsPanel().options?.content ?? "";
    const lines = content.split("\n").filter((line) => line.startsWith("- **["));
    const titles = lines.map((line) => line.match(/\[([^\]]+)\]/)?.[1]);
    const aiUsageIndex = titles.indexOf("AI usage");
    const minerUsageIndex = titles.indexOf("Miner usage (AMS)");
    expect(aiUsageIndex).toBeGreaterThan(-1);
    expect(minerUsageIndex).toBe(aiUsageIndex + 1);
  });
});
