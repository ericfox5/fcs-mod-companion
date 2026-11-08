// The swap tool's local web UI: serves the page (installer/src/swap-ui.html, bundled into FCS-online.exe) and its JSON
// API on 127.0.0.1. GET /api/state, GET /api/donor/:tgid, GET /api/logo/(cfbr|install)/:index, POST /api/swap
// {slot, donor}, POST /api/restore {slot}. Swaps run synchronously (seconds); the page shows a busy state meanwhile.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SwapTool } from './swap.js';

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((ok, fail) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } }); req.on('error', fail); });

export function startSwapServer(tool: SwapTool, page: string, port = 0): Promise<{ url: string; close: () => void }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        let running = false; try { running = tool.running(); } catch { /* tasklist unavailable */ }
        json(res, 200, { install: { rpcs3: tool.env.rpcs3, running }, cfbr: tool.cfbrStatus(), slots: tool.slots(), donors: tool.donors() }); return;
      }
      const d = /^\/api\/donor\/(\d+)$/.exec(url.pathname); if (req.method === 'GET' && d) { json(res, 200, tool.donor(Number(d[1]))); return; }
      const l = /^\/api\/logo\/(cfbr|install)\/(\d+)(?:\.png)?$/.exec(url.pathname);
      if (req.method === 'GET' && l) { const png = tool.logo(l[1] as 'cfbr' | 'install', Number(l[2])); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': l[1] === 'cfbr' ? 'max-age=3600' : 'no-store' }); res.end(png); return; }
      if (req.method === 'POST' && url.pathname === '/api/swap') { const b = await readBody(req); const steps = tool.apply(Number(b.slot), Number(b.donor)); json(res, 200, { ok: steps.every((s) => s.status !== 'error'), steps }); return; }
      if (req.method === 'POST' && url.pathname === '/api/restore') { const b = await readBody(req); const steps = tool.restore(Number(b.slot)); json(res, 200, { ok: steps.every((s) => s.status !== 'error'), steps }); return; }
      json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (e) { json(res, 500, { error: (e as Error).message }); }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => { const a = server.address(); const p = typeof a === 'object' && a ? a.port : port; ok({ url: `http://127.0.0.1:${p}/`, close: () => server.close() }); }));
}
