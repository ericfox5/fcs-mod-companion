// "Can this PC reach the league server?" One probe per port the game uses, then a plain verdict: ready, or the one
// thing to fix. Nothing is sent that identifies the member: TCP probes connect and close, the UDP probe is the game's
// own QoS ping shape (20 bytes, request id 1) with random filler.
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { randomBytes } from 'node:crypto';

export interface PortSpec { proto: 'tcp' | 'udp'; port: number; what: string; required: boolean }
// the league server's services (spike/blaze/server: redirector, blaze + locker + easw, qos)
export const LEAGUE_PORTS: PortSpec[] = [
  { proto: 'tcp', port: 42127, what: 'sign-in directory (redirector)', required: true },
  { proto: 'tcp', port: 33152, what: 'league server (Blaze)', required: true },
  { proto: 'tcp', port: 17503, what: 'dynasty file storage (Locker)', required: true },
  { proto: 'tcp', port: 17502, what: 'connection test (QoS settings)', required: true },
  { proto: 'udp', port: 17502, what: 'connection test (QoS ping)', required: true },
  { proto: 'tcp', port: 17504, what: 'Dynasty Wire', required: false }, // off on a server that runs with --easw off
];
export type ProbeFailure = 'refused' | 'timeout' | 'unreachable' | 'error';
export interface ProbeResult extends PortSpec { ok: boolean; ms: number; failure?: ProbeFailure; detail?: string }
export interface CheckResult { host: string; ip: string | null; dnsError?: string; probes: ProbeResult[] }

export async function resolveIPv4(host: string, lookup: (h: string) => Promise<string> = async (h) => (await dns.promises.lookup(h, { family: 4 })).address): Promise<{ ip: string } | { error: string }> {
  if (net.isIPv4(host)) return { ip: host };
  try { const ip = await lookup(host); return net.isIPv4(ip) ? { ip } : { error: 'no IPv4 address' }; } catch (e) { return { error: (e as NodeJS.ErrnoException).code ?? (e as Error).message }; }
}
const failureOf = (code: string | undefined): ProbeFailure => (code === 'ECONNREFUSED' ? 'refused' : code === 'ETIMEDOUT' ? 'timeout' : code && /^(ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL)$/.test(code) ? 'unreachable' : 'error');
export function probeTcp(ip: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms: number; failure?: ProbeFailure; detail?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now(), s = net.connect({ host: ip, port, family: 4 });
    const done = (r: { ok: boolean; failure?: ProbeFailure; detail?: string }) => { s.destroy(); resolve({ ...r, ms: Date.now() - t0 }); };
    s.setTimeout(timeoutMs, () => done({ ok: false, failure: 'timeout' }));
    s.once('connect', () => done({ ok: true }));
    s.once('error', (e: NodeJS.ErrnoException) => done({ ok: false, failure: failureOf(e.code), detail: e.code }));
  });
}
// the QoS ping the game sends: [4 filler][request id 1][secret 0][8 filler]; the server echoes those 20 bytes first
export function probeQosUdp(ip: string, port: number, timeoutMs: number, tries = 3): Promise<{ ok: boolean; ms: number; failure?: ProbeFailure; detail?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now(), s = dgram.createSocket('udp4'), msg = randomBytes(20);
    msg.writeInt32BE(1, 4); msg.writeInt32BE(0, 8);
    let sent = 0, timer: NodeJS.Timeout | undefined, finished = false;
    const done = (r: { ok: boolean; failure?: ProbeFailure; detail?: string }) => { if (finished) return; finished = true; clearTimeout(timer); try { s.close(); } catch { /* closed */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const send = () => {
      if (sent++ >= tries) return done({ ok: false, failure: 'timeout' });
      s.send(msg, port, ip, (e) => { if (e) done({ ok: false, failure: failureOf((e as NodeJS.ErrnoException).code), detail: (e as NodeJS.ErrnoException).code }); });
      timer = setTimeout(send, Math.max(250, Math.floor(timeoutMs / tries)));
    };
    s.on('message', (reply) => { if (reply.length >= 20 && reply.subarray(0, 20).equals(msg)) done({ ok: true }); });
    s.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, failure: failureOf(e.code), detail: e.code }));
    send();
  });
}
export async function checkServer(host: string, opts: { ports?: PortSpec[]; timeoutMs?: number; lookup?: (h: string) => Promise<string> } = {}): Promise<CheckResult> {
  const ports = opts.ports ?? LEAGUE_PORTS, timeoutMs = opts.timeoutMs ?? 5000;
  const r = await resolveIPv4(host, opts.lookup);
  if ('error' in r) return { host, ip: null, dnsError: r.error, probes: [] };
  const probes = await Promise.all(ports.map(async (p) => ({ ...p, ...(p.proto === 'tcp' ? await probeTcp(r.ip, p.port, timeoutMs) : await probeQosUdp(r.ip, p.port, timeoutMs)) })));
  return { host, ip: r.ip, probes };
}

// ---- the verdict, in words a member can act on ---------------------------------------------------------------------
export interface Verdict { ready: boolean; headline: string; lines: string[]; fix?: string }
export function verdict(c: CheckResult): Verdict {
  if (!c.ip) return { ready: false, headline: `NOT READY: the name ${c.host} could not be looked up (${c.dnsError}).`, lines: [],
    fix: 'Check that this PC is on the internet (open any website). If it is, the league server may be moving: try again in a few minutes, then tell the commissioner.' };
  const name = (p: ProbeResult) => `${p.proto.toUpperCase()} ${p.port}`;
  const lines = c.probes.map((p) => `${p.ok ? 'ok     ' : p.required ? 'FAILED ' : 'off    '} ${name(p).padEnd(9)} ${p.what}${p.ok ? ` (${p.ms} ms)` : `: ${p.failure === 'refused' ? 'nothing is listening there' : p.failure === 'timeout' ? 'no answer' : p.failure === 'unreachable' ? 'no route from this PC' : p.detail ?? 'error'}`}`);
  const req = c.probes.filter((p) => p.required), bad = req.filter((p) => !p.ok), where = `${c.host} (${c.ip})`;
  if (!bad.length) {
    const optional = c.probes.filter((p) => !p.required && !p.ok);
    return { ready: true, headline: `YOU'RE READY: this PC reaches the league server at ${where}.`, lines,
      ...(optional.length ? { fix: `${optional.map((p) => p.what).join(', ')} is switched off on the server; that is expected and nothing to fix.` } : {}) };
  }
  const list = bad.map(name).join(', ');
  if (bad.length === req.length) {
    if (bad.every((p) => p.failure === 'unreachable')) return { ready: false, headline: 'NOT READY: this PC has no route to the internet right now.', lines, fix: 'Check the network cable or Wi-Fi, then run the check again.' };
    if (bad.every((p) => p.failure === 'refused')) return { ready: false, headline: `NOT READY: ${where} answers, but the league server is not running on it.`, lines, fix: 'Nothing to fix on this PC. The server is down or restarting: try again in a few minutes, then tell the commissioner.' };
    return { ready: false, headline: `NOT READY: nothing at ${where} answers.`, lines,
      fix: 'Either the league server is down, or this network blocks it. Turn off any VPN and try again; if other members are playing right now, the block is on your side (school, work and hotel networks often block game ports: try a home connection or a phone hotspot).' };
  }
  const tcpBad = bad.filter((p) => p.proto === 'tcp'), udpBad = bad.filter((p) => p.proto === 'udp');
  if (!tcpBad.length && udpBad.length) return { ready: false, headline: `NOT READY: the server answers, but ${list} gets no reply.`, lines,
    fix: 'UDP is being blocked between this PC and the server. Allow rpcs3.exe through the firewall for outgoing UDP (Windows Security > Firewall > Allow an app), turn off any VPN, or try another network. If every member sees this, the server firewall is missing the UDP 17502 rule: tell the commissioner.' };
  if (tcpBad.every((p) => p.failure === 'refused')) return { ready: false, headline: `NOT READY: the server is up, but part of it is not running (${list}).`, lines, fix: 'Nothing to fix on this PC. Tell the commissioner which lines say FAILED.' };
  return { ready: false, headline: `NOT READY: the server answers on some ports but not on ${list}.`, lines,
    fix: 'A firewall is letting only part of the traffic through. Turn off any VPN and try again; if it stays, send the commissioner the lines that say FAILED (the server firewall may be missing those ports).' };
}

// ---- the server moved ----------------------------------------------------------------------------------------------
// RPCS3 keeps the league server's address as numbers, written when join ran. When the server's name now leads to
// another address, the game on this PC still calls the old one: said plainly, with the one command that fixes it.
export const FIX_COMMAND = 'FCS-online.exe join';
export interface Drift { headline: string; fix: string }
export function addressDrift(host: string, currentIp: string | null, configuredIp: string | null): Drift | null {
  if (!currentIp || !configuredIp || currentIp === configuredIp) return null;
  return {
    headline: `NOT READY: the league server has moved. ${host === currentIp ? `Its address is ${currentIp}` : `${host} is now at ${currentIp}`}, but the game on this PC is still set to the old address ${configuredIp}.`,
    fix: `Run this to fix it (close RPCS3 first): ${FIX_COMMAND}`,
  };
}
