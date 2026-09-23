/**
 * The workbook, as the reader sees it.
 *
 * PLAN §6.1: Excel is read cell-by-cell with structure and formulas intact,
 * because a formula like `=D12*1.18` is direct evidence of a markup that a
 * flattened text dump throws away. So every cell keeps its address, its value
 * as the file stores it, and its formula if it has one.
 *
 * Pass one does not need every cell. It needs to find the cover sheet, the
 * summary block, the markup stack and the dates — so the model is given a
 * DIGEST (each sheet's shape, the top of every sheet, and every cell whose
 * label looks like an area, a total, a markup or a date), plus two tools to
 * look further: search for a term, and read a range. The whole workbook stays
 * in memory here so those tools are cheap.
 *
 * SheetJS 0.20.3 from cdn.sheetjs.com, not the npm registry's `xlsx` — that
 * package is frozen at 0.18.5 with published vulnerabilities. A synthetic
 * 15 MB, two-million-cell workbook parses in ~3.5 s at ~580 MB peak RSS, inside
 * a Netlify function's default 1 GB.
 */
import * as XLSX from 'xlsx';

export interface Cell {
  /** A1-style address within its sheet. */
  a: string;
  /** Row and column, zero-based. */
  r: number;
  c: number;
  /** The value as stored: number, string, boolean, or a date as ISO text. */
  v: string | number | boolean | null;
  /** Formula without the leading '=', when the cell has one. */
  f?: string;
}

export interface Sheet {
  name: string;
  hidden: boolean;
  /** The used range as the file declares it, e.g. "A1:H240". */
  ref: string | null;
  rows: number;
  cols: number;
  cells: Cell[];
  /** Index into `cells` of each row's first cell. Cells are row-major. */
  rowStart: Map<number, number>;
  merges: string[];
}

export interface Workbook {
  sheets: Sheet[];
  cellCount: number;
  formulaCount: number;
}

/** Hard caps on what any one digest or tool call can return. */
export const LIMITS = {
  digestChars: 160_000,
  headRows: 45,
  headCols: 14,
  keywordHits: 220,
  formulaSamples: 80,
  searchResults: 60,
  rangeCells: 600,
} as const;

function cellValue(cell: XLSX.CellObject): Cell['v'] {
  if (cell.v === undefined || cell.v === null) return null;
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  if (typeof cell.v === 'number' || typeof cell.v === 'string' || typeof cell.v === 'boolean') {
    return cell.v;
  }
  return String(cell.v);
}

export function parseWorkbook(data: Uint8Array): Workbook {
  const wb = XLSX.read(data, {
    type: 'array',
    cellFormula: true,
    cellDates: true,
    cellStyles: false,
    cellHTML: false,
    cellText: false,
    dense: true,
  });

  const sheets: Sheet[] = [];
  let cellCount = 0;
  let formulaCount = 0;

  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name] as XLSX.WorkSheet & { '!data'?: (XLSX.CellObject | undefined)[][] };
    const hidden = Boolean(wb.Workbook?.Sheets?.[i]?.Hidden);
    const ref = ws['!ref'] ?? null;
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    const cells: Cell[] = [];
    const rowStart = new Map<number, number>();
    const data = ws['!data'] ?? [];

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell) continue;
        const v = cellValue(cell);
        const f = typeof cell.f === 'string' && cell.f.length > 0 ? cell.f : undefined;
        if (v === null && !f) continue;
        if (!rowStart.has(r)) rowStart.set(r, cells.length);
        cells.push({ a: XLSX.utils.encode_cell({ r, c }), r, c, v, ...(f ? { f } : {}) });
        if (f) formulaCount++;
      }
    }

    cellCount += cells.length;
    sheets.push({
      name,
      hidden,
      ref,
      rows: range ? range.e.r + 1 : 0,
      cols: range ? range.e.c + 1 : 0,
      cells,
      rowStart,
      merges: (ws['!merges'] ?? []).slice(0, 200).map((m) => XLSX.utils.encode_range(m)),
    });
  });

  return { sheets, cellCount, formulaCount };
}

/** One cell as the model sees it: `Summary!B4 = 62400` or `… = 1234.5 {=D12*1.18}`. */
export function renderCell(sheet: string, cell: Cell): string {
  const v =
    cell.v === null
      ? '(blank)'
      : typeof cell.v === 'string'
        ? JSON.stringify(cell.v.length > 160 ? cell.v.slice(0, 160) + '…' : cell.v)
        : String(cell.v);
  return `${quoteSheet(sheet)}!${cell.a} = ${v}${cell.f ? ` {=${cell.f}}` : ''}`;
}

function quoteSheet(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * Labels that tend to sit next to the facts pass one needs. Deliberately broad:
 * a false hit costs a line in the digest, a miss costs a wrong frame.
 */
const KEYWORDS: Array<[string, RegExp]> = [
  ['area', /\b(g\.?s\.?f|gross|area|sq\.?\s*f(ee)?t|square\s+f(ee|oo)t|\bsf\b|\bgfa\b)/i],
  ['total', /\b(total|grand\s+total|project\s+cost|construction\s+cost|estimated\s+cost|tcc|budget)\b/i],
  ['markup', /\b(markup|mark-up|fee|overhead|o\s*&\s*p|profit|general\s+conditions|general\s+requirements|gc'?s?\b|contingenc|bond|insurance|b&o|sales\s+tax|design\s+contingency|escalation)/i],
  ['date', /\b(date|dated|priced|pricing|base|midpoint|mid-point|as\s+of|q[1-4]\s*\d{2,4}|escalat)/i],
  ['coding', /\b(uniformat|masterformat|division|csi|element|system|trade)\b/i],
  ['type', /\b(estimate\s+review|review\s+of|reconciliation|rom|rough\s+order|cost\s+plan|cost\s+report|estimate)\b/i],
];

/** Formulas that multiply by a constant or by (1 + something) — markup evidence. */
const MARKUP_FORMULA = /\*\s*\(?\s*1\s*\+|\*\s*1\.\d+|\*\s*\d*\.\d+\s*%?|\*\s*\(\s*1\s*\+/;

function rowContext(sheet: Sheet, row: number, limit = 10): Cell[] {
  const start = sheet.rowStart.get(row);
  if (start === undefined) return [];
  const out: Cell[] = [];
  for (let i = start; i < sheet.cells.length && sheet.cells[i].r === row && out.length < limit; i++) {
    out.push(sheet.cells[i]);
  }
  return out;
}

/**
 * The digest the model reads before it calls any tool.
 *
 * Order matters for prompt caching and for the model: shape first, then the
 * top of each sheet (cover and summary blocks live there), then the labelled
 * cells, then markup-shaped formulas. Everything is capped; a cap that bites
 * says so in the text, so the model knows to search rather than assume.
 */
export function buildDigest(wb: Workbook): string {
  const parts: string[] = [];
  let budget: number = LIMITS.digestChars;
  const push = (s: string) => {
    if (budget <= 0) return false;
    const chunk = s.length > budget ? s.slice(0, budget) + '\n[digest truncated — use search_workbook]' : s;
    parts.push(chunk);
    budget -= chunk.length;
    return budget > 0;
  };

  push(
    `WORKBOOK: ${wb.sheets.length} sheets, ${wb.cellCount} non-empty cells, ${wb.formulaCount} formulas.\n` +
      wb.sheets
        .map(
          (s, i) =>
            `  ${i + 1}. ${quoteSheet(s.name)}${s.hidden ? ' (hidden)' : ''} — range ${s.ref ?? 'empty'}, ` +
            `${s.cells.length} cells, ${s.cells.filter((c) => c.f).length} formulas` +
            (s.merges.length ? `, ${s.merges.length} merged ranges` : '')
        )
        .join('\n')
  );

  push('\nTOP OF EACH SHEET (first rows and columns; blanks omitted):');
  for (const s of wb.sheets) {
    const head = s.cells.filter((c) => c.r < LIMITS.headRows && c.c < LIMITS.headCols);
    if (head.length === 0) continue;
    if (!push(`\n--- ${quoteSheet(s.name)} ---\n` + head.map((c) => renderCell(s.name, c)).join('\n'))) break;
  }

  push('\nLABELLED CELLS ANYWHERE (label, then the rest of its row):');
  let hits = 0;
  outer: for (const s of wb.sheets) {
    for (const cell of s.cells) {
      if (typeof cell.v !== 'string' || cell.r < LIMITS.headRows && cell.c < LIMITS.headCols) continue;
      const kinds = KEYWORDS.filter(([, re]) => re.test(cell.v as string)).map(([k]) => k);
      if (kinds.length === 0) continue;
      const row = rowContext(s, cell.r).filter((c) => c.a !== cell.a);
      const line =
        `[${kinds.join(',')}] ${renderCell(s.name, cell)}` +
        (row.length ? `\n    row: ${row.map((c) => renderCell(s.name, c)).join(' | ')}` : '');
      if (!push('\n' + line)) break outer;
      if (++hits >= LIMITS.keywordHits) {
        push(`\n[stopped at ${LIMITS.keywordHits} labelled cells — use search_workbook for more]`);
        break outer;
      }
    }
  }

  push('\nFORMULAS THAT MULTIPLY BY A CONSTANT OR (1+x) — possible markups:');
  let samples = 0;
  outer2: for (const s of wb.sheets) {
    for (const cell of s.cells) {
      if (!cell.f || !MARKUP_FORMULA.test(cell.f)) continue;
      if (!push('\n' + renderCell(s.name, cell))) break outer2;
      if (++samples >= LIMITS.formulaSamples) {
        push(`\n[stopped at ${LIMITS.formulaSamples} formulas]`);
        break outer2;
      }
    }
  }
  if (samples === 0) push('\n(none found)');

  return parts.join('');
}

/** search_workbook: case-insensitive substring over values and formulas. */
export function searchWorkbook(wb: Workbook, query: string, sheetName?: string): string {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return 'Query too short — give at least two characters.';
  const out: string[] = [];
  for (const s of wb.sheets) {
    if (sheetName && s.name !== sheetName) continue;
    for (const cell of s.cells) {
      const inValue = cell.v !== null && String(cell.v).toLowerCase().includes(q);
      const inFormula = cell.f?.toLowerCase().includes(q) ?? false;
      if (!inValue && !inFormula) continue;
      const row = rowContext(s, cell.r, 8).filter((c) => c.a !== cell.a);
      out.push(
        renderCell(s.name, cell) + (row.length ? `\n    row: ${row.map((c) => renderCell(s.name, c)).join(' | ')}` : '')
      );
      if (out.length >= LIMITS.searchResults) {
        out.push(`[stopped at ${LIMITS.searchResults} matches — narrow the query or name a sheet]`);
        return out.join('\n');
      }
    }
  }
  return out.length ? out.join('\n') : `No cell contains "${query}".`;
}

/** read_range: every non-empty cell in an A1 range on one sheet. */
export function readRange(wb: Workbook, sheetName: string, range: string): string {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  if (!sheet) return `No sheet named "${sheetName}". Sheets: ${wb.sheets.map((s) => s.name).join(', ')}`;
  let r: XLSX.Range;
  try {
    r = XLSX.utils.decode_range(range.replace(/\$/g, ''));
  } catch {
    return `"${range}" is not an A1 range like "A1:H40".`;
  }
  if (r.s.r < 0 || r.s.c < 0 || r.e.r < r.s.r || r.e.c < r.s.c) return `"${range}" is not a valid range.`;
  const out: string[] = [];
  let from = sheet.cells.length;
  for (let row = r.s.r; row <= Math.min(r.e.r, sheet.rows); row++) {
    const i = sheet.rowStart.get(row);
    if (i !== undefined) {
      from = i;
      break;
    }
  }
  for (let i = from; i < sheet.cells.length; i++) {
    const cell = sheet.cells[i];
    if (cell.r > r.e.r) break;
    if (cell.c < r.s.c || cell.c > r.e.c) continue;
    out.push(renderCell(sheet.name, cell));
    if (out.length >= LIMITS.rangeCells) {
      out.push(`[stopped at ${LIMITS.rangeCells} cells — read a smaller range]`);
      break;
    }
  }
  return out.length ? out.join('\n') : `No non-empty cells in ${range}.`;
}
