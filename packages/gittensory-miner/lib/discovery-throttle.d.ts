export const DEFAULT_RATE_LIMIT_LOW_WATER_MARK: number;
export const DEFAULT_RATE_LIMIT_HIGH_WATER_MARK: number;
export function resolveThrottledConcurrency(
  baseConcurrency: number,
  rateLimitRemaining: number | null,
  lowWaterMark: number,
  highWaterMark: number,
): number;
