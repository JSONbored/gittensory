// Commands-panel model (#7531). The markdown-lite inline tokenizer lives here (not in the .tsx) so the
// component file exports only components (react-refresh/only-export-components), and so the split logic —
// the part that carried the intraword-underscore bug — is directly unit-testable.

/** Split a single line into markdown-lite tokens: `**bold**`, `` `code` ``, `_italic_`, and plain runs.
 *
 *  The `_..._` italics alternative is anchored to word boundaries (#7531) so it never matches underscores
 *  INSIDE a longer identifier — `LOOPOVER_ENABLE_PAGERDUTY` / `repo_full_name` must tokenize as one plain
 *  run, not have an arbitrary intraword fragment split out and italicized. Mirrors CommonMark's intraword-
 *  underscore rule: `_` only opens/closes emphasis when it is not flanked by an alphanumeric on the outside.
 */
export function splitInlineMarkup(line: string): string[] {
  return line
    .split(/(\*\*[^*]+\*\*|`[^`]+`|(?<![A-Za-z0-9])_[^_]+_(?![A-Za-z0-9]))/g)
    .filter(Boolean);
}
