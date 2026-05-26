<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import mcpPackage from "../../../../packages/gittensory-mcp/package.json";

const props = defineProps<{
  placement?: "nav" | "footer";
}>();

type NpmRegistryPackage = {
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, unknown>;
};

type VersionEntry = {
  version: string;
  publishedAt?: string;
  npmUrl: string;
};

const packageName = "@jsonbored/gittensory-mcp";
const encodedPackageName = "@jsonbored%2fgittensory-mcp";
const fallbackVersion = mcpPackage.version;
const registryUrl = `https://registry.npmjs.org/${encodedPackageName}`;
const packageUrl = `https://www.npmjs.com/package/${packageName}`;
const changelogUrl = "https://github.com/JSONbored/gittensory/blob/main/packages/gittensory-mcp/CHANGELOG.md";
const storageKey = "gittensory:mcp-version:seen";
const recentWindowMs = 7 * 24 * 60 * 60 * 1000;

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const failed = ref(false);
const seenVersion = ref("");
const latestVersion = ref(fallbackVersion);
const versions = ref<VersionEntry[]>([
  {
    version: fallbackVersion,
    npmUrl: `${packageUrl}/v/${fallbackVersion}`,
  },
]);

const latestEntry = computed(() => versions.value.find((entry) => entry.version === latestVersion.value) ?? versions.value[0]);
const latestPublishedAt = computed(() => latestEntry.value?.publishedAt);
const latestNpmUrl = computed(() => `${packageUrl}/v/${latestVersion.value}`);
const showNewBadge = computed(() => {
  if (seenVersion.value && seenVersion.value !== latestVersion.value) return true;
  if (latestVersion.value !== fallbackVersion) return true;
  if (!latestPublishedAt.value) return false;
  const publishedAt = Date.parse(latestPublishedAt.value);
  return Number.isFinite(publishedAt) && Date.now() - publishedAt < recentWindowMs;
});

onMounted(async () => {
  seenVersion.value = readSeenVersion();
  document.addEventListener("click", closeFromDocument);
  document.addEventListener("keydown", closeFromEscape);

  try {
    const response = await fetch(registryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const payload = (await response.json()) as NpmRegistryPackage;
    const latest = payload["dist-tags"]?.latest;
    const nextVersions = Object.keys(payload.versions ?? {})
      .filter(isStableVersion)
      .sort(compareVersionsDesc)
      .slice(0, 5);

    if (latest && isStableVersion(latest)) latestVersion.value = latest;
    if (nextVersions.length > 0) {
      versions.value = nextVersions.map((version) => ({
        version,
        publishedAt: payload.time?.[version],
        npmUrl: `${packageUrl}/v/${version}`,
      }));
    }
  } catch {
    failed.value = true;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("click", closeFromDocument);
  document.removeEventListener("keydown", closeFromEscape);
});

function toggleOpen() {
  open.value = !open.value;
  if (open.value) markSeen();
}

function markSeen() {
  seenVersion.value = latestVersion.value;
  try {
    localStorage.setItem(storageKey, latestVersion.value);
  } catch {
    // Ignore storage failures; the badge is only a convenience hint.
  }
}

function readSeenVersion(): string {
  try {
    return localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function closeFromDocument(event: MouseEvent) {
  if (!open.value || root.value?.contains(event.target as Node)) return;
  open.value = false;
}

function closeFromEscape(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function compareVersionsDesc(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function formatDate(value?: string): string {
  if (!value) return "date unknown";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}
</script>

<template>
  <div
    ref="root"
    class="gtn-version-pill"
    :class="{
      'gtn-version-pill--footer': props.placement === 'footer',
      'gtn-version-pill--fallback': failed,
    }"
  >
    <button
      type="button"
      class="gtn-version-pill__button"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <span>MCP</span>
      <strong>v{{ latestVersion }}</strong>
      <em v-if="showNewBadge">new</em>
    </button>

    <div v-if="open" class="gtn-version-pill__menu" role="menu">
      <div class="gtn-version-pill__menu-head">
        <span>Package releases</span>
        <a :href="latestNpmUrl">npm</a>
        <a :href="changelogUrl">changelog</a>
      </div>

      <a
        v-for="entry in versions"
        :key="entry.version"
        class="gtn-version-pill__version"
        :href="entry.npmUrl"
        role="menuitem"
      >
        <strong>v{{ entry.version }}</strong>
        <time>{{ formatDate(entry.publishedAt) }}</time>
        <span v-if="entry.version === latestVersion">latest</span>
      </a>

      <p v-if="failed" class="gtn-version-pill__note">
        Showing the docs build version because npm release metadata could not be loaded.
      </p>
    </div>
  </div>
</template>
