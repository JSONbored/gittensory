import { useState } from "react";
import { Button } from "@loopover/ui-kit/components/button";

// Light/dark theme toggle for miner-ui (#6508 / #6828). The shared @loopover/ui-kit theme.css already ships BOTH
// palettes (light tokens under :root, dark overrides under .dark), switched purely by whether a `.dark` class
// is present on <html> — so this control only flips that class, mirrors it into colorScheme (so native form
// controls follow the theme), and persists the choice. index.html's inline no-flash script reads the same
// persisted value to restore the theme before first paint. Compact ghost icon so the header row stays usable
// beside the four nav links on narrow widths.
const STORAGE_KEY = "loopover.miner_theme";

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
    </svg>
  );
}

export function ThemeToggle() {
  // Client-only Vite SPA — document is always present when this runs.
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  function toggle() {
    const nextIsDark = !isDark;
    const root = document.documentElement;
    root.classList.toggle("dark", nextIsDark);
    root.style.colorScheme = nextIsDark ? "dark" : "light";
    try {
      localStorage.setItem(STORAGE_KEY, nextIsDark ? "dark" : "light");
    } catch {
      // localStorage can throw (private mode / storage disabled); the in-page toggle still works this session.
    }
    setIsDark(nextIsDark);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
