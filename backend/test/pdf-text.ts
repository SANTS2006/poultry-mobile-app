import { spawnSync } from 'child_process';

const SCRIPT = `
const { PDFParse } = require('pdf-parse');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const p = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)) });
    const r = await p.getText();
    await p.destroy();
    process.stdout.write(JSON.stringify({ total: r.total, text: r.text }));
  } catch (e) { process.stderr.write(String(e && e.message)); process.exit(1); }
});`;

/** Reads a PDF the way an independent reader would (pdf.js in a separate Node process, outside Jest's sandbox). */
export function extractPdfText(buf: Buffer): { total: number; text: string } {
  const r = spawnSync(process.execPath, ['-e', SCRIPT], { input: buf, encoding: 'utf8', cwd: __dirname + '/..', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`PDF text extraction failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { total: number; text: string };
}
