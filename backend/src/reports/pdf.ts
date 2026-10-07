import PDFDocument from 'pdfkit';
import type { Cell, Column, ReportResult, Table } from './report.types';

const MARGIN = 36;
const ROW_H = 15;
const HEAD_H = 20;

function fmt(v: Cell | undefined, type: Column['type']): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'int' && typeof v === 'number') return v.toLocaleString('en-US');
  if (type === 'money' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
    const neg = v.startsWith('-');
    const [i, f] = v.replace('-', '').split('.');
    return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(f ?? '00').padEnd(2, '0')}`;
  }
  if (type === 'percent') return `${v}%`;
  return String(v);
}

/** Simple, dependable PDF: title, filters, summary, then each table with a repeating header row, zebra rows and page numbers. */
export function toPdf(result: ReportResult, generatedBy: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: result.meta.title, Author: 'Makarifor Agriculture', Producer: 'Makarifor' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - 18;

  doc.font('Helvetica-Bold').fontSize(16).text(result.meta.title);
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text(`Period: ${result.meta.from} to ${result.meta.to}   •   Grouped by ${result.meta.groupBy}   •   Currency: ${result.meta.currency}`)
    .text(`Generated ${result.meta.generatedAt.replace('T', ' ').slice(0, 16)} UTC by ${generatedBy}`);
  const filters = Object.entries(result.meta.filters);
  if (filters.length) doc.text(`Filters: ${filters.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
  doc.fillColor('#000').moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(11).text('Summary');
  doc.font('Helvetica').fontSize(9);
  const entries = Object.entries(result.summary);
  const colW = width / 3;
  let rowY = doc.y;
  entries.forEach(([k, v], i) => {
    if (i % 3 === 0 && i > 0) rowY += 13;
    const shown = v === null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
    doc.text(`${k}: ${shown}`, MARGIN + (i % 3) * colW, rowY, { width: colW - 8, lineBreak: false, ellipsis: true });
  });
  doc.x = MARGIN;
  doc.y = rowY + 16;
  for (const n of result.meta.notes) { doc.moveDown(0.3).fontSize(8).fillColor('#7a4b00').text(`Note: ${n}`, MARGIN, doc.y, { width }); }
  doc.fillColor('#000');

  for (const t of result.tables) drawTable(doc, t, width, bottom);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // otherwise PDFKit adds a blank page for text that touches the bottom margin
    doc.font('Helvetica').fontSize(8).fillColor('#666')
      .text(`${result.meta.title} — Makarifor Agriculture   •   Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - 26, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

function drawTable(doc: PDFKit.PDFDocument, t: Table, width: number, bottom: () => number): void {
  const rowsNeeded = 3;
  if (doc.y + HEAD_H + ROW_H * rowsNeeded > bottom()) doc.addPage();
  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(11).fillColor('#000').text(t.title, MARGIN, doc.y);
  const widths = columnWidths(t, width);
  const x0 = MARGIN;
  const header = () => {
    const y = doc.y + 2;
    doc.rect(x0, y, width, HEAD_H).fill('#e8eef4').fillColor('#000');
    let x = x0;
    t.columns.forEach((c, i) => { doc.font('Helvetica-Bold').fontSize(8).text(c.label, x + 3, y + 6, { width: widths[i] - 6, align: align(c), lineBreak: false, ellipsis: true }); x += widths[i]; });
    doc.y = y + HEAD_H;
  };
  header();
  const drawRow = (cells: Record<string, Cell>, bold: boolean, zebra: boolean) => {
    if (doc.y + ROW_H > bottom()) { doc.addPage(); header(); }
    const y = doc.y;
    if (zebra) doc.rect(x0, y, width, ROW_H).fill('#f7f9fb').fillColor('#000');
    let x = x0;
    t.columns.forEach((c, i) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).text(fmt(cells[c.key], c.type), x + 3, y + 4, { width: widths[i] - 6, align: align(c), lineBreak: false, ellipsis: true }); x += widths[i]; });
    doc.y = y + ROW_H;
  };
  if (t.rows.length === 0) { doc.font('Helvetica-Oblique').fontSize(8).text('No data for this period.', x0 + 3, doc.y + 4); doc.y += ROW_H; }
  t.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
  if (t.totals) drawRow(t.totals, true, false);
  doc.x = MARGIN;
}

const align = (c: Column): 'left' | 'right' => (c.type === 'text' || c.type === 'date' ? 'left' : 'right');

/** Wider columns for text, narrower for numbers; always sums to the page width. */
function columnWidths(t: Table, total: number): number[] {
  const weight = t.columns.map((c) => {
    const longest = Math.max(c.label.length, ...t.rows.slice(0, 200).map((r) => String(r[c.key] ?? '').length));
    return Math.min(Math.max(longest, 6), c.type === 'text' ? 40 : 16);
  });
  const sum = weight.reduce((a, b) => a + b, 0);
  return weight.map((w) => (w / sum) * total);
}
