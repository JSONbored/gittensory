import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clockSkewSampleAgeSeconds,
  clockSkewSecondsSample,
  recordClockSkewFromResponse,
  resetClockSkewForTest,
} from "../../src/selfhost/clock-skew";

beforeEach(() => resetClockSkewForTest());
afterEach(() => vi.useRealTimers());

describe("clock-skew", () => {
  it("defaults to 0 before any sample is recorded", () => {
    expect(clockSkewSecondsSample()).toBe(0);
  });

  it("records a positive skew when the local clock is ahead of the response's Date header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    const response = new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } });
    recordClockSkewFromResponse(response);
    expect(clockSkewSecondsSample()).toBe(300); // 5 minutes ahead
  });

  it("records a negative skew when the local clock is behind the response's Date header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    const response = new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:02:00 GMT" } });
    recordClockSkewFromResponse(response);
    expect(clockSkewSecondsSample()).toBe(-120); // 2 minutes behind
  });

  it("ignores a response with no Date header, leaving the prior sample in place", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    expect(clockSkewSecondsSample()).toBe(300);

    recordClockSkewFromResponse(new Response(null));
    expect(clockSkewSecondsSample()).toBe(300); // unchanged, not reset to 0
  });

  it("ignores an unparseable Date header, leaving the prior sample in place", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:05:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    expect(clockSkewSecondsSample()).toBe(300);

    recordClockSkewFromResponse(new Response(null, { headers: { date: "not-a-date" } }));
    expect(clockSkewSecondsSample()).toBe(300); // unchanged, not reset to 0
  });

  it("resetClockSkewForTest restores the sample to 0", () => {
    recordClockSkewFromResponse(new Response(null, { headers: { date: new Date(Date.now() - 60_000).toUTCString() } }));
    expect(clockSkewSecondsSample()).not.toBe(0);
    resetClockSkewForTest();
    expect(clockSkewSecondsSample()).toBe(0);
  });

  // #7000: the staleness/freshness signal alongside the skew value.
  it("reports the -1 'never sampled' sentinel before any sample is recorded", () => {
    expect(clockSkewSampleAgeSeconds()).toBe(-1);
  });

  it("reports the seconds elapsed since the last successful sample", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));
    expect(clockSkewSampleAgeSeconds()).toBe(0); // just sampled

    vi.setSystemTime(new Date("2026-07-06T12:00:45.000Z"));
    expect(clockSkewSampleAgeSeconds()).toBe(45); // 45s since the sample, even though the skew value is unchanged
  });

  it("keeps aging (does not refresh) when a later response is ignored for lack of a usable Date header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    recordClockSkewFromResponse(new Response(null, { headers: { date: "Mon, 06 Jul 2026 12:00:00 GMT" } }));

    vi.setSystemTime(new Date("2026-07-06T12:00:30.000Z"));
    recordClockSkewFromResponse(new Response(null)); // no Date header → ignored, sample time NOT refreshed
    recordClockSkewFromResponse(new Response(null, { headers: { date: "not-a-date" } })); // unparseable → ignored too
    expect(clockSkewSampleAgeSeconds()).toBe(30); // still measured from the original sample
  });

  it("resetClockSkewForTest restores the age to the -1 sentinel", () => {
    recordClockSkewFromResponse(new Response(null, { headers: { date: new Date().toUTCString() } }));
    expect(clockSkewSampleAgeSeconds()).not.toBe(-1);
    resetClockSkewForTest();
    expect(clockSkewSampleAgeSeconds()).toBe(-1);
  });
});
