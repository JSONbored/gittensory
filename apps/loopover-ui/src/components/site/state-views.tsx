import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { toast } from "sonner";

import { notifyApiFailure } from "@/lib/api/request";
import {
  Spinner,
  LoadingState,
  EmptyState,
  StateActionButton,
  ErrorState,
  StateBoundary as UiKitStateBoundary,
} from "@loopover/ui-kit/components/state-views";

export { Spinner, LoadingState, EmptyState, StateActionButton, ErrorState };

/** Forwards every prop to the ui-kit primitive, defaulting `onFailureNotify` to this app's real
 *  `notifyApiFailure` singleton so every existing call site's runtime behavior stays byte-identical
 *  to before the state-views port (#6506) -- a caller can still override it explicitly. Wrapped in an
 *  arrow function (not passed directly) so `notifyApiFailure` is only dereferenced when the ui-kit
 *  boundary actually calls it (isError && errorLabel), matching the original's lazy reference --
 *  several existing tests partially mock `@/lib/api/request` without `notifyApiFailure` and never
 *  exercise the error path, so an eager reference here would break them. */
export function StateBoundary(props: ComponentProps<typeof UiKitStateBoundary>) {
  return <UiKitStateBoundary onFailureNotify={(args) => notifyApiFailure(args)} {...props} />;
}

export function usePreviewDataState(label: string, delay = 220) {
  const [version, setVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    const timer = window.setTimeout(() => setIsLoading(false), delay);
    return () => window.clearTimeout(timer);
  }, [delay, version]);

  const refresh = useCallback(() => {
    toast("Refreshing preview data", {
      description: `${label} will reload with the latest available domain data.`,
    });
    setVersion((current) => current + 1);
  }, [label]);

  const retry = useCallback(() => {
    toast("Retrying data request", {
      description: `We’re requesting ${label.toLowerCase()} again now.`,
    });
    setVersion((current) => current + 1);
  }, [label]);

  return { isLoading, refresh, retry };
}
