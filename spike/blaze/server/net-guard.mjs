// Small, dependency-free guards for the public listeners: per-address connection caps, sliding-window rate limits,
// bounded HTTP bodies and socket timeouts. Everything here is in-memory and self-pruning.

// IPv4-mapped IPv6 ("::ffff:1.2.3.4") and plain IPv4 are the same client.
export const clientIp = (addr) => String(addr ?? 'unknown').replace(/^::ffff:/i, '');

// At most `limit` events per `windowMs` for each key. hit() records an event and says whether it is allowed.
//
// Cost: every call is a constant amount of work, whatever the table holds. Entries are kept in the order their
// window started, so the expired ones are always at the front: each call removes at most a few of them (and a timer
// removes the rest while nothing is calling). When the table is full of live entries a NEW key is refused at once,
// without being stored and without scanning anything: a flood from many (or forged) addresses cannot make the
// limiter itself the expensive part, and cannot push out the entries of addresses already being counted.
// `refusedNew` counts those refusals.
export function createRateLimiter({ limit, windowMs, maxKeys = 50000, now = Date.now, sweepMs = Math.min(Math.max(windowMs, 1000), 60000) }) {
  const hits = new Map(); // key -> { start, count }, oldest window first
  let refusedNew = 0;
  const expire = (t, steps) => {
    for (const [k, v] of hits) { if (steps-- <= 0 || t - v.start < windowMs) break; hits.delete(k); }
  };
  if (sweepMs > 0) { const timer = setInterval(() => expire(now(), 2000), sweepMs); timer.unref?.(); }
  // The entry to count against, or null when the key is new and there is no room for it.
  const entry = (key, t) => {
    let e = hits.get(key);
    if (e && t - e.start < windowMs) return e;
    expire(t, 4);
    if (e) hits.delete(key); // window over: start again at the back of the line
    else if (hits.size >= maxKeys) { refusedNew++; return null; }
    e = { start: t, count: 0 }; hits.set(key, e);
    return e;
  };
  return {
    hit(key) { const e = entry(key, now()); if (!e) return false; e.count++; return e.count <= limit; },
    // Over the limit, or unknown while the table is full (the same answer hit() would give).
    blocked(key) {
      const t = now(), e = hits.get(key);
      if (e && t - e.start < windowMs) return e.count >= limit;
      if (e || hits.size < maxKeys) return false; // a key whose window is over starts again: it has its place
      expire(t, 4);
      return hits.size >= maxKeys;
    },
    reset(key) { hits.delete(key); },
    get size() { return hits.size; },
    get refusedNew() { return refusedNew; },
  };
}

// Log lines an outsider can cause (a refused packet, a failed sign-in, a refused connection) are limited per key
// (the client address): the first `perWindow` in a window are written, the rest are counted, and the next line
// written for that key says how many were left out. write(key, text) returns true when the line was written.
export function createLogLimiter(log, { perWindow = 5, windowMs = 60000, maxKeys = 10000, now = Date.now } = {}) {
  const seen = new Map(); // key -> { start, count, dropped }, oldest window first
  let droppedUntracked = 0;
  return {
    write(key, text) {
      const t = now();
      let e = seen.get(key);
      if (!e || t - e.start >= windowMs) {
        let steps = 4; for (const [k, v] of seen) { if (steps-- <= 0 || t - v.start < windowMs) break; seen.delete(k); }
        const carried = e?.dropped ?? 0;
        if (e) seen.delete(key);
        else if (seen.size >= maxKeys) { droppedUntracked++; return false; } // too many sources to track: stay quiet
        e = { start: t, count: 0, dropped: carried }; seen.set(key, e);
      }
      if (e.count >= perWindow) { e.dropped++; return false; }
      e.count++;
      const more = e.dropped + droppedUntracked; e.dropped = 0; droppedUntracked = 0;
      log(more ? `${text} (${more} similar line(s) not shown)` : text);
      return true;
    },
    get size() { return seen.size; },
  };
}

// Caps on open sockets: a total, and a number per client address. admit(socket) returns false when the socket must be
// dropped; an admitted socket is released by its own 'close' event.
export function createConnectionGuard({ maxTotal = 2000, maxPerIp = 16, perMinutePerIp = 0 } = {}) {
  const perIp = new Map(); let total = 0;
  const rate = perMinutePerIp > 0 ? createRateLimiter({ limit: perMinutePerIp, windowMs: 60000 }) : null;
  return {
    admit(socket) {
      const ip = clientIp(socket.remoteAddress);
      if (rate && !rate.hit(ip)) return false;
      const n = perIp.get(ip) ?? 0;
      if (total >= maxTotal || n >= maxPerIp) return false;
      perIp.set(ip, n + 1); total++;
      socket.once('close', () => { total--; const m = (perIp.get(ip) ?? 1) - 1; if (m <= 0) perIp.delete(ip); else perIp.set(ip, m); });
      return true;
    },
    get total() { return total; },
    count: (ip) => perIp.get(clientIp(ip)) ?? 0,
  };
}

// Reads a request body up to `limit` bytes. Resolves { ok: true, body } or { ok: false, status } (413 too large,
// 400 broken upload). A declared Content-Length over the limit is refused before a byte is read.
export function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); return resolve({ ok: false, status: 413 }); }
    const chunks = []; let size = 0, done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { chunks.length = 0; req.pause(); finish({ ok: false, status: 413 }); return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, status: 400 }));
    req.on('aborted', () => finish({ ok: false, status: 400 }));
  });
}

// Timeouts and caps for an http.Server, plus the connection guard. Slow or silent clients are disconnected.
export function hardenHttpServer(server, { guard = null, headersMs = 15000, requestMs = 120000, keepAliveMs = 5000, idleMs = 120000, maxHeaders = 64 } = {}) {
  server.headersTimeout = headersMs;
  server.requestTimeout = requestMs;
  server.keepAliveTimeout = keepAliveMs;
  server.maxHeadersCount = maxHeaders;
  server.maxRequestsPerSocket = 1000;
  server.on('connection', (socket) => {
    if (guard && !guard.admit(socket)) { socket.destroy(); return; }
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.on('error', () => {});
  });
  return server;
}

// Timeouts for a raw TCP socket: destroyed after `idleMs` without traffic.
export function hardenSocket(socket, { idleMs = 300000 } = {}) {
  socket.setTimeout(idleMs, () => socket.destroy());
  socket.setNoDelay?.(true);
  return socket;
}

// A listener that cannot open its port (already in use, not permitted) is a startup failure: say so and exit, so the
// supervisor (league.mjs or systemd) sees it. Without this the process guards below would keep a deaf process alive.
export function exitOnListenError(server, log, what) {
  server.on('error', (e) => { try { log(`${what} failed: ${e.message}`); } finally { process.exit(1); } });
  return server;
}

// Last line of defence: one bad socket or one rejected promise must not stop the process. systemd restarts the service
// if it does die, but every console would be disconnected.
export function installProcessGuards(log) {
  process.on('uncaughtException', (e) => { try { log(`uncaught exception (still running): ${e?.stack ?? e}`); } catch { /* nothing left to do */ } });
  process.on('unhandledRejection', (e) => { try { log(`unhandled rejection (still running): ${e?.stack ?? e}`); } catch { /* nothing left to do */ } });
}
