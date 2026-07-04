import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertReplayTargetSnapshotValid,
  createReplayTargetSnapshot,
  renderReplayTargetSnapshotManifestMarkdown,
  validateReplayTargetSnapshot,
} from "../dist/index.js";

const FIRST = "1111111111111111111111111111111111111111";
const SECOND = "2222222222222222222222222222222222222222";
const THIRD = "3333333333333333333333333333333333333333";
const README = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PACKAGE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function baseInput() {
  return {
    repo: {
      fullName: "JSONbored/Gittensory",
      remoteUrl: "https://github.com/JSONbored/gittensory.git",
      defaultBranch: "main",
    },
    targetCommitSha: SECOND,
    exportRoot: ".gittensory/replay-targets",
    commits: [
      {
        sha: FIRST,
        committedAt: "2026-06-01T00:00:00Z",
        subject: "docs: initial readme",
        paths: ["README.md"],
      },
      {
        sha: SECOND,
        committedAt: "2026-06-02T00:00:00Z",
        subject: "feat: add miner replay harness",
        paths: ["packages/gittensory-engine/src/objective-anchor.ts", "README.md"],
        parents: [FIRST],
      },
      {
        sha: THIRD,
        committedAt: "2026-06-03T00:00:00Z",
        subject: "fix: later change",
        paths: ["src/later.ts"],
        parents: [SECOND],
      },
    ],
    tags: [
      { name: "v0.1.0", targetSha: FIRST, taggedAt: "2026-06-01T12:00:00Z" },
      { name: "v0.2.0", targetSha: SECOND, taggedAt: "2026-06-02T12:00:00Z" },
      { name: "v0.3.0", targetSha: THIRD, taggedAt: "2026-06-03T12:00:00Z" },
    ],
    releases: [
      { name: "first", tagName: "v0.1.0", publishedAt: "2026-06-01T12:30:00Z" },
      { name: "second", tagName: "v0.2.0", publishedAt: "2026-06-02T12:30:00Z" },
      { name: "third", tagName: "v0.3.0", publishedAt: "2026-06-03T12:30:00Z" },
    ],
    readme: {
      path: "README.md",
      blobSha: README,
      text: "# Gittensory\r\n\nReplay harness at T.\n",
      observedAt: "2026-06-02T00:00:00Z",
    },
    treeFiles: [
      { path: "README.md", blobSha: README, mode: "100644", size: 27, observedAt: "2026-06-02T00:00:00Z" },
      {
        path: "packages/gittensory-engine/package.json",
        blobSha: PACKAGE,
        mode: "100644",
        size: 512.9,
        observedAt: "2026-06-02T00:00:00Z",
      },
      {
        path: "src/later.ts",
        blobSha: "cccccccccccccccccccccccccccccccccccccccc",
        mode: "100644",
        size: 42,
        observedAt: "2026-06-03T00:00:00Z",
      },
    ],
    externalReferences: [
      { kind: "issue", id: 3010, observedAt: "2026-06-02T00:00:00Z" },
      { kind: "pull-request", id: 9999, observedAt: "2026-06-03T00:00:00Z" },
    ],
  } as const;
}

test("barrel: exports replay-target snapshot APIs (#3010)", () => {
  assert.equal(typeof createReplayTargetSnapshot, "function");
  assert.equal(typeof validateReplayTargetSnapshot, "function");
  assert.equal(typeof assertReplayTargetSnapshotValid, "function");
  assert.equal(typeof renderReplayTargetSnapshotManifestMarkdown, "function");
});

test("createReplayTargetSnapshot exports a commit-keyed worktree plan and knowable-at-T context", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());

  assert.equal(snapshot.repo.fullName, "jsonbored/gittensory");
  assert.equal(snapshot.repo.remoteUrl, "https://github.com/JSONbored/gittensory.git");
  assert.equal(snapshot.targetCommitSha, SECOND);
  assert.equal(snapshot.targetCommittedAt, "2026-06-02T00:00:00.000Z");
  assert.match(snapshot.snapshotId, /^jsonbored__gittensory@2222222222222222222222222222222222222222-[a-f0-9]{8}$/u);
  assert.equal(snapshot.exportPlan.strategy, "git-worktree");
  assert.equal(snapshot.exportPlan.sourceCommit, SECOND);
  assert.equal(snapshot.exportPlan.destinationKey, snapshot.snapshotId);
  assert.equal(snapshot.exportPlan.worktreePath, `.gittensory/replay-targets/${snapshot.snapshotId}/tree`);
  assert.equal(snapshot.exportPlan.contextPath, `.gittensory/replay-targets/${snapshot.snapshotId}/context.json`);
  assert.deepEqual(snapshot.context.commits.map((commit) => commit.sha), [FIRST, SECOND]);
  assert.deepEqual(snapshot.excluded.commits.map((commit) => commit.sha), [THIRD]);
});

test("createReplayTargetSnapshot includes tags and releases only at or before T", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());

  assert.deepEqual(snapshot.context.tags.map((tag) => tag.name), ["v0.1.0"]);
  assert.deepEqual(snapshot.excluded.tags.map((tag) => tag.name), ["v0.2.0", "v0.3.0"]);
  assert.deepEqual(snapshot.context.releases.map((release) => release.name), ["first"]);
  assert.deepEqual(snapshot.excluded.releases.map((release) => release.name), ["second", "third"]);
});

test("createReplayTargetSnapshot accepts undated tags when their target commit is included", () => {
  const input = {
    ...baseInput(),
    tags: [
      { name: "undated-first", targetSha: FIRST },
      { name: "undated-third", targetSha: THIRD },
      { name: "floating" },
    ],
    releases: [
      { name: "from-included-tag", tagName: "undated-first" },
      { name: "from-excluded-tag", tagName: "undated-third" },
      { name: "floating-release", tagName: "floating" },
    ],
  };
  const snapshot = createReplayTargetSnapshot(input);

  assert.deepEqual(snapshot.context.tags.map((tag) => tag.name), ["undated-first"]);
  assert.deepEqual(snapshot.excluded.tags.map((tag) => tag.name), ["floating", "undated-third"]);
  assert.deepEqual(snapshot.context.releases.map((release) => release.name), ["from-included-tag"]);
  assert.deepEqual(snapshot.excluded.releases.map((release) => release.name), [
    "floating-release",
    "from-excluded-tag",
  ]);
});

test("createReplayTargetSnapshot supports a repo with no tags or releases", () => {
  const snapshot = createReplayTargetSnapshot({
    ...baseInput(),
    tags: [],
    releases: [],
  });

  assert.deepEqual(snapshot.context.tags, []);
  assert.deepEqual(snapshot.context.releases, []);
  assert.deepEqual(snapshot.excluded.tags, []);
  assert.deepEqual(snapshot.excluded.releases, []);
  assert.equal(snapshot.validation.ok, true);
});

test("createReplayTargetSnapshot handles the first commit of history", () => {
  const snapshot = createReplayTargetSnapshot({
    ...baseInput(),
    targetCommitSha: FIRST,
  });

  assert.deepEqual(snapshot.context.commits.map((commit) => commit.sha), [FIRST]);
  assert.deepEqual(snapshot.excluded.commits.map((commit) => commit.sha), [SECOND, THIRD]);
  assert.equal(snapshot.context.history.items.length, 1);
  assert.equal(snapshot.context.history.items[0]!.id, `commit:${FIRST}`);
  assert.deepEqual(snapshot.context.history.features.paths, ["readme.md"]);
  assert.deepEqual(snapshot.context.history.features.changeKinds, ["docs"]);
});

test("createReplayTargetSnapshot normalizes README text and filters a future README", () => {
  const included = createReplayTargetSnapshot(baseInput());
  const excluded = createReplayTargetSnapshot({
    ...baseInput(),
    readme: {
      path: "./README.md",
      blobSha: README,
      text: "# Later\r\n",
      observedAt: "2026-06-03T00:00:00Z",
    },
  });

  assert.equal(included.context.readme?.text, "# Gittensory\n\nReplay harness at T.\n");
  assert.equal(included.context.readme?.path, "readme.md");
  assert.equal(excluded.context.readme, null);
  assert.equal(excluded.excluded.readme?.path, "readme.md");
});

test("createReplayTargetSnapshot filters tree files and references with post-T timestamps", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());

  assert.deepEqual(snapshot.context.treeFiles.map((file) => [file.path, file.size]), [
    ["packages/gittensory-engine/package.json", 512],
    ["readme.md", 27],
  ]);
  assert.deepEqual(snapshot.excluded.treeFiles.map((file) => file.path), ["src/later.ts"]);
  assert.deepEqual(snapshot.context.externalReferences, [
    { kind: "issue", id: "3010", observedAt: "2026-06-02T00:00:00.000Z" },
  ]);
  assert.deepEqual(snapshot.excluded.externalReferences, [
    { kind: "pull_request", id: "9999", observedAt: "2026-06-03T00:00:00.000Z" },
  ]);
});

test("createReplayTargetSnapshot derives objective-anchor history from included commits", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());

  assert.deepEqual(
    snapshot.context.history.items.map((item) => [item.id, item.source]),
    [
      [`commit:${FIRST}`, "commit"],
      [`commit:${SECOND}`, "commit"],
    ],
  );
  assert.deepEqual(snapshot.context.history.features.modules, [
    "packages/gittensory-engine",
    "readme.md",
  ]);
  assert.deepEqual(snapshot.context.history.features.changeKinds, ["feature", "docs"]);
});

test("createReplayTargetSnapshot is byte-stable for the same input", () => {
  const left = createReplayTargetSnapshot(baseInput());
  const right = createReplayTargetSnapshot(baseInput());

  assert.equal(left.snapshotId, right.snapshotId);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test("createReplayTargetSnapshot changes the snapshot id when context changes", () => {
  const left = createReplayTargetSnapshot(baseInput());
  const right = createReplayTargetSnapshot({
    ...baseInput(),
    treeFiles: [
      ...(baseInput().treeFiles ?? []),
      {
        path: "packages/gittensory-engine/src/replay-target-snapshot.ts",
        blobSha: "dddddddddddddddddddddddddddddddddddddddd",
        observedAt: "2026-06-02T00:00:00Z",
      },
    ],
  });

  assert.notEqual(left.snapshotId, right.snapshotId);
});

test("validateReplayTargetSnapshot detects a post-target commit inserted after creation", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());
  const invalid = {
    ...snapshot,
    context: {
      ...snapshot.context,
      commits: [
        ...snapshot.context.commits,
        {
          sha: THIRD,
          committedAt: "2026-06-03T00:00:00.000Z",
          subject: "fix: post target",
          paths: ["src/later.ts"],
          parents: [SECOND],
        },
      ],
    },
  };
  const validation = validateReplayTargetSnapshot(invalid);

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.violations, [
    {
      artifact: `commit:${THIRD}`,
      timestamp: "2026-06-03T00:00:00.000Z",
      targetCommittedAt: "2026-06-02T00:00:00.000Z",
      reason: "post_target_timestamp",
    },
  ]);
  assert.throws(() => assertReplayTargetSnapshotValid(invalid), /post-target or incomplete artifacts/u);
});

test("validateReplayTargetSnapshot detects missing target commit", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());
  const invalid = {
    ...snapshot,
    context: {
      ...snapshot.context,
      commits: snapshot.context.commits.filter((commit) => commit.sha !== SECOND),
    },
  };
  const validation = validateReplayTargetSnapshot(invalid);

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.violations, [
    {
      artifact: `commit:${SECOND}`,
      timestamp: "2026-06-02T00:00:00.000Z",
      targetCommittedAt: "2026-06-02T00:00:00.000Z",
      reason: "missing_target_commit",
    },
  ]);
});

test("validateReplayTargetSnapshot checks every timestamp-bearing artifact", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());
  const invalid = {
    ...snapshot,
    context: {
      ...snapshot.context,
      tags: [{ name: "bad-tag", targetSha: SECOND, taggedAt: "2026-06-03T00:00:00.000Z" }],
      releases: [{ name: "bad-release", tagName: "bad-tag", publishedAt: "2026-06-03T01:00:00.000Z" }],
      readme: { path: "readme.md", blobSha: README, text: null, observedAt: "2026-06-03T02:00:00.000Z" },
      treeFiles: [{ path: "readme.md", blobSha: README, mode: null, size: null, observedAt: "2026-06-03T03:00:00.000Z" }],
      externalReferences: [{ kind: "issue", id: "99", observedAt: "2026-06-03T04:00:00.000Z" }],
    },
  };
  const validation = validateReplayTargetSnapshot(invalid);

  assert.equal(validation.ok, false);
  assert.deepEqual(
    validation.violations.map((violation) => violation.artifact),
    ["tag:bad-tag", "release:bad-release", "readme:readme.md", "tree:readme.md", "issue:99"],
  );
});

test("renderReplayTargetSnapshotManifestMarkdown renders included and excluded context", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());
  const markdown = renderReplayTargetSnapshotManifestMarkdown(snapshot);

  assert.ok(markdown.startsWith("# Replay Target Snapshot\n\nSnapshot: jsonbored\\_\\_gittensory@"));
  assert.match(markdown, /Repo: jsonbored\/gittensory/u);
  assert.match(markdown, /Target commit: 2222222222222222222222222222222222222222/u);
  assert.match(markdown, /## Export Plan\n\n- strategy: git-worktree/u);
  assert.match(markdown, /Commits:\n- 111111111111 2026-06-01T00:00:00\.000Z docs: initial readme/u);
  assert.match(markdown, /- 222222222222 2026-06-02T00:00:00\.000Z feat: add miner replay harness/u);
  assert.match(markdown, /Tags:\n- v0\.1\.0 -\\> 111111111111/u);
  assert.match(markdown, /Releases:\n- first \(v0\.1\.0\)/u);
  assert.match(markdown, /README:\n- readme\.md aaaaaaaaaaaa/u);
  assert.match(markdown, /Tree files:\n- packages\/gittensory-engine\/package\.json \(512 bytes bbbbbbbbbbbb\)/u);
  assert.match(markdown, /External references:\n- issue:3010 at 2026-06-02T00:00:00\.000Z/u);
  assert.match(markdown, /## Excluded Post-Target Context/u);
  assert.match(markdown, /- 333333333333 2026-06-03T00:00:00\.000Z fix: later change/u);
  assert.match(markdown, /- pull\\_request:9999 at 2026-06-03T00:00:00\.000Z/u);
  assert.match(markdown, /## Validation\n\n- ok/u);
});

test("renderReplayTargetSnapshotManifestMarkdown reports empty optional sections as none", () => {
  const snapshot = createReplayTargetSnapshot({
    ...baseInput(),
    tags: [],
    releases: [],
    readme: null,
    treeFiles: [],
    externalReferences: [],
  });
  const markdown = renderReplayTargetSnapshotManifestMarkdown(snapshot);

  assert.match(markdown, /Tags:\n- none/u);
  assert.match(markdown, /Releases:\n- none/u);
  assert.match(markdown, /README:\n- none/u);
  assert.match(markdown, /Tree files:\n- none/u);
  assert.match(markdown, /External references:\n- none/u);
});

test("renderReplayTargetSnapshotManifestMarkdown escapes caller-supplied markdown controls", () => {
  const snapshot = createReplayTargetSnapshot({
    ...baseInput(),
    exportRoot: "./snapshots/[audit]",
    commits: [
      {
        sha: FIRST,
        committedAt: "2026-06-01T00:00:00Z",
        subject: "docs: `readme` *initial*\nnext",
        paths: ["README.md"],
      },
    ],
    targetCommitSha: FIRST,
    tags: [{ name: "v_[one]", targetSha: FIRST }],
    releases: [{ name: "release|one", tagName: "v_[one]" }],
    externalReferences: [{ kind: "manual-note", id: "id_*one*", observedAt: "2026-06-01T00:00:00Z" }],
  });
  const markdown = renderReplayTargetSnapshotManifestMarkdown(snapshot);

  assert.ok(markdown.includes("worktree: snapshots/\\[audit\\]/"));
  assert.ok(markdown.includes("docs: \\\\\\`readme\\\\\\` \\\\\\*initial\\\\\\* next"));
  assert.ok(markdown.includes("v\\_\\[one\\]"));
  assert.ok(markdown.includes("release\\|one"));
  assert.ok(markdown.includes("manual\\_note:id\\_\\*one\\*"));
});

test("renderReplayTargetSnapshotManifestMarkdown includes validation violations", () => {
  const snapshot = createReplayTargetSnapshot(baseInput());
  const invalid = {
    ...snapshot,
    context: {
      ...snapshot.context,
      tags: [{ name: "bad", targetSha: SECOND, taggedAt: "2026-06-03T00:00:00.000Z" }],
    },
  };
  const markdown = renderReplayTargetSnapshotManifestMarkdown(invalid);

  assert.match(markdown, /## Validation\n\n- tag:bad: post\\_target\\_timestamp/u);
  assert.doesNotMatch(markdown, /- ok/u);
});

test("createReplayTargetSnapshot rejects invalid repo names, SHAs, timestamps, and paths", () => {
  assert.throws(() => createReplayTargetSnapshot({ ...baseInput(), repo: "not-a-repo" }), /owner\/name/u);
  assert.throws(() => createReplayTargetSnapshot({ ...baseInput(), targetCommitSha: "notsha" }), /targetCommitSha/u);
  assert.throws(
    () => createReplayTargetSnapshot({ ...baseInput(), targetCommittedAt: "not a date" }),
    /targetCommittedAt/u,
  );
  assert.throws(
    () =>
      createReplayTargetSnapshot({
        ...baseInput(),
        treeFiles: [{ path: "../outside", blobSha: README }],
      }),
    /paths must be relative/u,
  );
});

test("createReplayTargetSnapshot requires targetCommittedAt when target commit is absent", () => {
  assert.throws(
    () =>
      createReplayTargetSnapshot({
        ...baseInput(),
        targetCommitSha: "4444444444444444444444444444444444444444",
      }),
    /targetCommittedAt is required/u,
  );
});

test("createReplayTargetSnapshot fails fast when a timestamped absent target is not in context", () => {
  assert.throws(
    () =>
      createReplayTargetSnapshot({
        ...baseInput(),
        targetCommitSha: "4444444444444444444444444444444444444444",
        targetCommittedAt: "2026-06-02T00:00:00Z",
      }),
    /post-target or incomplete artifacts/u,
  );
});

test("createReplayTargetSnapshot normalizes compact SHAs and custom export roots", () => {
  const snapshot = createReplayTargetSnapshot({
    ...baseInput(),
    targetCommitSha: "2222222",
    targetCommittedAt: "2026-06-02T00:00:00Z",
    exportRoot: "./snapshots/custom",
  });

  assert.equal(snapshot.targetCommitSha, SECOND);
  assert.equal(snapshot.exportPlan.exportRoot, "snapshots/custom");
  assert.equal(snapshot.exportPlan.worktreePath, `snapshots/custom/${snapshot.snapshotId}/tree`);
});

test("createReplayTargetSnapshot sorts input records deterministically", () => {
  const input = baseInput();
  const snapshot = createReplayTargetSnapshot({
    ...input,
    commits: [...input.commits].reverse(),
    tags: [...(input.tags ?? [])].reverse(),
    releases: [...(input.releases ?? [])].reverse(),
    treeFiles: [...(input.treeFiles ?? [])].reverse(),
    externalReferences: [...(input.externalReferences ?? [])].reverse(),
  });

  assert.deepEqual(snapshot.context.commits.map((commit) => commit.sha), [FIRST, SECOND]);
  assert.deepEqual(snapshot.context.treeFiles.map((file) => file.path), [
    "packages/gittensory-engine/package.json",
    "readme.md",
  ]);
  assert.deepEqual(snapshot.excluded.treeFiles.map((file) => file.path), ["src/later.ts"]);
});
