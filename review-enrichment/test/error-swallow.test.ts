// Units for the error-swallow analyzer (#2014). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectJsCatchSwallow,
  detectPythonExceptSwallow,
  scanErrorSwallow,
  scanPatchForErrorSwallow,
} from "../dist/analyzers/error-swallow.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectJsCatchSwallow: flags empty and unused-binding catches", () => {
  assert.equal(detectJsCatchSwallow("try {} catch (e) {}"), "empty-catch");
  assert.equal(detectJsCatchSwallow("} catch {}"), "empty-catch");
  assert.equal(detectJsCatchSwallow("catch (err) { return null; }"), "return-null");
  assert.equal(detectJsCatchSwallow("catch (err) { doWork(); }"), "unused-binding");
});

test("detectJsCatchSwallow: does not flag catches that log, rethrow, or use the binding", () => {
  assert.equal(detectJsCatchSwallow("catch (e) { console.error(e); }"), null);
  assert.equal(detectJsCatchSwallow("catch (e) { logger.warn(e); }"), null);
  assert.equal(detectJsCatchSwallow("catch (e) { throw e; }"), null);
  assert.equal(detectJsCatchSwallow("catch (e) { return handle(e); }"), null);
  assert.equal(detectJsCatchSwallow("catch { cleanup(); }"), null);
});

test("detectJsCatchSwallow: flags multiline catch blocks", () => {
  assert.equal(
    detectJsCatchSwallow("catch (err) {\n}"),
    "empty-catch",
  );
  assert.equal(
    detectJsCatchSwallow("catch (err) {\n  return null;\n}"),
    "return-null",
  );
  assert.equal(
    detectJsCatchSwallow("catch (err) {\n  console.error(err);\n}"),
    null,
  );
  assert.equal(
    detectJsCatchSwallow("catch (err) {\n  doWork();\n}"),
    "unused-binding",
  );
});

test("detectPythonExceptSwallow: allows except pass and flags empty/unused bodies", () => {
  assert.equal(detectPythonExceptSwallow("except Exception: pass"), null);
  assert.equal(detectPythonExceptSwallow("except Exception as e: pass"), null);
  assert.equal(detectPythonExceptSwallow("except Exception:"), "empty-catch");
  assert.equal(detectPythonExceptSwallow("except Exception as e:", "return None"), "return-null");
  assert.equal(detectPythonExceptSwallow("except Exception as e:", "cleanup()"), "unused-binding");
  assert.equal(detectPythonExceptSwallow("except Exception:", "pass"), null);
});

test("scanPatchForErrorSwallow: flags added lines with correct locations and respects caps", () => {
  const findings = scanPatchForErrorSwallow(
    "src/widget.ts",
    patchOf([
      "try { doWork(); } catch (e) {}",
      "try { other(); } catch (err) { return null; }",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/widget.ts", line: 1, kind: "empty-catch" },
    { file: "src/widget.ts", line: 2, kind: "return-null" },
  ]);
  const many = Array.from({ length: 30 }, () => "catch (e) {}");
  assert.equal(scanPatchForErrorSwallow("src/a.ts", patchOf(many), { maxFindings: 3 }).length, 3);
});

test("scanPatchForErrorSwallow: reports correct line with preceding context", () => {
  const patch = [
    "@@ -10,3 +10,4 @@",
    " unchanged context",
    "+  catch (err) {",
    "+  }",
  ].join("\n");
  const findings = scanPatchForErrorSwallow("src/widget.ts", patch);
  assert.deepEqual(findings, [{ file: "src/widget.ts", line: 11, kind: "empty-catch" }]);
});

test("scanPatchForErrorSwallow: flags multiline JS catch blocks in patches", () => {
  const findings = scanPatchForErrorSwallow(
    "src/widget.ts",
    patchOf(["try {", "  catch (err) {", "  }", "}"]),
  );
  assert.deepEqual(findings, [{ file: "src/widget.ts", line: 2, kind: "empty-catch" }]);

  const logged = scanPatchForErrorSwallow(
    "src/widget.ts",
    patchOf(["catch (err) {", "  console.error(err);", "}"]),
  );
  assert.deepEqual(logged, []);

  const unused = scanPatchForErrorSwallow(
    "src/widget.ts",
    patchOf(["catch (err) {", "  doWork();", "}"]),
  );
  assert.deepEqual(unused, [{ file: "src/widget.ts", line: 1, kind: "unused-binding" }]);
});

test("scanPatchForErrorSwallow: uses only the immediate next added Python body line", () => {
  const patch = [
    "@@ -1,0 +1,3 @@",
    "+except Exception as e:",
    "+    return None",
    "+except OtherError: pass",
  ].join("\n");
  const findings = scanPatchForErrorSwallow("lib/b.py", patch);
  assert.deepEqual(findings, [{ file: "lib/b.py", line: 1, kind: "return-null" }]);
});

test("scanPatchForErrorSwallow: skips test files and clean input", () => {
  assert.deepEqual(
    scanPatchForErrorSwallow("src/widget.test.ts", patchOf(["catch (e) {}"])),
    [],
  );
  assert.deepEqual(
    scanPatchForErrorSwallow("src/widget.ts", patchOf(["catch (e) { console.error(e); }"])),
    [],
  );
  assert.deepEqual(
    scanPatchForErrorSwallow("src/widget.ts", patchOf(["catch { cleanup(); }"])),
    [],
  );
});

test("scanErrorSwallow: aggregates across files and renders a value-safe brief", async () => {
  const findings = await scanErrorSwallow({
    files: [
      { path: "src/a.ts", patch: patchOf(["catch (e) {}"]) },
      { path: "lib/b.py", patch: patchOf(["except Exception:"]) },
    ],
  });
  assert.equal(findings.length, 2);
  const { promptSection } = renderBrief({
    errorSwallow: findings,
  });
  assert.match(promptSection, /Error swallowing/);
  assert.match(promptSection, /src\/a\.ts:1/);
  assert.doesNotMatch(promptSection, /catch \(e\)/);
});
