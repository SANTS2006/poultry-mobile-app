/**
 * One branded layout for every e-mail the system sends. Inline CSS and tables only (mail clients ignore most modern CSS), no remote
 * images (many clients block them), and a plain-text twin for every message.
 */
export interface Brand { businessName: string; systemName: string }

export interface EmailContent {
  /** Short line shown in the inbox preview. */
  preheader: string;
  heading: string;
  greeting?: string;
  paragraphs: string[];
  /** A boxed list of facts (account, role, temporary password…). */
  details?: { label: string; value: string; emphasis?: boolean }[];
  button?: { label: string; url: string };
  /** Numbered steps, shown after the details. */
  steps?: string[];
  /** Small print under the card (why you got this, what to do if it was not you). */
  note?: string;
}

const GREEN = '#0B6B3A';
const AMBER = '#F2B33D';
const INK = '#12201A';
const MUTED = '#5C6B62';

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'P';

export function renderEmail(brand: Brand, c: EmailContent): { html: string; text: string } {
  const e = escapeHtml;
  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#F5F7F4;border-radius:12px;border:1px solid #E0E6E1">${c.details.map((d, i) => `
        <tr><td style="padding:12px 16px;${i ? 'border-top:1px solid #E0E6E1;' : ''}">
          <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED}">${e(d.label)}</div>
          <div style="font-size:${d.emphasis ? '20px' : '16px'};font-weight:${d.emphasis ? 700 : 600};color:${INK};${d.emphasis ? "font-family:Consolas,'Courier New',monospace;letter-spacing:.04em;" : ''}word-break:break-word">${e(d.value)}</div>
        </td></tr>`).join('')}
      </table>` : '';
  const steps = c.steps?.length
    ? `<ol style="margin:16px 0 0;padding-left:20px;color:${INK};font-size:15px;line-height:24px">${c.steps.map((s) => `<li style="margin-bottom:6px">${e(s)}</li>`).join('')}</ol>` : '';
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="background:${GREEN};border-radius:999px"><a href="${e(c.button.url)}" style="display:inline-block;padding:14px 28px;color:#FFFFFF;font-size:16px;font-weight:600;text-decoration:none">${e(c.button.label)}</a></td></tr></table>` : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(c.heading)}</title></head>
<body style="margin:0;padding:0;background:#EEF2EE;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2EE"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="background:${GREEN};border-radius:20px 20px 0 0;padding:28px 24px;text-align:center">
      <div style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:18px;background:${AMBER};color:#2B1D00;font-size:22px;font-weight:800">${e(initials(brand.businessName))}</div>
      <div style="margin-top:12px;font-size:20px;font-weight:700;color:#FFFFFF">${e(brand.businessName)}</div>
      <div style="font-size:13px;color:#CFE8DA">${e(brand.systemName)}</div>
    </td></tr>
    <tr><td style="background:#FFFFFF;padding:28px 24px;border-radius:0 0 20px 20px">
      <h1 style="margin:0 0 12px;font-size:22px;line-height:28px;color:${INK}">${e(c.heading)}</h1>
      ${c.greeting ? `<p style="margin:0 0 12px;font-size:16px;line-height:24px">${e(c.greeting)}</p>` : ''}
      ${c.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:24px">${e(p)}</p>`).join('')}
      ${details}${steps}${button}
    </td></tr>
    <tr><td style="padding:16px 12px;text-align:center;font-size:12px;line-height:18px;color:${MUTED}">
      ${c.note ? `${e(c.note)}<br><br>` : ''}Sent by ${e(brand.systemName)} for ${e(brand.businessName)}. Please do not reply to this message.
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    c.heading, '', c.greeting, ...c.paragraphs.flatMap((p) => [p, '']),
    ...(c.details ?? []).map((d) => `${d.label}: ${d.value}`), ...(c.details?.length ? [''] : []),
    ...(c.steps ?? []).map((s, i) => `${i + 1}. ${s}`), ...(c.steps?.length ? [''] : []),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ''] : []),
    ...(c.note ? [c.note, ''] : []),
    `— ${brand.businessName} · ${brand.systemName}`,
  ].filter((l): l is string => l !== undefined).join('\n');
  return { html, text };
}
