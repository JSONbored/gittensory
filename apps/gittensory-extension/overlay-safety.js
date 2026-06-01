/** Source upload and repository intelligence stay on the API/MCP side; the extension never uploads source. */
export const EXTENSION_SOURCE_UPLOAD_ENABLED = false;

export const OVERLAY_FORBIDDEN_TERMS = [
  "wallet",
  "hotkey",
  "coldkey",
  "mnemonic",
  "raw trust score",
  "payout",
  "reward estimate",
  "farming",
  "private reviewability",
  "public score estimate",
];

const OVERLAY_FORBIDDEN_PATTERN =
  /\b(reward\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|public[-_\s]?score[-_\s]?estimate)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\Users\\/i;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isOverlayDisplaySafe(value) {
  const text = String(value ?? "");
  if (!text.trim()) return true;
  if (OVERLAY_FORBIDDEN_PATTERN.test(text)) return false;
  return !OVERLAY_FORBIDDEN_TERMS.some((term) => text.toLowerCase().includes(term.toLowerCase()));
}

/**
 * @param {string} value
 * @returns {string}
 */
export function redactForOverlayDisplay(value) {
  return isOverlayDisplaySafe(value) ? String(value ?? "") : "[redacted]";
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeOverlayHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * @param {unknown} panels
 * @returns {string}
 */
export function renderOverlayPanels(panels) {
  if (!Array.isArray(panels)) return "";
  return panels
    .map((panel) => {
      const rows = Array.isArray(panel?.rows) ? panel.rows : [];
      const rowHtml = rows
        .map((row) => {
          const key = escapeOverlayHtml(redactForOverlayDisplay(String(row?.k ?? "")));
          const cell = escapeOverlayHtml(redactForOverlayDisplay(String(row?.v ?? "")));
          return `<div><dt>${key}</dt><dd>${cell}</dd></div>`;
        })
        .join("");
      return `
        <section class="gittensory-overlay__panel">
          <div class="gittensory-overlay__panel-head">
            <strong>${escapeOverlayHtml(redactForOverlayDisplay(String(panel?.label ?? "Panel")))}</strong>
            <span>${escapeOverlayHtml(redactForOverlayDisplay(String(panel?.badge ?? "live")))}</span>
          </div>
          <dl>${rowHtml}</dl>
        </section>
      `;
    })
    .join("");
}
