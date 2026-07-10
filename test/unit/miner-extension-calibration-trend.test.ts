import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const calibrationTrendScript = readFileSync("apps/gittensory-miner-extension/calibration-accuracy-trend.js", "utf8");
const calibrationPanelScript = readFileSync("apps/gittensory-miner-extension/calibration-trend-panel.js", "utf8");
const panelRegistryScript = readFileSync("apps/gittensory-miner-extension/panel-registry.js", "utf8");

const NOW = Date.parse("2026-07-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

type MockNode = {
  tagName: string;
  className: string;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string>;
  children: MockNode[];
  attributes: Record<string, string>;
  appendChild: (child: MockNode) => void;
  append: (...children: MockNode[]) => void;
  setAttribute: (name: string, value: string) => void;
  querySelector: (selector: string) => MockNode | null;
};

function snapshot(daysAgo: number, combinedAccuracy: number) {
  return {
    observedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    combinedAccuracy,
  };
}

function createMockNode(tagName = "DIV"): MockNode {
  const node: MockNode = {
    tagName,
    className: "",
    hidden: false,
    textContent: "",
    dataset: {},
    children: [],
    attributes: {},
    appendChild(child) {
      node.children.push(child);
      if (child.textContent) node.textContent += child.textContent;
    },
    append(...children) {
      for (const child of children) node.appendChild(child);
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    querySelector(selector) {
      const match = selector.match(/\.([^\s#]+)/);
      if (!match) return null;
      return findByClass(node, match[1]!) ?? null;
    },
  };
  return node;
}

function findByClass(node: MockNode, className: string): MockNode | null {
  if (node.className.includes(className) || node.attributes.class === className) return node;
  for (const child of node.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function loadCalibrationInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    document: {
      createElement: () => createMockNode(),
      createElementNS: (_ns: string, tag: string) => createMockNode(tag.toUpperCase()),
    },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(calibrationTrendScript).runInContext(vmContext);
  new Script(calibrationPanelScript).runInContext(vmContext);
  new Script(panelRegistryScript).runInContext(vmContext);
  return {
    trend: vmContext.__gittensoryMinerCalibrationAccuracyTrendInternals as {
      buildCalibrationAccuracyTrendView: (snapshots: unknown[], options?: { nowMs?: number }) => {
        trendDirection: string;
        status: string;
      };
    },
    panel: vmContext.__gittensoryMinerCalibrationTrendInternals as {
      buildSparklinePath: (values: number[]) => { linePath: string; areaPath: string };
      renderCalibrationTrendPanel: (container: MockNode, view: unknown) => void;
      projectCalibrationTrendFromSnapshots: (snapshots: unknown[], options?: { nowMs?: number }) => { status: string };
    },
    registry: vmContext.__gittensoryMinerPanelRegistryInternals as {
      registerMinerExtensionPanel: (registration: unknown) => void;
      mountMinerExtensionPanels: (container: MockNode, context: unknown) => Promise<void>;
    },
  };
}

describe("miner extension calibration trend (#4268)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the same improving/degrading trend semantics as the engine module", () => {
    const { trend, panel } = loadCalibrationInternals();
    const improving = trend.buildCalibrationAccuracyTrendView([snapshot(8, 0.58), snapshot(1, 0.72)], { nowMs: NOW });
    const degrading = trend.buildCalibrationAccuracyTrendView([snapshot(8, 0.75), snapshot(1, 0.55)], { nowMs: NOW });
    expect(improving.trendDirection).toBe("improving");
    expect(degrading.trendDirection).toBe("degrading");
    expect(panel.projectCalibrationTrendFromSnapshots([snapshot(8, 0.58), snapshot(1, 0.72)], { nowMs: NOW }).status).toBe(
      "ready",
    );
  });

  it("builds sparkline geometry for empty and multi-point series", () => {
    const { panel } = loadCalibrationInternals();
    expect(panel.buildSparklinePath([]).linePath).toBe("");
    const multi = panel.buildSparklinePath([58, 64, 72]);
    expect(multi.linePath.startsWith("M ")).toBe(true);
    expect(multi.areaPath).toContain("Z");
  });

  it("renders empty and populated read-only panels without controls", () => {
    const { trend, panel } = loadCalibrationInternals();
    const container = createMockNode("SECTION");

    panel.renderCalibrationTrendPanel(container, trend.buildCalibrationAccuracyTrendView([], { nowMs: NOW }));
    expect(container.querySelector(".gittensory-miner-calibration-trend__empty")?.textContent).toContain(
      "Run the calibration loop",
    );

    panel.renderCalibrationTrendPanel(
      container,
      trend.buildCalibrationAccuracyTrendView([snapshot(8, 0.58), snapshot(1, 0.72)], { nowMs: NOW }),
    );
    expect(container.querySelector(".gittensory-miner-calibration-trend__sparkline")).not.toBeNull();
  });

  it("registers and mounts contributor panels through the Phase 6 registry", async () => {
    const { registry } = loadCalibrationInternals();
    const host = createMockNode();
    const mounted: string[] = [];

    registry.registerMinerExtensionPanel({
      id: "test-panel",
      matches: (context: { watched?: boolean }) => context.watched === true,
      async mount(container: MockNode) {
        mounted.push("mounted");
        const node = createMockNode("P");
        node.textContent = "panel";
        container.appendChild(node);
      },
    });

    await registry.mountMinerExtensionPanels(host, { kind: "issue", watched: false, repoFullName: "a/b", issueNumber: 1 });
    expect(mounted).toEqual([]);

    await registry.mountMinerExtensionPanels(host, { kind: "issue", watched: true, repoFullName: "a/b", issueNumber: 1 });
    expect(mounted).toEqual(["mounted"]);
    expect(host.textContent).toContain("panel");
  });

  it("rejects invalid panel registrations", () => {
    const { registry } = loadCalibrationInternals();
    expect(() => registry.registerMinerExtensionPanel({ id: "bad" })).toThrow("invalid_miner_extension_panel");
  });
});
