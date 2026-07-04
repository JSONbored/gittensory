import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  parseTrackRecordRenderArgs,
  runTrackRecordCli,
  runTrackRecordRender,
} from "../../packages/gittensory-miner/lib/track-record-summary-cli.js";

const NOW = "2026-07-04T18:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner track-record summary CLI (#3008)", () => {
  it("parseTrackRecordRenderArgs validates argv and array inputs", () => {
    expect(
      parseTrackRecordRenderArgs([
        "--login",
        "miner",
        "--outcomes",
        JSON.stringify([
          {
            id: "pr-1",
            repoFullName: "owner/repo",
            authorLogin: "miner",
            state: "merged",
            createdAt: "2026-06-01T00:00:00Z",
          },
        ]),
        "--config",
        JSON.stringify({ miner: { trackRecordSummary: { enabled: true } } }),
        "--now",
        NOW,
        "--json",
      ]),
    ).toEqual({
      json: true,
      login: "miner",
      outcomes: [
        {
          id: "pr-1",
          repoFullName: "owner/repo",
          authorLogin: "miner",
          state: "merged",
          createdAt: "2026-06-01T00:00:00Z",
        },
      ],
      incidents: [],
      config: { miner: { trackRecordSummary: { enabled: true } } },
      now: NOW,
    });
    expect(parseTrackRecordRenderArgs(["--login", "miner"])).toEqual({
      error: expect.stringContaining("Usage:"),
    });
    expect(
      parseTrackRecordRenderArgs([
        "--login",
        "miner",
        "--outcomes",
        JSON.stringify({ not: "array" }),
      ]),
    ).toEqual({ error: "Outcomes must be a JSON array." });
  });

  it("parseTrackRecordRenderArgs reads outcomes from an @file path", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-track-record-cli-"));
    roots.push(root);
    const file = join(root, "outcomes.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          repoFullName: "owner/repo",
          authorLogin: "miner",
          state: "merged",
          createdAt: "2026-06-01T00:00:00Z",
        },
      ]),
    );
    expect(
      parseTrackRecordRenderArgs(["--login", "miner", "--outcomes", `@${file}`]),
    ).toEqual({
      json: false,
      login: "miner",
      outcomes: [
        {
          repoFullName: "owner/repo",
          authorLogin: "miner",
          state: "merged",
          createdAt: "2026-06-01T00:00:00Z",
        },
      ],
      incidents: [],
      config: null,
      now: null,
    });
  });

  it("runTrackRecordRender prints Markdown and JSON output", () => {
    const args = [
      "--login",
      "miner",
      "--outcomes",
      JSON.stringify([
        {
          id: "pr-1",
          repoFullName: "owner/repo",
          authorLogin: "miner",
          state: "merged",
          createdAt: "2026-06-01T00:00:00Z",
        },
      ]),
      "--config",
      JSON.stringify({ miner: { trackRecordSummary: { enabled: true } } }),
      "--now",
      NOW,
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runTrackRecordRender(args)).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("### Public contributor record");

    log.mockClear();
    expect(runTrackRecordRender([...args, "--json"])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.login).toBe("miner");
    expect(parsed.enabled).toBe(true);
    expect(parsed.mergeRate.numerator).toBe(1);
  });

  it("runTrackRecordRender renders nothing when the feature is disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runTrackRecordRender([
        "--login",
        "miner",
        "--outcomes",
        JSON.stringify([
          {
            repoFullName: "owner/repo",
            authorLogin: "miner",
            state: "merged",
            createdAt: "2026-06-01T00:00:00Z",
          },
        ]),
      ]),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0] ?? "")).toBe("");
  });

  it("runTrackRecordCli dispatches render and rejects unknown subcommands", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runTrackRecordCli("render", ["--login", "miner"])).toBe(2);
    expect(runTrackRecordCli("summary", [])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain("Unknown track-record subcommand");
  });
});
