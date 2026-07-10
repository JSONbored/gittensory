function parseWatchedRepos(text) {
  return String(text ?? "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerOptionsInternals = {
    parseWatchedRepos,
  };
}

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const watchedRepos = document.querySelector("#watchedRepos");

if (!form || !status || !watchedRepos) {
  // options.html is not mounted (unit-test harness or partial load).
} else {
void refreshSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const repos = parseWatchedRepos(watchedRepos.value);
    await chrome.storage.sync.set({ watchedRepos: repos });
    await refreshSettings();
    showStatus(repos.length > 0 ? `Watching ${repos.length} repository(ies).` : "Cleared watched repositories.");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error));
  }
});
}

async function refreshSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [] });
  const repos = Array.isArray(stored.watchedRepos) ? stored.watchedRepos : [];
  watchedRepos.value = repos.join("\n");
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    status.textContent = "";
  }, 2600);
}
