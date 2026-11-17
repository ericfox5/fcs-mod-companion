// Types for np-adapter-rpcs3.mjs (the installer imports it from TypeScript).
export interface AdapterTemplate {
  format: 1; titleId: string; version: string; inputSha256: string;
  codeVa: number; codeLimit: number; stateVa: number; rtcClock: number; rtcTick: number;
  stubs: Record<string, number>; sites: Record<string, number[]>;
}
export interface AdapterProfile { userId: number; onlineId: string; ticketHex: string; issuedMs: number; expiresMs: number }
export interface AdapterAssembly {
  code: [number, number][]; hooks: Record<string, number>; patches: [number, number, number][];
  ticketStore: [number, number]; digestStore: [number, number]; stateVa: number; credentialSha256: string;
}
export const INPUT_SHA256: string;
export const MAGIC: Buffer;
export const TICKET_LENGTH: number;
export const STATE_SIZE: number;
export const HOOKS: [string, number][];
export const RETAIN: { va: number; original: number; replacement: number };
export function nid(name: string): number;
export function jump(at: number, target: number, link?: boolean): number;
export function checkProfile(profile: unknown): { userId: number; onlineId: string; ticket: Buffer; issuedMs: number; expiresMs: number };
export function extractTemplate(elf: Buffer): AdapterTemplate;
export function checkTemplate(template: unknown): AdapterTemplate;
export function assemble(template: AdapterTemplate, profile: AdapterProfile): AdapterAssembly;
export function adapterWords(template: AdapterTemplate, profile: AdapterProfile): [number, number][];
export function decodeByteStores(words: number[]): Buffer;
