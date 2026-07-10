const minerPanels = [];

function registerMinerExtensionPanel(registration) {
  if (!registration || typeof registration.id !== "string" || typeof registration.mount !== "function") {
    throw new Error("invalid_miner_extension_panel");
  }
  minerPanels.push(registration);
}

function listMinerExtensionPanels() {
  return [...minerPanels];
}

async function mountMinerExtensionPanels(container, context) {
  for (const panel of minerPanels) {
    if (typeof panel.matches === "function" && !panel.matches(context)) continue;
    await panel.mount(container, context);
  }
}

const panelRegistryApi = {
  registerMinerExtensionPanel,
  listMinerExtensionPanels,
  mountMinerExtensionPanels,
};

globalThis.__gittensoryMinerPanelRegistry = panelRegistryApi;

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerPanelRegistryInternals = panelRegistryApi;
}
