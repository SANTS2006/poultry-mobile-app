/**
 * Exact money arithmetic on integer cents (BigInt). Used ONLY for previews on the phone ("about NLe 3,100.00"): the server prices every sale
 * itself and its figure is the one that counts.
 */
export function toCents(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a money amount: ${value}`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export interface PreviewLine { unit: string; quantity: number; unitPrice: string | undefined }

/** Estimated sale total from cached prices. `missing` lists units with no known price (the total is then incomplete). */
export function previewSale(lines: PreviewLine[], discount = '0'): { subtotal: string; total: string; missing: string[] } {
  let subtotal = 0n;
  const missing: string[] = [];
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    if (l.unitPrice === undefined) { missing.push(l.unit); continue; }
    subtotal += toCents(l.unitPrice) * BigInt(l.quantity);
  }
  let d = 0n;
  try { d = toCents(discount || '0'); } catch { d = 0n; }
  const total = subtotal - d;
  return { subtotal: fromCents(subtotal), total: fromCents(total < 0n ? 0n : total), missing };
}

/** eggs from unit quantities using the cached unit table */
export function eggsOf(lines: { unit: string; quantity: number }[], unitEggs: Record<string, number>): number {
  return lines.reduce((a, l) => a + l.quantity * (unitEggs[l.unit] ?? 0), 0);
}
