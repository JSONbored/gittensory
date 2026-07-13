function parseWatchedRepos(text) {
  return String(text ?? "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// This extension does not request the "unlimitedStorage" permission, so chrome.storage.local is capped at its
// default 10 MiB (QUOTA_BYTES) quota shared across every key -- an unbounded paste can silently fail to save
// or leave storage in a partial state (#4863). Checked against the raw pasted text's UTF-16 length (not a
// TextEncoder byte count) so this stays a plain, portable JS check usable from an unbundled content script;
// it's a conservative proxy for the eventual serialized size, with headroom under the 10 MiB quota.
const MAX_RANKED_CANDIDATES_JSON_CHARS = 8 * 1024 * 1024;

function parseRankedCandidatesJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_RANKED_CANDIDATES_JSON_CHARS) {
    throw new Error(
      `Ranked candidates JSON is too large (${trimmed.length.toLocaleString()} characters; limit ${MAX_RANKED_CANDIDATES_JSON_CHARS.toLocaleString()}). Paste a smaller discover-run export.`,
    );
  }
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("Ranked candidates JSON must be an array.");
  }
  return parsed;
}

// #5343 dropped the discoveryIndexUrl UI field and stopped reading/writing it, but chrome.storage.sync.set
// only merges keys -- it never deletes ones an earlier extension version already synced. Without an active
// purge, a value synced before #5343 stays in the user's account indefinitely. Called from refreshSettings,
// which runs on every options-page load and again at the end of every save, so it's cleared promptly
// regardless of which path a given user hits first.
async function removeLegacyDiscoveryIndexUrl() {
  await chrome.storage.sync.remove("discoveryIndexUrl");
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerOptionsInternals = {
    parseWatchedRepos,
    parseRankedCandidatesJson,
    removeLegacyDiscoveryIndexUrl,
    MAX_RANKED_CANDIDATES_JSON_CHARS,
  };
}

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const watchedRepos = document.querySelector("#watchedRepos");
const rankedCandidatesJson = document.querySelector("#rankedCandidatesJson");

if (!form || !status || !watchedRepos || !rankedCandidatesJson) {
  // options.html is not mounted (unit-test harness or partial load).
} else {
void refreshSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const repos = parseWatchedRepos(watchedRepos.value);
    const rankedCandidates = parseRankedCandidatesJson(rankedCandidatesJson.value);
    await chrome.storage.sync.set({ watchedRepos: repos });
    await chrome.storage.local.set({ rankedCandidates, rankedCandidatesSavedAt: Date.now() });
    await refreshSettings();
    showStatus(
      rankedCandidates.length > 0
        ? `Saved ${repos.length} watched repo(s) and ${rankedCandidates.length} ranked candidate(s).`
        : `Watching ${repos.length} repository(ies).`,
    );
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error));
  }
});
}

async function refreshSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [] });
  await removeLegacyDiscoveryIndexUrl();
  const local = await chrome.storage.local.get({ rankedCandidates: [] });
  const repos = Array.isArray(stored.watchedRepos) ? stored.watchedRepos : [];
  watchedRepos.value = repos.join("\n");
  const rankedCandidates = Array.isArray(local.rankedCandidates) ? local.rankedCandidates : [];
  rankedCandidatesJson.value =
    rankedCandidates.length > 0 ? JSON.stringify(rankedCandidates, null, 2) : "";
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    status.textContent = "";
  }, 2600);
}
