import { useCallback, useEffect, useState } from "react";

import { getApiOrigin } from "./origin";
import { apiFetch } from "./request";

type ResourceState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

export function useApiResource<T>(path: string, label: string, token?: string) {
  const [state, setState] = useState<ResourceState<T>>({
    status: "loading",
    data: null,
    error: null,
  });

  const load = useCallback(async () => {
    setState({ status: "loading", data: null, error: null });
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const result = await apiFetch<T>(`${getApiOrigin().replace(/\/$/, "")}${path}`, {
      label,
      headers,
    });
    if (result.ok) {
      setState({ status: "ready", data: result.data, error: null });
    } else {
      setState({ status: "error", data: null, error: result.message });
    }
  }, [label, path, token]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
}
