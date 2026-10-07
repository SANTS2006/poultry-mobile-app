import * as ExcelJS from 'exceljs';

/** Read-only view of a worksheet: cached values plus formula text, so the importer can audit formulas without recalculating. */
export interface Cell {
  addr: string;
  value: string | number | boolean | Date | null;
  formula: string | null;
}

export class Sheet {
  constructor(readonly name: string, private readonly ws: ExcelJS.Worksheet) {}

  get rowCount(): number { return this.ws.rowCount; }

  cell(row: number, col: number): Cell {
    const c = this.ws.getCell(row, col);
    const raw = c.value as unknown;
    let value: Cell['value'] = null;
    let formula: string | null = null;
    if (raw !== null && raw !== undefined && typeof raw === 'object' && !(raw instanceof Date)) {
      const o = raw as { formula?: string; sharedFormula?: string; result?: unknown; richText?: { text: string }[]; text?: string; error?: string };
      if (o.richText) value = o.richText.map((r) => r.text).join('');
      else if (o.formula !== undefined || o.sharedFormula !== undefined) {
        formula = o.formula ?? o.sharedFormula ?? null;
        const r = o.result;
        value = typeof r === 'number' || typeof r === 'string' || typeof r === 'boolean' || r instanceof Date ? r : null;
      } else if (o.text !== undefined) value = o.text;
      else if (o.error) value = null;
    } else {
      value = raw as Cell['value'];
    }
    if (typeof value === 'string' && value.trim() === '') value = null;
    return { addr: c.address, value, formula };
  }

  at(row: number, colLetter: string): Cell {
    return this.cell(row, columnIndex(colLetter));
  }
}

export function columnIndex(letters: string): number {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function readWorkbook(path: string): Promise<Map<string, Sheet>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path); // read only; this tool never writes to the source file
  const sheets = new Map<string, Sheet>();
  for (const ws of wb.worksheets) sheets.set(ws.name, new Sheet(ws.name, ws));
  return sheets;
}

/** Excel dates are UTC-midnight instants; keep them as calendar dates (no time-zone shifting). */
export function toIsoDate(v: Cell['value']): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}
