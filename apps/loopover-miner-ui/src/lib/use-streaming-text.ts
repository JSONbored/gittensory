import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A chunked text source (#6516). A factory rather than a bare AsyncIterable so each run gets a fresh iterator:
 * handing the hook an already-started iterable would make a restart resume mid-stream instead of starting over,
 * and an async generator can only be consumed once.
 */
export type StreamingTextSource = () => AsyncIterable<string>;

/** Where a stream is in its lifecycle. `cancelled` is distinct from `done` on purpose: a caller re-rendering a
 *  half-finished answer needs to know the text it's holding is a truncated fragment, not a complete reply. */
export type StreamingTextStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export type StreamingTextState = {
  text: string;
  status: StreamingTextStatus;
  error: string | null;
  cancel: () => void;
};

/**
 * Consume a chunked text source, revealing the answer as it arrives instead of popping it in whole (#6516).
 *
 * Cancellation discipline mirrors usePolledFetch's `cancelled` flag: every state write is guarded by a
 * per-run token, so a chunk that lands after a restart, an explicit cancel, or an unmount can never reach
 * state. That matters more here than for a poll -- an async iterator can keep yielding for a while after we
 * stop caring, and a late chunk appended to a NEW stream's text would silently corrupt the reply on screen.
 *
 * Plumbing only: the source is whatever the caller passes, so the hook itself makes no network call.
 */
export function useStreamingText(source: StreamingTextSource | null): StreamingTextState {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StreamingTextStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Identifies the current run. Every state write checks it first, so exactly one run can own state at a time
  // and a superseded run goes quiet without needing to interrupt the iterator it's parked on.
  const runIdRef = useRef(0);
  // Survives unmount: the effect cleanup can't clear a flag the late chunk still reads, so this is the one
  // signal both the "run superseded" and "component gone" cases share.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const cancel = useCallback(() => {
    // Bumping the token orphans the in-flight run: its next chunk fails the ownership check and is dropped.
    runIdRef.current += 1;
    setStatus((current) => (current === "streaming" ? "cancelled" : current));
  }, []);

  useEffect(() => {
    if (!source) return;

    const runId = (runIdRef.current += 1);
    // One predicate for both hazards -- a superseded run and an unmounted component are the same "don't write"
    // condition, and splitting them invites fixing one and forgetting the other.
    const owns = () => mountedRef.current && runIdRef.current === runId;

    setText("");
    setError(null);
    setStatus("streaming");

    void (async () => {
      try {
        for await (const chunk of source()) {
          if (!owns()) return;
          // Functional update: two chunks arriving in the same tick would otherwise both append to the same
          // stale snapshot and the first one's text would vanish.
          setText((previous) => previous + chunk);
        }
        if (owns()) setStatus("done");
      } catch (caught) {
        // A source that throws or rejects mid-stream must surface here rather than escape as an unhandled
        // rejection -- and must not overwrite a newer run's state if this one was already superseded.
        if (!owns()) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus("error");
      }
    })();

    // Restarting on a new source, or unmounting, orphans this run the same way cancel() does.
    return () => {
      runIdRef.current += 1;
    };
  }, [source]);

  return { text, status, error, cancel };
}
