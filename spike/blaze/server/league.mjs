// League server control: runs the redirector (42127), the Blaze stub (33152, with the Locker 17503, the in-game Dynasty
// Wire 17504, Supersim and the wire sync inside it), the QoS site (17502) and the site sync (`ncaa-bridge od watch`) in
// ONE window, restarts a service that exits, and reloads changed code by itself: a service restarts when a file it
// imports changes, but the Blaze stub and the redirector wait until no console is connected, so a game in progress is
// never cut off. The private RPCN server (WSL) is separate; `status` checks that it answers.
//   node league.mjs start      open the league window (closes leftover start-spike windows first)
//   node league.mjs stop       stop it (and any leftover start-spike windows)
//   node league.mjs restart    stop + start (reloads everything now, even with a console connected)
//   node league.mjs status     services, ports, console connection, RPCN
//   node league.mjs run        run in this terminal (what the window runs); add --no-sync to skip the site sync
// --lan <ip> (start/restart/run): the address consoles are told to use for Blaze, QoS and the Locker/Wire HTTP
//   (default 127.0.0.1, which only RPCS3 on this PC can reach); a real PS3 on the shared Ethernet port needs the PC's
//   address on that port, e.g. --lan 192.168.137.1, plus a hosts entry sending gosredirector.ea.com there.
// start-league.cmd / stop-league.cmd / restart-league.cmd wrap these for double-clicking.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const STATE = path.join(HERE, '..', 'private', 'league.json');
const TITLE = 'NCAA League Server';
const BLAZE_PORT = 33152, RPCN_PORT = 31313;
const PORTS = { redirector: [42127], blaze: [33152, 17503, 17504], qos: [17502] };
const SERVICES = [
  { name: 'redirector', color: 36, cwd: HERE, args: ['redirector.mjs'], entry: 'redirector.mjs', waitForIdle: true },
  { name: 'blaze', color: 32, cwd: HERE, args: ['blaze.mjs'], entry: 'blaze.mjs', waitForIdle: true },
  { name: 'qos', color: 90, cwd: HERE, args: ['qos.mjs'], entry: 'qos.mjs' },
  { name: 'sync', color: 35, cwd: ROOT, args: [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'bridge/src/cli.ts', 'od', 'watch'], tree: path.join(ROOT, 'bridge', 'src') },
];

const say = (msg) => console.log(`\x1b[33m[league]\x1b[0m ${msg}`);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// the saved supervisor pid, if that process is still a league.mjs (a stale league.json can name a reused pid)
function leaguePid() {
  const st = readState(); if (!st?.pid || !alive(st.pid)) return null;
  try { return /league\.mjs/.test(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${st.pid}").CommandLine`], { encoding: 'utf8', windowsHide: true })) ? st.pid : null; } catch { return null; }
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); return true; } catch { return false; } };

// TCP rows of `netstat -ano`: { local port, state, pid }
function tcpRows() {
  let out = ''; try { out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }); } catch { return []; }
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c[0] === 'TCP' && c.length >= 5)
    .map((c) => ({ port: Number(c[1].split(':').pop()), state: c[3], pid: Number(c[4]) }));
}
const consoleConnected = () => tcpRows().some((r) => r.port === BLAZE_PORT && r.state === 'ESTABLISHED');
const tcpOpen = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.setTimeout(1000); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); }); });

// Processes left by the old start-spike.ps1: its -NoExit PowerShell windows (killing one closes the window and its
// node) and any spike node process outside this supervisor. Found by command line, stopped by PID.
function leftovers(except = []) {
  let list = [];
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='powershell.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    list = [].concat(JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }) || '[]'));
  } catch { return []; }
  const spike = /(redirector|blaze|qos)\.mjs|cli\.ts od watch/;
  const parent = new Map(list.map((p) => [p.ProcessId, p.ParentProcessId]));
  const ours = (pid) => { for (let p = pid, i = 0; p && i < 10; p = parent.get(p), i++) if (except.includes(p)) return true; return false; }; // the supervisor's own tree
  return list.filter((p) => p.CommandLine && !ours(p.ProcessId) && (
    (p.Name === 'powershell.exe' && /-NoExit/.test(p.CommandLine) && spike.test(p.CommandLine))
    || (p.Name === 'node.exe' && spike.test(p.CommandLine) && !/league\.mjs/.test(p.CommandLine))));
}
function stopLeftovers(except) {
  const found = leftovers(except);
  for (const p of found.filter((x) => x.Name === 'powershell.exe')) if (killTree(p.ProcessId)) say(`closed old window ${p.ProcessId}`);
  for (const p of found.filter((x) => x.Name === 'node.exe')) if (alive(p.ProcessId) && killTree(p.ProcessId)) say(`stopped leftover ${p.ProcessId}: ${p.CommandLine.replace(/\s+/g, ' ').slice(0, 90)}`);
  return found.length;
}

// Files a service runs: its entry plus everything it imports with a relative path, recursively.
function importGraph(entry) {
  const seen = new Set(); const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return; seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(HERE, entry)); return seen;
}

async function run() {
  const other = leaguePid();
  if (other && other !== process.pid) { say(`already running (pid ${other}); use "stop" first`); process.exit(1); }
  process.title = TITLE;
  const noSync = process.argv.includes('--no-sync');
  const services = SERVICES.filter((s) => !(noSync && s.name === 'sync'));
  const lanAt = process.argv.indexOf('--lan'); const lan = lanAt === -1 ? null : process.argv[lanAt + 1];
  if (lan && !/^\d+\.\d+\.\d+\.\d+$/.test(lan)) { say(`--lan needs an IPv4 address, got "${lan}"`); process.exit(1); }
  if (lan) for (const s of services) { // the address consoles are sent (see the header); the services still listen on every interface
    if (s.name === 'redirector') s.args = [...s.args, '--blaze-host', lan];
    if (s.name === 'blaze') s.args = [...s.args, '--qos-addr', lan, '--http-host', lan];
  }
  if (stopLeftovers([process.pid])) await new Promise((r) => setTimeout(r, 1000));
  const busy = tcpRows().filter((r) => r.state === 'LISTENING' && services.some((s) => (PORTS[s.name] ?? []).includes(r.port)));
  if (busy.length) say(`warning: ports already in use: ${busy.map((r) => `${r.port} (pid ${r.pid})`).join(', ')}`);
  let stopping = false; const startedAt = new Date().toISOString();
  const saveState = () => fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, startedAt, services: Object.fromEntries(services.map((s) => [s.name, s.child?.pid ?? null])) }, null, 1));

  const launch = (s) => {
    s.startedAt = Date.now(); s.planned = false;
    const child = spawn(process.execPath, s.args, { cwd: s.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } });
    s.child = child; saveState();
    const tag = `\x1b[${s.color}m[${s.name}]\x1b[0m `;
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.on('data', (b) => { const lines = (rest + b.toString()).split(/\r?\n/); rest = lines.pop(); for (const l of lines) if (l) console.log(tag + l); });
    }
    child.on('exit', (code) => {
      if (stopping) return;
      if (s.planned) { launch(s); return; }
      s.crashes = Date.now() - s.startedAt < 15000 ? (s.crashes ?? 0) + 1 : 0;
      if (s.name === 'sync' && s.crashes >= 4) { say('site sync keeps exiting (bridge not configured? run `npx tsx bridge/src/cli.ts init`); not restarting it'); return; }
      const delay = Math.min(30, 2 ** s.crashes);
      say(`${s.name} exited (code ${code}); restarting in ${delay}s`);
      setTimeout(() => !stopping && launch(s), delay * 1000);
    });
  };
  const restart = (s, why) => { say(`${s.name}: ${why}; restarting`); s.planned = true; s.pending = null; killTree(s.child.pid); };

  // code changes -> restart the services that run the file (Blaze/redirector only while no console is connected)
  const changed = (file) => {
    for (const s of services) {
      const hit = s.tree ? file.startsWith(s.tree) && /\.ts$/.test(file) : importGraph(s.entry).has(file);
      if (!hit) continue;
      clearTimeout(s.debounce);
      s.debounce = setTimeout(() => {
        const why = `${path.basename(file)} changed`;
        if (s.waitForIdle && consoleConnected()) {
          if (!s.pending) say(`${s.name}: ${why}; reloading when the console disconnects (quit the game), or run restart-league to reload now`);
          s.pending = why;
        } else restart(s, why);
      }, 800);
    }
  };
  fs.watch(HERE, (_e, f) => f && f.endsWith('.mjs') && f !== 'league.mjs' && changed(path.join(HERE, f)));
  if (services.some((s) => s.tree)) fs.watch(path.join(ROOT, 'bridge', 'src'), { recursive: true }, (_e, f) => f && changed(path.join(ROOT, 'bridge', 'src', f)));
  setInterval(() => { if (services.some((s) => s.pending) && !consoleConnected()) for (const s of services) if (s.pending) restart(s, `${s.pending} (console disconnected)`); }, 5000);

  const shutdown = () => {
    if (stopping) return; stopping = true; say('stopping');
    for (const s of services) if (s.child && alive(s.child.pid)) killTree(s.child.pid);
    try { if (readState()?.pid === process.pid) fs.rmSync(STATE); } catch {}
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);

  for (const s of services) launch(s);
  say(`running ${services.map((s) => s.name).join(', ')} (pid ${process.pid}). Code changes reload automatically. Close this window or run stop-league to stop.`);
  if (!(await tcpOpen(RPCN_PORT))) say(`warning: no RPCN server on 127.0.0.1:${RPCN_PORT}; start the private RPCN server (WSL) before launching the game`);
}

function openWindow() {
  const running = leaguePid();
  if (running) { say(`already running (pid ${running})`); return; }
  stopLeftovers([]);
  // cmd's start opens a new console window for it (a detached spawn would have no console at all); it closes when the
  // supervisor exits. The services run windowless inside it (windowsHide), their output piped into this window.
  spawn('cmd.exe', ['/d', '/c', 'start', TITLE, '/D', HERE, process.execPath, path.join(HERE, 'league.mjs'), 'run', ...process.argv.slice(3)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  say(`started in the "${TITLE}" window`);
}

function stop() {
  const pid = leaguePid(); let n = 0;
  if (pid) { killTree(pid); n++; say(`stopped the league server (pid ${pid})`); }
  try { fs.rmSync(STATE); } catch {}
  n += stopLeftovers([]);
  if (!n) say('nothing was running');
}

async function status() {
  const st = readState(); const rows = tcpRows(); const pid = leaguePid();
  say(pid ? `running since ${st.startedAt} (pid ${pid})` : 'not running (no league window)');
  for (const [name, ports] of Object.entries(PORTS)) {
    const pid = st?.services?.[name];
    say(`  ${name.padEnd(10)} ${pid && alive(pid) ? `pid ${pid}` : 'stopped'}; ports ${ports.map((p) => `${p} ${rows.some((r) => r.port === p && r.state === 'LISTENING') ? 'open' : 'closed'}`).join(', ')}`);
  }
  const sync = st?.services?.sync; say(`  ${'sync'.padEnd(10)} ${sync && alive(sync) ? `pid ${sync}` : 'stopped'}`);
  say(`  console    ${consoleConnected() ? 'connected' : 'not connected'}`);
  say(`  RPCN       ${(await tcpOpen(RPCN_PORT)) ? 'answering' : 'not answering'} on 127.0.0.1:${RPCN_PORT}`);
  const old = leftovers(st?.pid ? [st.pid] : []); if (old.length) say(`  ${old.length} leftover start-spike process(es); "stop" or "start" closes them`);
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'run') await run();
else if (cmd === 'start') openWindow();
else if (cmd === 'stop') stop();
else if (cmd === 'restart') { stop(); await new Promise((r) => setTimeout(r, 1500)); openWindow(); }
else if (cmd === 'status') await status();
else { console.log('usage: node league.mjs start|stop|restart|status|run [--no-sync]'); process.exit(1); }
