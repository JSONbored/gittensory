import { useEffect, useState } from "react";

import { useStreamingText, type StreamingTextSource } from "../lib/use-streaming-text";

/**
 * True when the operator asked the OS for reduced motion (#6516). Same window.matchMedia + `change` listener
 * technique as the ui-kit's useIsMobile -- this app has no `motion` dependency and deliberately isn't gaining
 * one, so the escape hatch is read straight from the media query.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    setReduced(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Render a chunked answer as it streams in (#6516). Thin by design: the hook owns consumption and cancellation;
 * this only decides how the accumulated text is presented.
 *
 * Reduced motion changes the presentation, never the text. Both paths render the same characters at the same
 * time -- the only difference is the fade applied to the growing block -- so an operator who asked for less
 * motion still sees every chunk the moment it arrives, and never a truncated answer.
 */
export function StreamingText({ source, className }: { source: StreamingTextSource | null; className?: string }) {
  const { text, status, error } = useStreamingText(source);
  const prefersReducedMotion = usePrefersReducedMotion();

  if (status === "error") {
    return (
      <p role="alert" className="text-token-sm text-destructive">
        {error ?? "The response stream failed."}
      </p>
    );
  }

  return (
    <p
      // aria-live so a screen reader announces the answer as it fills in rather than only on completion.
      // "polite" -- an in-progress reply must never interrupt what the operator is already reading.
      aria-live="polite"
      aria-busy={status === "streaming"}
      data-status={status}
      className={[
        "whitespace-pre-wrap text-token-sm text-foreground",
        prefersReducedMotion ? "" : "transition-opacity duration-150",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {text}
    </p>
  );
}
