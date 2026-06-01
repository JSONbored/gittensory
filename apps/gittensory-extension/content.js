import { parseGitHubPageTarget } from "./github-target.js";
import { renderOverlayPanels } from "./overlay-safety.js";

const target = parseGitHubPageTarget(location.pathname);
if (target?.kind === "pull") {
  mountPullOverlay(target);
} else if (target?.kind === "issue") {
  mountIssueNotice(target);
}

function mountPullOverlay(target) {
  const container = createOverlayShell("Refresh Gittensory context");
  document.body.appendChild(container);
  const refresh = container.querySelector(".gittensory-overlay__refresh");
  refresh?.addEventListener("click", () => loadPullContext(container, target));
  void loadPullContext(container, target);
}

function mountIssueNotice(target) {
  const container = createOverlayShell("Open related pull request");
  const body = container.querySelector(".gittensory-overlay__body");
  if (!body) return;
  body.innerHTML = `
    <section class="gittensory-overlay__panel">
      <div class="gittensory-overlay__panel-head">
        <strong>Issue page</strong>
        <span>scaffold</span>
      </div>
      <p class="gittensory-overlay__notice">
        Gittensory pull context is available on pull request pages for
        <code>${escapeInline(target.owner)}/${escapeInline(target.repo)}</code>
        issue #${target.issueNumber}. Open a linked pull request to load private reviewability context from the API.
      </p>
    </section>
  `;
  document.body.appendChild(container);
}

function createOverlayShell(refreshLabel) {
  const container = document.createElement("aside");
  container.className = "gittensory-overlay";
  container.innerHTML = `
    <div class="gittensory-overlay__header">
      <span class="gittensory-overlay__mark">G</span>
      <span>Gittensory</span>
      <button type="button" class="gittensory-overlay__refresh" aria-label="${refreshLabel}">Refresh</button>
    </div>
    <div class="gittensory-overlay__body">Loading private context...</div>
  `;
  return container;
}

async function loadPullContext(container, target) {
  const body = container.querySelector(".gittensory-overlay__body");
  if (!body) return;
  body.textContent = "Loading private context...";
  const response = await chrome.runtime.sendMessage({ type: "gittensory:pull-context", ...target });
  if (!response?.ok) {
    body.innerHTML = `<div class="gittensory-overlay__error">${escapeInline(response?.error || "Context unavailable")}</div>`;
    return;
  }
  body.innerHTML = renderOverlayPanels(response.payload?.panels);
}

function escapeInline(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderActions(body, actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0) return;
  const container = document.createElement("section");
  container.className = "gittensory-overlay__panel";
  container.innerHTML = `
    <div class="gittensory-overlay__panel-head">
      <strong>Actions</strong>
      <span>extension</span>
    </div>
    <div class="gittensory-overlay__actions"></div>
  `;
  const actionsNode = container.querySelector(".gittensory-overlay__actions");
  if (!actionsNode) return;
  for (const action of list) {
    if (action?.id === "copy_public_safe_packet" && typeof action?.markdown === "string") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Copy public-safe packet";
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(action.markdown);
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.textContent = "Copy public-safe packet";
          }, 1400);
        } catch {
          button.textContent = "Copy failed";
        }
      });
      actionsNode.appendChild(button);
      continue;
    }
    if (action?.id === "view_private_blockers" && Array.isArray(action?.blockers)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Private blockers";
      details.appendChild(summary);
      const listNode = document.createElement("ul");
      for (const blocker of action.blockers.slice(0, 8)) {
        const item = document.createElement("li");
        item.textContent = String(blocker?.detail ?? "");
        listNode.appendChild(item);
      }
      details.appendChild(listNode);
      actionsNode.appendChild(details);
    }
  }
  body.appendChild(container);
}
