export type ReviewTraceHeaders = {
  sentryTrace?: string | undefined;
  baggage?: string | undefined;
};

export type ReviewSpanOptions = {
  forceTransaction?: boolean | undefined;
  op?: string | undefined;
  parent?: ReviewTraceHeaders | undefined;
};

type ReviewTraceAdapter = {
  withSpan<T>(
    name: string,
    attributes: Record<string, unknown> | undefined,
    fn: () => T | Promise<T>,
    options?: ReviewSpanOptions,
  ): Promise<T>;
  currentTraceHeaders(): ReviewTraceHeaders | undefined;
};

let adapter: ReviewTraceAdapter | null = null;

export function setReviewTraceAdapter(next: ReviewTraceAdapter | null): void {
  adapter = next;
}

export async function withReviewSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
  options?: ReviewSpanOptions,
): Promise<T> {
  if (!adapter) return await fn();
  return await adapter.withSpan(name, attributes, fn, options);
}

export function currentReviewTraceHeaders(): ReviewTraceHeaders | undefined {
  return adapter?.currentTraceHeaders();
}

export function resetReviewTraceAdapterForTest(): void {
  adapter = null;
}
