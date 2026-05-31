import { useEffect, useState } from "react";
import { toast } from "sonner";

import { apiFetch } from "./request";
import { getApiOrigin } from "./origin";
import { mockSession, type MockSession } from "./mock";

const KEY = "gittensory.session";
const TRY_IT_TOKEN_KEY = "gittensory.session_token";
const ALL_ROLES: AppSession["roles"] = ["miner", "maintainer", "owner", "operator"];

export interface AppSession extends MockSession {
  token: string;
  expiresAt?: string;
  scopes?: string[];
}

type AuthState =
  | { status: "idle" }
  | { status: "starting" }
  | {
      status: "pending";
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      message?: string;
    }
  | { status: "error"; message: string };

type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

type DevicePollResponse =
  | { status: string; message?: string }
  | { token: string; login: string; expiresAt: string; scopes: string[] };

function read(): AppSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AppSession;
  } catch {
    return null;
  }
}

function write(s: AppSession | null) {
  if (typeof window === "undefined") return;
  if (s) {
    window.localStorage.setItem(KEY, JSON.stringify(s));
    window.localStorage.setItem(TRY_IT_TOKEN_KEY, s.token);
  } else {
    window.localStorage.removeItem(KEY);
    window.localStorage.removeItem(TRY_IT_TOKEN_KEY);
  }
  window.dispatchEvent(new Event("gittensory.session.changed"));
}

export function useSession() {
  const [session, setSession] = useState<AppSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ status: "idle" });

  useEffect(() => {
    setSession(read());
    setHydrated(true);
    const onChange = () => setSession(read());
    window.addEventListener("gittensory.session.changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("gittensory.session.changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const signInPreview = () => {
    write({
      ...mockSession,
      token: `demo_${Math.random().toString(36).slice(2, 10)}`,
    });
    toast.success("Preview session started", {
      description: "You can now explore the local app panels.",
    });
  };

  const signIn = async () => {
    setAuth({ status: "starting" });
    const origin = getApiOrigin().replace(/\/$/, "");
    const start = await apiFetch<DeviceStartResponse>(`${origin}/v1/auth/github/device/start`, {
      method: "POST",
      label: "GitHub device flow",
      timeoutMs: 10_000,
    });
    if (!start.ok) {
      setAuth({ status: "error", message: start.message });
      toast.error("GitHub sign-in failed", { description: start.message });
      return;
    }

    const expiresAt = Date.now() + start.data.expiresIn * 1000;
    setAuth({
      status: "pending",
      userCode: start.data.userCode,
      verificationUri: start.data.verificationUri,
      expiresAt,
    });
    window.open(start.data.verificationUri, "_blank", "noopener,noreferrer");
    toast("Complete GitHub device sign-in", {
      description: `Enter code ${start.data.userCode}. This page will keep checking.`,
    });

    let interval = Math.max(3, start.data.interval || 5);
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => window.setTimeout(resolve, interval * 1000));
      const poll = await apiFetch<DevicePollResponse>(`${origin}/v1/auth/github/device/poll`, {
        method: "POST",
        label: "GitHub device poll",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ deviceCode: start.data.deviceCode }),
        timeoutMs: 10_000,
      });
      if (!poll.ok) {
        setAuth({ status: "error", message: poll.message });
        toast.error("GitHub sign-in failed", { description: poll.message });
        return;
      }
      if ("token" in poll.data) {
        write({
          login: poll.data.login,
          github_id: 0,
          roles: ALL_ROLES,
          confirmed_miner: false,
          token: poll.data.token,
          expiresAt: poll.data.expiresAt,
          scopes: poll.data.scopes,
        });
        setAuth({ status: "idle" });
        toast.success("Signed in to Gittensory", {
          description: `Session stored locally for ${poll.data.login}.`,
        });
        return;
      }
      if (poll.data.status === "slow_down") interval += 5;
      setAuth({
        status: "pending",
        userCode: start.data.userCode,
        verificationUri: start.data.verificationUri,
        expiresAt,
        message: poll.data.message ?? poll.data.status,
      });
    }
    setAuth({ status: "error", message: "GitHub device code expired. Start sign-in again." });
  };

  const signOut = () => {
    const token = read()?.token;
    write(null);
    if (token && !token.startsWith("demo_")) {
      const origin = getApiOrigin().replace(/\/$/, "");
      void apiFetch(`${origin}/v1/auth/logout`, {
        method: "POST",
        label: "Sign out",
        headers: { Authorization: `Bearer ${token}` },
        silentStatus: true,
      });
    }
    toast("Signed out", { description: "The preview session was removed from this browser." });
  };

  return {
    session,
    hydrated,
    auth,
    signIn,
    signInPreview,
    signOut,
  };
}
