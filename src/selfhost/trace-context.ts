import type { ReviewTraceHeaders } from "../observability/review-trace";

const requestTraceParents = new WeakMap<Request, string>();
const requestReviewTraceHeaders = new WeakMap<Request, ReviewTraceHeaders>();

export function setSelfHostRequestTraceParent(request: Request, traceParent: string | undefined): void {
  if (traceParent) requestTraceParents.set(request, traceParent);
  else requestTraceParents.delete(request);
}

export function getSelfHostRequestTraceParent(request: Request): string | undefined {
  return requestTraceParents.get(request);
}

export function setSelfHostRequestReviewTraceHeaders(
  request: Request,
  headers: ReviewTraceHeaders | undefined,
): void {
  if (headers?.sentryTrace) requestReviewTraceHeaders.set(request, headers);
  else requestReviewTraceHeaders.delete(request);
}

export function getSelfHostRequestReviewTraceHeaders(
  request: Request,
): ReviewTraceHeaders | undefined {
  return requestReviewTraceHeaders.get(request);
}

export function clearSelfHostRequestTraceParent(request: Request): void {
  requestTraceParents.delete(request);
  requestReviewTraceHeaders.delete(request);
}
