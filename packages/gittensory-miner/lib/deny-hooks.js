// PreToolUse-style deny-hook primitives (#2295). A pure, deterministic rule evaluator modeled on Claude Code's
// PreToolUse deny-hook shape: given a proposed tool call and a set of deny rules, it decides allow/block WITHOUT
// executing, intercepting, or mutating anything. There is NO live tool-call interception in this phase — a later
// phase's real coding-agent driver plugs an event source into `evaluateDenyHooks`; this module is only the
// decision function. No IO, no globals, no Date/random: identical inputs always yield the identical verdict.
//
// A rule fires when its tool-name `matcher` matches AND every constraint it declares also matches:
//   - `pathPattern` (a glob) must match some path-shaped string in the tool-call input, and/or
//   - `inputIncludesAll` (substrings) must ALL appear in a single string-shaped input field (e.g. a command).
// A rule with neither constraint fires on the matcher alone. The built-in DEFAULT_DENY_RULES mirror the
// forbidden-path patterns enforced in `scripts/check-mcp-package.mjs` plus a conservative git force-push guard.

/**
 * Compile a glob to an anchored RegExp. `**` matches across path segments (any char incl. `/`); a leading `**​/`
 * also matches zero directories; `*` matches within a single segment (no `/`); every other char is literal. Kept
 * intentionally small — it only needs the shapes the built-in rules use (`.github/workflows/**`, `**​/.env*`,
 * `**​/secret*​/**`, `**​/*private*key*`).
 */
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?"; // '**/' — any (or zero) leading directories
        } else {
          source += ".*"; // '**' — any char, including '/'
        }
      } else {
        source += "[^/]*"; // '*' — any char except '/'
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Collect the string values in a tool-call input (top-level strings and string elements of top-level arrays) so a
 *  rule can test them without hard-coding field names. Non-object input yields no strings (rule can't match). */
function collectInputStrings(input) {
  const strings = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return strings;
  for (const value of Object.values(input)) {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) {
      for (const element of value) if (typeof element === "string") strings.push(element);
    }
  }
  return strings;
}

function matcherMatches(matcher, toolName) {
  if (typeof matcher !== "string") return false;
  return globToRegExp(matcher).test(typeof toolName === "string" ? toolName : "");
}

function ruleMatches(rule, toolName, inputStrings) {
  if (!rule || typeof rule !== "object") return false;
  if (!matcherMatches(rule.matcher, toolName)) return false;
  if (typeof rule.pathPattern === "string") {
    const pattern = globToRegExp(rule.pathPattern);
    if (!inputStrings.some((value) => pattern.test(value))) return false;
  }
  if (Array.isArray(rule.inputIncludesAll)) {
    const needles = rule.inputIncludesAll.filter((needle) => typeof needle === "string");
    if (!inputStrings.some((value) => needles.every((needle) => value.includes(needle)))) return false;
  }
  return true;
}

/**
 * The built-in house-rule deny set — a non-empty starting example a later phase can extend or replace. Mirrors the
 * forbidden-path regex in `scripts/check-mcp-package.mjs` (CI workflows, env files, secret-bearing paths, private
 * key material) and adds a conservative git force-push guard (a command carrying both `push` and `--force`).
 */
export const DEFAULT_DENY_RULES = [
  { matcher: "*", pathPattern: ".github/workflows/**", reason: "Never modify CI workflows (.github/workflows/**)." },
  { matcher: "*", pathPattern: "**/.env*", reason: "Never read or write environment files (.env*)." },
  { matcher: "*", pathPattern: "**/secret*/**", reason: "Never touch secret-bearing paths (**/secret*/**)." },
  { matcher: "*", pathPattern: "**/*private*key*", reason: "Never touch private key material (**/*private*key*)." },
  { matcher: "*", inputIncludesAll: ["push", "--force"], reason: "Never force-push (git push --force)." },
];

/**
 * Evaluate a proposed tool call against deny rules and return the first block, or allow. Pure and side-effect-free
 * — it NEVER runs or intercepts the tool call; a later phase's real hook wiring acts on the verdict. An empty rule
 * set (or a call matching no rule) always allows. Defaults to {@link DEFAULT_DENY_RULES} when no rules are given.
 */
export function evaluateDenyHooks(toolCall, rules = DEFAULT_DENY_RULES) {
  const toolName = toolCall && typeof toolCall === "object" ? toolCall.name : undefined;
  const inputStrings = collectInputStrings(toolCall && typeof toolCall === "object" ? toolCall.input : undefined);
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (ruleMatches(rule, toolName, inputStrings)) return { allowed: false, blockedBy: rule };
  }
  return { allowed: true };
}
