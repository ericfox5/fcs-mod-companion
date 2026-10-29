import { gzipSync } from 'node:zlib';
import type { BridgeConfig } from './config.js';

export class WorkerApi {
  constructor(private cfg: BridgeConfig) {}
  private headers(extra: Record<string, string> = {}) { return { authorization: `Bearer ${this.cfg.token}`, ...extra }; }
  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : gzipSync(Buffer.from(JSON.stringify(body)));
    const res = await fetch(this.cfg.workerUrl + path, { method, headers: this.headers(payload ? { 'content-type': 'application/json', 'x-content-encoding': 'gzip' } : {}), body: payload });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : (undefined as T);
  }
  async putFile(path: string, bytes: Uint8Array): Promise<any> {
    const res = await fetch(this.cfg.workerUrl + path, { method: 'PUT', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: bytes });
    if (!res.ok) throw new Error(`PUT ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}
