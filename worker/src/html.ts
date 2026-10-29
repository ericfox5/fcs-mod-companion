// Tiny HTML helpers: tagged template that escapes interpolations unless wrapped in raw().
export class Raw { constructor(public readonly html: string) {} toString() { return this.html; } }
export const raw = (s: string) => new Raw(s);

export function esc(v: unknown): string {
  if (v instanceof Raw) return v.html;
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      out += Array.isArray(v) ? v.map(esc).join('') : esc(v);
    }
  });
  return new Raw(out);
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

export const page = (body: Raw, status = 200, headers: Record<string, string> = {}) =>
  new Response(body.html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

export const notFound = (msg = 'Not found') => new Response(msg, { status: 404 });
