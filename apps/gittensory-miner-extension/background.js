const PING_MESSAGE = "gittensory-miner:ping";
const ISSUE_CONTEXT_MESSAGE = "gittensory-miner:issue-context";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === PING_MESSAGE) {
    sendResponse({ ok: true, payload: { ready: true } });
    return false;
  }
  if (message.type === ISSUE_CONTEXT_MESSAGE) {
    const task = loadIssueContextShell(message);
    void task.then((payload) => sendResponse({ ok: true, payload })).catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  return false;
});

async function loadIssueContextShell(message) {
  const settings = await loadMinerExtensionSettings();
  const repoFullName = `${message.owner}/${message.repo}`;
  const watched = settings.watchedRepos.includes(repoFullName);
  return {
    watched,
    issueNumber: message.issueNumber,
    repoFullName,
    badge: null,
    status: watched ? "shell-ready" : "repo-not-watched",
  };
}

async function loadMinerExtensionSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [] });
  const watchedRepos = Array.isArray(stored.watchedRepos)
    ? stored.watchedRepos.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return { watchedRepos };
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerBackgroundInternals = {
    PING_MESSAGE,
    ISSUE_CONTEXT_MESSAGE,
    loadIssueContextShell,
    loadMinerExtensionSettings,
  };
}
