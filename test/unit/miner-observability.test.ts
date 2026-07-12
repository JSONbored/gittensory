import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINER_BUILD_INFO,
  MINER_SCRAPE_TIMESTAMP,
  OBSERVABILITY_ENABLED_BY_DEFAULT,
  composeMinerScrapeDocument,
  resolveMetricsExportConfig,
  withMinerSpan,
  writeMinerMetricsTextfile,
} from "../../packages/gittensory-miner/lib/observability.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-observability-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner observability surface (#4839)", () => {
  it("is off by default", () => {
    expect(OBSERVABILITY_ENABLED_BY_DEFAULT).toBe(false);
  });

  describe("resolveMetricsExportConfig", () => {
    it("is disabled when the env var is unset, blank, or non-string", () => {
      expect(resolveMetricsExportConfig({})).toEqual({ enabled: false, filePath: null });
      expect(resolveMetricsExportConfig({ GITTENSORY_MINER_METRICS_FILE: "   " })).toEqual({
        enabled: false,
        filePath: null,
      });
      expect(
        resolveMetricsExportConfig({ GITTENSORY_MINER_METRICS_FILE: 5 as unknown as string }),
      ).toEqual({ enabled: false, filePath: null });
    });

    it("is enabled and trims the path when the env var is set", () => {
      expect(resolveMetricsExportConfig({ GITTENSORY_MINER_METRICS_FILE: "  /tmp/m.prom  " })).toEqual({
        enabled: true,
        filePath: "/tmp/m.prom",
      });
    });

    it("defaults to process.env", () => {
      expect(resolveMetricsExportConfig()).toEqual({ enabled: false, filePath: null });
    });
  });

  describe("composeMinerScrapeDocument", () => {
    it("prefixes build-info + scrape-timestamp gauges and appends non-blank string sections", () => {
      const doc = composeMinerScrapeDocument({
        sections: ["# HELP a A\n# TYPE a counter\na 1\n", "  # HELP b B\nb 2  "],
        version: "1.2.3",
        nowMs: 1_720_000_000_000,
      });
      expect(doc).toContain(`# TYPE ${MINER_BUILD_INFO} gauge`);
      expect(doc).toContain(`${MINER_BUILD_INFO}{version="1.2.3"} 1`);
      expect(doc).toContain(`${MINER_SCRAPE_TIMESTAMP} 1720000000`);
      expect(doc).toContain("a 1");
      expect(doc).toContain("b 2");
      expect(doc.endsWith("\n")).toBe(true);
      expect(doc.endsWith("\n\n")).toBe(false);
    });

    it("escapes the version label value", () => {
      const doc = composeMinerScrapeDocument({ version: 'a"b\\c', nowMs: 0 });
      expect(doc).toContain(`${MINER_BUILD_INFO}{version="a\\"b\\\\c"} 1`);
    });

    it("drops non-string and blank sections", () => {
      const doc = composeMinerScrapeDocument({
        sections: [42 as unknown as string, "   ", "kept 1\n"],
        version: "v",
        nowMs: 1000,
      });
      expect(doc).toContain("kept 1");
      expect(doc).not.toContain("42");
    });

    it("falls back to the current time when nowMs is not a finite number, and works with no arguments", () => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
      const doc = composeMinerScrapeDocument({ nowMs: Number.NaN });
      expect(doc).toContain(`${MINER_SCRAPE_TIMESTAMP} 2000`);
      const bare = composeMinerScrapeDocument();
      expect(bare).toContain(`${MINER_BUILD_INFO}{version=""} 1`);
    });
  });

  describe("writeMinerMetricsTextfile", () => {
    it("rejects a missing or blank path", () => {
      expect(() => writeMinerMetricsTextfile("doc", "")).toThrow(/path is required/);
      expect(() => writeMinerMetricsTextfile("doc", 5 as unknown as string)).toThrow(/path is required/);
    });

    it("writes atomically via injected fs (temp file then rename)", () => {
      const calls: string[] = [];
      const written = writeMinerMetricsTextfile("payload", "  /var/x/m.prom  ", {
        mkdirSync: (path, opts) => {
          calls.push(`mkdir:${path}:${opts.recursive}`);
          return undefined;
        },
        writeFileSync: (path, data) => {
          calls.push(`write:${path}:${data}`);
        },
        renameSync: (from, to) => {
          calls.push(`rename:${from}:${to}`);
        },
      });
      expect(written).toBe("/var/x/m.prom");
      expect(calls).toEqual([
        "mkdir:/var/x:true",
        "write:/var/x/m.prom.tmp:payload",
        "rename:/var/x/m.prom.tmp:/var/x/m.prom",
      ]);
    });

    it("writes a real file with the default node:fs implementation", () => {
      const target = join(tempRoot(), "nested", "metrics.prom");
      const written = writeMinerMetricsTextfile("real payload\n", target);
      expect(written).toBe(target);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("real payload\n");
    });
  });

  describe("withMinerSpan", () => {
    it("is a zero-instrumentation pass-through when disabled", async () => {
      const onSpan = vi.fn();
      await expect(withMinerSpan("x", { a: 1 }, () => 7, { onSpan })).resolves.toBe(7);
      expect(onSpan).not.toHaveBeenCalled();
    });

    it("times fn and reports success via onSpan when enabled", async () => {
      const onSpan = vi.fn();
      const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(175);
      await expect(withMinerSpan("job", { repo: "a/b" }, async () => "done", { enabled: true, now, onSpan })).resolves.toBe(
        "done",
      );
      expect(onSpan).toHaveBeenCalledWith({ name: "job", attributes: { repo: "a/b" }, durationMs: 75, ok: true });
    });

    it("reports failure and rethrows, defaulting attributes to {} and now to Date.now", async () => {
      const onSpan = vi.fn();
      vi.spyOn(Date, "now").mockReturnValue(500);
      const boom = new Error("kaboom");
      await expect(withMinerSpan("job", undefined, () => Promise.reject(boom), { enabled: true, onSpan })).rejects.toBe(
        boom,
      );
      expect(onSpan).toHaveBeenCalledWith({ name: "job", attributes: {}, durationMs: 0, ok: false, error: boom });
    });

    it("runs enabled without an onSpan sink", async () => {
      await expect(withMinerSpan("job", { a: 1 }, () => 9, { enabled: true })).resolves.toBe(9);
    });
  });
});
