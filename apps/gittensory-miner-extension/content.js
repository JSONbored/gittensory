const target = matchGitHubIssueTarget(location.pathname);

if (target?.kind === "issue") {
  mountIssueShell(target);
}

function matchGitHubIssueTarget(pathname) {
  const match = String(pathname ?? "").match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { kind: "issue", owner, repo, issueNumber: Number(number) };
}

function mountIssueShell(target) {
  if (document.querySelector("[data-gittensory-miner-issue-shell]")) return;
  const container = document.createElement("aside");
  container.className = "gittensory-miner-issue-shell";
  container.dataset.gittensoryMinerIssueShell = "true";
  container.hidden = true;
  document.body.appendChild(container);
  void loadIssueShell(container, target);
}

async function loadIssueShell(container, target) {
  const response = await chrome.runtime.sendMessage({
    type: "gittensory-miner:issue-context",
    owner: target.owner,
    repo: target.repo,
    issueNumber: target.issueNumber,
  });
  if (!response?.ok) {
    container.hidden = true;
    return;
  }
  renderIssueShell(container, response.payload);
}

function renderIssueShell(container, payload) {
  if (!payload?.watched) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.textContent = "";
  const label = document.createElement("span");
  label.className = "gittensory-miner-issue-shell__label";
  label.textContent = "Gittensory miner opportunity shell";
  container.appendChild(label);
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerContentInternals = {
    matchGitHubIssueTarget,
    renderIssueShell,
  };
}
