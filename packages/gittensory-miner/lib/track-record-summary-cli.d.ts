export type ParsedTrackRecordRenderArgs =
  | {
      json: boolean;
      login: string;
      outcomes: readonly unknown[];
      incidents: readonly unknown[];
      config: unknown;
      now: string | null;
    }
  | { error: string };

export function parseTrackRecordRenderArgs(args: string[]): ParsedTrackRecordRenderArgs;

export function runTrackRecordRender(
  args: string[],
  options?: {
    resolveTrackRecordSummaryConfig?: typeof import("@jsonbored/gittensory-engine").resolveTrackRecordSummaryConfig;
    computeTrackRecordSummary?: typeof import("@jsonbored/gittensory-engine").computeTrackRecordSummary;
    renderTrackRecordSummaryMarkdown?: typeof import("@jsonbored/gittensory-engine").renderTrackRecordSummaryMarkdown;
  },
): number;

export function runTrackRecordCli(
  subcommand: string | undefined,
  args: string[],
  options?: {
    resolveTrackRecordSummaryConfig?: typeof import("@jsonbored/gittensory-engine").resolveTrackRecordSummaryConfig;
    computeTrackRecordSummary?: typeof import("@jsonbored/gittensory-engine").computeTrackRecordSummary;
    renderTrackRecordSummaryMarkdown?: typeof import("@jsonbored/gittensory-engine").renderTrackRecordSummaryMarkdown;
  },
): number;
