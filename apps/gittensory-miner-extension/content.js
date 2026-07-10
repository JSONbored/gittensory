const badgeApi = globalThis.__gittensoryMinerOpportunityBadge;
const panelRegistry = globalThis.__gittensoryMinerPanelRegistry;
const trendPanel = globalThis.__gittensoryMinerCalibrationTrendPanel;

const CALIBRATION_TREND_MESSAGE = "gittensory-miner:calibration-trend";

registerCalibrationTrendPanel();

const target = matchGitHubIssueTarget(location.pathname);

if (target?.kind === "issue") {
  mountOpportunityBadge(target);
  mountIssuePanels(target);
}

function registerCalibrationTrendPanel() {
  panelRegistry.registerMinerExtensionPanel({
    id: "calibration-accuracy-trend",
    matches: (context) => context.kind === "issue" && context.watched === true,
    async mount(container, context) {
      const panel = document.createElement("section");
      panel.className = "gittensory-miner-calibration-trend";
      container.appendChild(panel);
      const response = await chrome.runtime.sendMessage({
        type: CALIBRATION_TREND_MESSAGE,
        repoFullName: context.repoFullName,
      });
      if (!response?.ok || !response.payload?.view) {
        panel.hidden = true;
        return;
      }
      trendPanel.renderCalibrationTrendPanel(panel, response.payload.view);
    },
  });
}

function matchGitHubIssueTarget(pathname) {
  const match = String(pathname ?? "").match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { kind: "issue", owner, repo, issueNumber: Number(number) };
}

function mountOpportunityBadge(target) {
  if (document.querySelector("[data-gittensory-miner-opportunity-badge]")) return;
  const host = findIssueSidebar();
  const container = document.createElement("aside");
  container.className = host
    ? "gittensory-miner-opportunity-badge"
    : "gittensory-miner-opportunity-badge gittensory-miner-opportunity-badge--floating";
  container.dataset.gittensoryMinerOpportunityBadge = "true";
  container.hidden = true;
  if (host) {
    host.prepend(container);
  } else {
    document.body.appendChild(container);
  }
  void loadOpportunityBadge(container, target);
}

function mountIssuePanels(target) {
  if (document.querySelector("[data-gittensory-miner-issue-panels]")) return;
  const host = findIssueSidebar();
  const container = document.createElement("aside");
  container.className = host
    ? "gittensory-miner-issue-panels"
    : "gittensory-miner-issue-panels gittensory-miner-issue-panels--floating";
  container.dataset.gittensoryMinerIssuePanels = "true";
  container.hidden = true;
  if (host) {
    host.prepend(container);
  } else {
    document.body.appendChild(container);
  }
  void loadIssuePanels(container, target);
}

function findIssueSidebar() {
  return (
    document.querySelector("#partial-discussion-sidebar") ||
    document.querySelector("[data-testid='issue-sidebar']") ||
    document.querySelector(".Layout-sidebar") ||
    document.querySelector(".discussion-sidebar")
  );
}

async function loadOpportunityBadge(container, target) {
  const response = await chrome.runtime.sendMessage({
    type: "gittensory-miner:issue-context",
    owner: target.owner,
    repo: target.repo,
    issueNumber: target.issueNumber,
  });
  if (!response?.ok) {
    container.remove();
    return;
  }
  renderOpportunityBadge(container, response.payload);
}

async function loadIssuePanels(container, target) {
  const response = await chrome.runtime.sendMessage({
    type: "gittensory-miner:issue-context",
    owner: target.owner,
    repo: target.repo,
    issueNumber: target.issueNumber,
  });
  if (!response?.ok || !response.payload?.watched) {
    container.remove();
    return;
  }
  container.hidden = false;
  container.textContent = "";
  const panels = document.createElement("div");
  panels.className = "gittensory-miner-issue-panels__mount";
  container.appendChild(panels);
  await panelRegistry.mountMinerExtensionPanels(panels, {
    kind: "issue",
    watched: response.payload.watched,
    repoFullName: response.payload.repoFullName,
    issueNumber: response.payload.issueNumber,
  });
}

function renderOpportunityBadge(container, payload) {
  if (!payload?.watched || !payload?.badge) {
    container.remove();
    return;
  }
  const markup = badgeApi?.renderOpportunityBadgeMarkup?.(payload.badge);
  if (!markup) {
    container.remove();
    return;
  }
  container.hidden = false;
  container.innerHTML = markup;
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerContentInternals = {
    matchGitHubIssueTarget,
    findIssueSidebar,
    renderOpportunityBadge,
    registerCalibrationTrendPanel,
    CALIBRATION_TREND_MESSAGE,
  };
}
