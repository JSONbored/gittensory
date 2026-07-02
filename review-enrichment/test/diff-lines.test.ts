// Unit for the shared diff-header discriminator used by analyzers that scan possibly-headerless patch fragments.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isDiffFileHeaderLine } from "../dist/analyzers/diff-lines.js";

test("isDiffFileHeaderLine matches real file headers only, not ++/--- content", () => {
  // Real unified-diff file headers → skipped.
  for (const header of ["+++ b/src/app.ts", "--- a/src/app.ts", "+++ /dev/null", "--- /dev/null"]) {
    assert.equal(isDiffFileHeaderLine(header), true, header);
  }
  // Added/removed CONTENT whose text begins with `++`/`--` renders as `+++…`/`---…` but is NOT a header and
  // must be scanned; likewise plain content and headerless single-line diffs.
  for (const content of ["+++x", "+++ const key = 1;", '+++ "lodash": "^1.0.0"', "+history analyzer", "---x", "+const y = 2;", "@@ -1,0 +1,1 @@"]) {
    assert.equal(isDiffFileHeaderLine(content), false, content);
  }
});
