// Pure, dependency-free monospace table renderer shared by the stdio CLI's report-shaped commands
// (#2231). Kept in lib/ (not the bin) so it can be unit-tested in isolation: the bin auto-runs its
// CLI/MCP entrypoint on import, so importable helpers live here instead.

export type FormatTableAlign = "left" | "right";

export type FormatTableHeader =
  | string
  | {
      key: string;
      label?: string;
      align?: FormatTableAlign;
    };

export type FormatTableRow = Record<string, unknown> | unknown[];

export type FormatTableInput =
  | FormatTableRow[]
  | {
      headers?: FormatTableHeader[];
      rows?: FormatTableRow[];
    };

export type FormatTableOptions = {
  align?: Record<string, FormatTableAlign | undefined>;
  gap?: number;
};

type NormalizedHeader = { key: string; label: string; align?: FormatTableAlign };

// Normalize either an array of row objects or an explicit { headers, rows } shape into a common
// { headers, rows } form. For an array of objects the column set is the union of keys in first-seen
// order, and each key doubles as its own header label.
function normalizeInput(input: FormatTableInput): { headers: NormalizedHeader[]; rows: FormatTableRow[] } {
  if (Array.isArray(input)) {
    const keys: string[] = [];
    for (const row of input) {
      if (!row || Array.isArray(row) || typeof row !== "object") continue;
      for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
    }
    return { headers: keys.map((key) => ({ key, label: key })), rows: input };
  }
  const headers = (input.headers ?? []).map((header): NormalizedHeader =>
    typeof header === "string"
      ? { key: header, label: header }
      : { key: header.key, label: header.label ?? header.key, ...(header.align !== undefined ? { align: header.align } : {}) },
  );
  return { headers, rows: input.rows ?? [] };
}

function stringifyCell(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

// A row is either an object keyed by column key or a positional array; read the matching cell.
function readCell(row: FormatTableRow, header: NormalizedHeader, columnIndex: number): unknown {
  if (Array.isArray(row)) return row[columnIndex];
  return row[header.key];
}

function resolveAlign(header: NormalizedHeader, opts: FormatTableOptions): FormatTableAlign {
  const fromOpts = opts.align && (opts.align[header.key] ?? opts.align[header.label]);
  return header.align ?? fromOpts ?? "left";
}

/**
 * Render tabular data as an aligned, monospace plain-text table (header row + one line per row).
 * Accepts an array of row objects, or `{ headers, rows }` with string/`{ key, label, align }`
 * headers and object/array rows. `opts.align` maps a column key/label to `"left"`|`"right"`;
 * `opts.gap` sets the space count between columns (default 2). Pure — no I/O, no dependencies.
 * Returns "" when there are no columns.
 */
export function formatTable(input: FormatTableInput, opts: FormatTableOptions = {}): string {
  const { headers, rows } = normalizeInput(input);
  if (headers.length === 0) return "";
  const gap = " ".repeat(Math.max(1, opts.gap ?? 2));
  const aligns = headers.map((header) => resolveAlign(header, opts));
  // Precompute every cell's text so column widths and the rendered rows read the same strings.
  const bodyCells = rows.map((row) => headers.map((header, column) => stringifyCell(readCell(row, header, column))));
  const widths = headers.map((header, column) =>
    Math.max(header.label.length, ...bodyCells.map((cells) => cells[column]?.length ?? 0), 0),
  );
  // Trim trailing padding so a left-aligned final column never emits dangling spaces.
  const renderRow = (cells: string[]) =>
    cells
      .map((text, column) => (aligns[column] === "right" ? text.padStart(widths[column] ?? 0) : text.padEnd(widths[column] ?? 0)))
      .join(gap)
      .replace(/\s+$/, "");
  return [renderRow(headers.map((header) => header.label)), ...bodyCells.map(renderRow)].join("\n");
}
