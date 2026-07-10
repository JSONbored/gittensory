import "./opportunity-badge.js";
import "./calibration-accuracy-trend.js";
import "./calibration-trend-panel.js";

const badgeApi = globalThis.__gittensoryMinerOpportunityBadge;
const minerCalibrationTrendApi = globalThis.__gittensoryMinerCalibrationAccuracyTrend;
const minerCalibrationTrendPanelApi = globalThis.__gittensoryMinerCalibrationTrendPanel;

const PING_MESSAGE = "gittensory-miner:ping";
const ISSUE_CONTEXT_MESSAGE = "gittensory-miner:issue-context";
const CALIBRATION_TREND_MESSAGE = "gittensory-miner:calibration-trend";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === PING_MESSAGE) {
    sendResponse({ ok: true, payload: { ready: true } });
    return false;
  }
  if (message.type === ISSUE_CONTEXT_MESSAGE) {
    const task = loadIssueOpportunityContext(message);
    void task.then((payload) => sendResponse({ ok: true, payload })).catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type === CALIBRATION_TREND_MESSAGE) {
    const task = loadCalibrationTrendView(message);
    void task.then((payload) => sendResponse({ ok: true, payload })).catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  return false;
});

async function loadIssueOpportunityContext(message) {
  const settings = await loadMinerExtensionSettings();
  const repoFullName = `${message.owner}/${message.repo}`;
  const watched = settings.watchedRepos.some(
    (repo) => repo.trim().toLowerCase() === repoFullName.toLowerCase(),
  );
  if (!watched) {
    return {
      watched: false,
      issueNumber: message.issueNumber,
      repoFullName,
      badge: null,
      status: "repo-not-watched",
    };
  }

  const rankedCandidates = await loadRankedCandidates();
  const rankedEntry = badgeApi.lookupRankedOpportunity(rankedCandidates, repoFullName, message.issueNumber);
  if (!rankedEntry) {
    return {
      watched: true,
      issueNumber: message.issueNumber,
      repoFullName,
      badge: null,
      status: "no-signal",
    };
  }

  return {
    watched: true,
    issueNumber: message.issueNumber,
    repoFullName,
    badge: badgeApi.formatOpportunityBadge(rankedEntry),
    status: "ready",
  };
}

async function loadCalibrationTrendView(_message) {
  const storageKey = minerCalibrationTrendPanelApi.CALIBRATION_SNAPSHOTS_STORAGE_KEY;
  const stored = await chrome.storage.local.get({ [storageKey]: [] });
  const snapshots = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
  const view = minerCalibrationTrendApi.buildCalibrationAccuracyTrendView(snapshots);
  return { view, readOnly: true };
}

async function loadMinerExtensionSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [], discoveryIndexUrl: "" });
  const watchedRepos = Array.isArray(stored.watchedRepos)
    ? stored.watchedRepos.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const discoveryIndexUrl =
    typeof stored.discoveryIndexUrl === "string" ? stored.discoveryIndexUrl.trim() : "";
  return { watchedRepos, discoveryIndexUrl };
}

async function loadRankedCandidates() {
  const stored = await chrome.storage.local.get({ rankedCandidates: [] });
  return Array.isArray(stored.rankedCandidates) ? stored.rankedCandidates : [];
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerBackgroundInternals = {
    PING_MESSAGE,
    ISSUE_CONTEXT_MESSAGE,
    CALIBRATION_TREND_MESSAGE,
    loadIssueOpportunityContext,
    loadCalibrationTrendView,
    loadMinerExtensionSettings,
    loadRankedCandidates,
    CALIBRATION_SNAPSHOTS_STORAGE_KEY: minerCalibrationTrendPanelApi.CALIBRATION_SNAPSHOTS_STORAGE_KEY,
  };
}
