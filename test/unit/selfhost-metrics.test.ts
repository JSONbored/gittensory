import { afterEach, describe, expect, it } from "vitest";
import { gauge, incr, renderMetrics, resetMetrics } from "../../src/selfhost/metrics";

afterEach(() => resetMetrics());

describe("metrics registry (#982)", () => {
  it("counters accumulate and render", () => {
    incr("c_total");
    incr("c_total", undefined, 2);
    expect(renderMetrics()).toContain("c_total 3");
  });

  it("renders labels in Prometheus format", () => {
    incr("h_total", { status: "ok" });
    expect(renderMetrics()).toContain('h_total{status="ok"} 1');
  });

  it("gauges sample at scrape time", () => {
    let v = 5;
    gauge("g", () => v);
    expect(renderMetrics()).toContain("g 5");
    v = 9;
    expect(renderMetrics()).toContain("g 9");
  });

  it("a throwing gauge does not break the scrape", () => {
    gauge("bad", () => {
      throw new Error("x");
    });
    incr("ok_total");
    expect(renderMetrics()).toContain("ok_total 1");
  });
});
