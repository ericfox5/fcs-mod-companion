// Every program the wizard starts goes through here. Windows looks for a bare program name ("icacls", "cmd") in the
// current folder before the system folder, and the wizard is usually started from Downloads, where anyone's file may
// sit. So: Windows' own tools are started by full path under %SystemRoot%\System32 (checked to exist), with no shell and
// with the system folder as the working folder; anything else needs an absolute path; a bare name that is not on the
// list is refused. installer/build.mjs also points every other `node:child_process` import in the bundle (the bridge
// code the exe carries) at this module, so those calls get the same treatment.
import fs from 'node:fs';
import path from 'node:path';
import * as cp from 'node:child_process';

const win = process.platform === 'win32';
const FALLBACK_ROOT = 'C:\\Windows';
const DRIVE_PATH = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)*$/; // a local drive path: no UNC share, no relative part
const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isDir = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
type Env = Record<string, string | undefined>;

// %SystemRoot% (or %windir%) when it names a real Windows folder on a local drive, else C:\Windows
export function systemRoot(env: Env = process.env, hasSystem32: (root: string) => boolean = (r) => isDir(path.win32.join(r, 'System32'))): string {
  for (const v of [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR]) {
    if (!v) continue;
    const root = path.win32.normalize(v.trim()).replace(/\\+$/, '');
    if (DRIVE_PATH.test(root) && !root.split('\\').includes('..') && hasSystem32(root)) return root;
  }
  return FALLBACK_ROOT;
}
export const systemDir = (env: Env = process.env): string => path.win32.join(systemRoot(env), 'System32');

// the Windows tools this program may start, relative to System32. Not on the list: cmd (a shell).
const TOOLS: Record<string, string> = {
  icacls: 'icacls.exe',
  tasklist: 'tasklist.exe',
  rundll32: 'rundll32.exe',
  powershell: 'WindowsPowerShell\\v1.0\\powershell.exe',
};
// full path of a listed tool, or null when the name is not listed or the file is not there
export function systemTool(name: string, env: Env = process.env): string | null {
  const rel = TOOLS[name.toLowerCase().replace(/\.exe$/, '')];
  if (!rel) return null;
  const file = path.win32.join(systemDir(env), rel);
  return isFile(file) ? file : null;
}
export class RefusedCommand extends Error {
  constructor(command: string, why: string) { super(`refusing to start "${command.slice(0, 80)}": ${why}`); this.name = 'RefusedCommand'; }
}
// what will really be started for `command`, and whether it is one of Windows' own tools
export function resolveCommand(command: string, env: Env = process.env): { file: string; system: boolean } {
  if (!win) return { file: command, system: false };
  if (typeof command !== 'string' || !command || /[\0\r\n"]/.test(command)) throw new RefusedCommand(String(command), 'not a program path');
  if (/^[A-Za-z]:[\\/]/.test(command)) {
    const file = path.win32.normalize(command);
    if (!isFile(file)) throw new RefusedCommand(command, 'no such file');
    return { file, system: false };
  }
  if (/[\\/:]/.test(command)) throw new RefusedCommand(command, 'programs are started by full path only');
  const tool = systemTool(command, env);
  if (!tool) throw new RefusedCommand(command, TOOLS[command.toLowerCase().replace(/\.exe$/, '')] ? 'it is missing from the Windows system folder' : 'programs are started by full path only, and this name is not one of the Windows tools the wizard uses');
  return { file: tool, system: true };
}
// no shell, ever; a Windows tool runs in the system folder; any other program runs in the system folder too unless the
// caller names a working folder
function guarded<O extends { cwd?: unknown; shell?: unknown; windowsHide?: boolean }>(command: string, options: O | undefined): { file: string; options: O } {
  const r = resolveCommand(command);
  const o = { windowsHide: true, ...(options ?? {}) } as O;
  o.shell = false;
  if (win && (r.system || o.cwd === undefined || o.cwd === null)) o.cwd = systemDir();
  return { file: r.file, options: o };
}
export function spawn(command: string, args: readonly string[] = [], options?: cp.SpawnOptions): cp.ChildProcess {
  const g = guarded(command, options); return cp.spawn(g.file, [...args], g.options);
}
export function spawnSync(command: string, args: readonly string[] = [], options?: cp.SpawnSyncOptions): cp.SpawnSyncReturns<string | Buffer> {
  const g = guarded(command, options); return cp.spawnSync(g.file, [...args], g.options);
}
export function execFileSync(command: string, args: readonly string[] = [], options?: cp.ExecFileSyncOptions): string | Buffer {
  const g = guarded(command, options); return cp.execFileSync(g.file, [...args], g.options);
}
export function execFile(command: string, args: readonly string[] = [], options: cp.ExecFileOptions = {}, callback?: (error: cp.ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void): cp.ChildProcess {
  const g = guarded(command, options); return cp.execFile(g.file, [...args], g.options, callback);
}
// command lines for a shell are not started at all
const noShell = (name: string) => (..._args: unknown[]): never => { throw new RefusedCommand(name, 'this program does not run shell command lines'); };
export const exec = noShell('exec'), execSync = noShell('execSync'), fork = noShell('fork');

// ---- programs that are not Windows' own (Node, for `host`): found on PATH by this code, never by the system's search -----
// The first PATH folder that holds `file`. Only full local or network paths count: an empty entry, "." or a relative
// entry would mean "the current folder".
export function findOnPath(file: string, env: Env = process.env): string | null {
  if (/[\\/:]/.test(file)) return null;
  for (const raw of (env.PATH ?? env.Path ?? env.path ?? '').split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !(win ? /^([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(dir) : path.isAbsolute(dir))) continue;
    const f = path.join(dir, file);
    if (isFile(f)) return f;
  }
  return null;
}

// ---- the default browser -------------------------------------------------------------------------------------------------
// http(s) addresses only, as one argument to rundll32 (no shell reads it, so "&" and "%" in an address mean nothing)
export function browserUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length > 2000 || /[\s"<>^|\0-\x1f]/.test(url)) return null;
  let u: URL; try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
  return u.href;
}
export function openInBrowser(url: string, start: typeof spawn = spawn): boolean {
  const href = browserUrl(url);
  if (!href || !win) return false;
  try { const child = start('rundll32', ['url.dll,FileProtocolHandler', href], { detached: true, stdio: 'ignore' }); child.on('error', () => { /* the caller already printed the address */ }); child.unref(); return true; } catch { return false; }
}
