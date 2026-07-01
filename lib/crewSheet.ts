/**
 * Pure parsing of the committed field-ops crew sheet snapshot
 * (reports/drive/field-ops-crew.csv) into per-day crew. No DB/Next imports —
 * unit-tested. The DB write (roster_corrections, source "field-ops-sheet") lives
 * in scripts/field-crew.ts.
 *
 * Row→person mapping is an EXPLICIT, auditable table (like lib/people.ts /
 * lib/approvers.ts) — never fuzzy name-matching, which silently mis-joins people
 * ([[distrust-human-written-content]]). Rows not in the map (metric rows, section
 * headers, unknown people) are ignored, not guessed. A person marked in EITHER
 * "Льотна пара" block counts for the day (union).
 */

/** RFC-4180 CSV tokenizer: quotes, "" escapes, embedded commas/newlines, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; }
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  // Trailing field/row (no final newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Explicit sheet-label → canonical short roster name (matches SEED_ALIASES). */
export const SHEET_CREW_ROWS: Record<string, string> = {
  "Олександр Книга": "Олександр",
  "Любомир Заяць": "Любомир",
  "Тарас Панасюк": "Тарас",
  "Андріан Корчинський": "Андріан",
  "Владислав Ляшко": "Влад",
  Влад: "Влад",
  Констянтин: "Констянтин",
  "Володимир Павликевич": "Володимир",
  "Данило Томаши": "Данило",
  "Богдан Форостяний": "Богдан",
  "Надія Хасишин": "Надія",
  "Сергій Шайнюк": "Сергій",
  // Олександр Сорока (a developer) is intentionally NOT mapped to "Олександр"
  // to avoid colliding with Олександр Книга; add explicitly if he ever flies.
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Map each YYYY-MM-DD column to the sorted, deduped crew marked present that day. */
export function crewByDate(rows: string[][]): Map<string, string[]> {
  const header = rows[0] ?? [];
  const dateCols: { col: number; date: string }[] = [];
  header.forEach((cell, col) => {
    const d = norm(cell);
    if (DATE_RE.test(d)) dateCols.push({ col, date: d });
  });

  const byDate = new Map<string, Set<string>>();
  for (const r of rows.slice(1)) {
    const name = SHEET_CREW_ROWS[norm(r[0] ?? "")];
    if (!name) continue; // unmapped row (metric / header / unknown) — ignore
    for (const { col, date } of dateCols) {
      if ((r[col] ?? "").trim().startsWith("+")) {
        if (!byDate.has(date)) byDate.set(date, new Set());
        byDate.get(date)!.add(name);
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [date, set] of byDate) out.set(date, [...set].sort());
  return out;
}
