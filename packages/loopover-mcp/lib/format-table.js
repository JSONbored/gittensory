// Pure, dependency-free monospace table renderer shared by the stdio CLI's report-shaped commands
// (#2231). Kept in lib/ (not the bin) so it can be unit-tested in isolation: the bin auto-runs its
// CLI/MCP entrypoint on import, so importable helpers live here instead.
// Normalize either an array of row objects or an explicit { headers, rows } shape into a common
// { headers, rows } form. For an array of objects the column set is the union of keys in first-seen
// order, and each key doubles as its own header label.
function normalizeInput(input) {
    if (Array.isArray(input)) {
        const keys = [];
        for (const row of input) {
            if (!row || Array.isArray(row) || typeof row !== "object")
                continue;
            for (const key of Object.keys(row))
                if (!keys.includes(key))
                    keys.push(key);
        }
        return { headers: keys.map((key) => ({ key, label: key })), rows: input };
    }
    const headers = (input.headers ?? []).map((header) => typeof header === "string"
        ? { key: header, label: header }
        : { key: header.key, label: header.label ?? header.key, ...(header.align !== undefined ? { align: header.align } : {}) });
    return { headers, rows: input.rows ?? [] };
}
function stringifyCell(value) {
    return value === undefined || value === null ? "" : String(value);
}
// A row is either an object keyed by column key or a positional array; read the matching cell.
function readCell(row, header, columnIndex) {
    if (Array.isArray(row))
        return row[columnIndex];
    return row[header.key];
}
function resolveAlign(header, opts) {
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
export function formatTable(input, opts = {}) {
    const { headers, rows } = normalizeInput(input);
    if (headers.length === 0)
        return "";
    const gap = " ".repeat(Math.max(1, opts.gap ?? 2));
    const aligns = headers.map((header) => resolveAlign(header, opts));
    // Precompute every cell's text so column widths and the rendered rows read the same strings.
    const bodyCells = rows.map((row) => headers.map((header, column) => stringifyCell(readCell(row, header, column))));
    const widths = headers.map((header, column) => Math.max(header.label.length, ...bodyCells.map((cells) => cells[column]?.length ?? 0), 0));
    // Trim trailing padding so a left-aligned final column never emits dangling spaces.
    const renderRow = (cells) => cells
        .map((text, column) => (aligns[column] === "right" ? text.padStart(widths[column] ?? 0) : text.padEnd(widths[column] ?? 0)))
        .join(gap)
        .replace(/\s+$/, "");
    return [renderRow(headers.map((header) => header.label)), ...bodyCells.map(renderRow)].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZm9ybWF0LXRhYmxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZm9ybWF0LXRhYmxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGtHQUFrRztBQUNsRyxtR0FBbUc7QUFDbkcseUVBQXlFO0FBNEJ6RSxnR0FBZ0c7QUFDaEcsb0dBQW9HO0FBQ3BHLHVEQUF1RDtBQUN2RCxTQUFTLGNBQWMsQ0FBQyxLQUF1QjtJQUM3QyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6QixNQUFNLElBQUksR0FBYSxFQUFFLENBQUM7UUFDMUIsS0FBSyxNQUFNLEdBQUcsSUFBSSxLQUFLLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUMsR0FBRyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUTtnQkFBRSxTQUFTO1lBQ3BFLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7Z0JBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDO29CQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDOUUsQ0FBQztRQUNELE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEdBQUcsRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUM1RSxDQUFDO0lBQ0QsTUFBTSxPQUFPLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBb0IsRUFBRSxDQUNyRSxPQUFPLE1BQU0sS0FBSyxRQUFRO1FBQ3hCLENBQUMsQ0FBQyxFQUFFLEdBQUcsRUFBRSxNQUFNLEVBQUUs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RUFBRSxFQUFFLENBQ3BDLEtBQUs7U0FDRixHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQzNILElBQUksQ0FBQyxHQUFHLENBQUM7U0FDVCxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3pCLE9BQU8sQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3BHLENBQUMifQ==