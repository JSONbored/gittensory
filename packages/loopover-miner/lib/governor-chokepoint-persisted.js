import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";
import { openGovernorState } from "./governor-state.js";
export function evaluateGovernorChokepointGatePersisted(input, options = {}) {
    const ownsGovernorState = options.governorState === undefined;
    const governorState = options.governorState ?? openGovernorState();
    try {
        const persistedRateLimit = governorState.loadRateLimitState();
        const persistedCapUsage = governorState.loadCapUsage();
        const resolvedInput = {
            ...input,
            rateLimitBuckets: input.rateLimitBuckets ?? persistedRateLimit.buckets,
            rateLimitBackoffAttempts: input.rateLimitBackoffAttempts ?? persistedRateLimit.backoffAttempts,
            capUsage: input.capUsage ?? persistedCapUsage,
        };
        const gateOptions = options.append === undefined ? {} : { append: options.append };
        const result = evaluateGovernorChokepointGate(resolvedInput, gateOptions);
        governorState.saveRateLimitState({ buckets: result.rateLimitBuckets, backoffAttempts: result.rateLimitBackoffAttempts });
        return result;
    }
    finally {
        if (ownsGovernorState)
            governorState.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItY2hva2Vwb2ludC1wZXJzaXN0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1jaG9rZXBvaW50LXBlcnNpc3RlZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQUUsOEJBQThCLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUUxRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQTRCeEQsTUFBTSxVQUFVLHVDQUF1QyxDQUNyRCxLQUF1QyxFQUN2QyxVQUdJLEVBQUU7SUFFTixNQUFNLGlCQUFpQixHQUFHLE9BQU8sQ0FBQyxhQUFhLEtBQUssU0FBUyxDQUFDO0lBQzlELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxhQUFhLElBQUksaUJBQWlCLEVBQUUsQ0FBQztJQUNuRSxJQUFJLENBQUM7UUFDSCxNQUFNLGtCQUFrQixHQUFHLGFBQWEsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQzlELE1BQU0saUJBQWlCLEdBQUcsYUFBYSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3ZELE1BQU0sYUFBYSxHQUE0QjtZQUM3QyxHQUFHLEtBQUs7WUFDUixnQkFBZ0IsRUFBRSxLQUFLLENBQUMsZ0JBQWdCLElBQUksa0JBQWtCLENBQUMsT0FBTztZQUN0RSx3QkFBd0IsRUFBRSxLQUFLLENBQUMsd0JBQXdCLElBQUksa0JBQWtCLENBQUMsZUFBZTtZQUM5RixRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVEsSUFBSSxpQkFBaUI7U0FDOUMsQ0FBQztRQUNGLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNuRixNQUFNLE1BQU0sR0FBRyw4QkFBOEIsQ0FBQyxhQUFhLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDMUUsYUFBYSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsRUFBRSxlQUFlLEVBQUUsTUFBTSxDQUFDLHdCQUF3QixFQUFFLENBQUMsQ0FBQztRQUN6SCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO1lBQVMsQ0FBQztRQUNULElBQUksaUJBQWlCO1lBQUUsYUFBYSxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQy9DLENBQUM7QUFDSCxDQUFDIn0=