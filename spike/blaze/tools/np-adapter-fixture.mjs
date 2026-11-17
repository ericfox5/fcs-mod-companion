// Made-up inputs for the adapter tests (tools and installer): addresses that are not the game's, a credential nobody
// was ever issued. Nothing here comes from the game binary or from a real profile.
import { HOOKS } from './np-adapter-rpcs3.mjs';

// stubs and call sites below the code, like the game's layout
export function fakeTemplate() {
  const stubs = {}, sites = {}; let site = 0x20000;
  HOOKS.forEach(([name, count], i) => { stubs[name] = 0xf10000 + i * 0x20; sites[name] = Array.from({ length: count }, () => (site += 0x1234)); });
  return { format: 1, titleId: 'TEST00000', version: '01.02', inputSha256: '0'.repeat(64), codeVa: 0x1000000, codeLimit: 0x100d000, stateVa: 0x1200000, rtcClock: 0xf00000, rtcTick: 0xf00020, stubs, sites };
}
// FCSNP001 + a fixed pattern
export const fakeTicket = (seed = 1) => Buffer.concat([Buffer.from('FCSNP001'), Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + seed * 101 + 11) & 255))]);
export const fakeProfile = (seed = 1) => ({ version: 1, userId: 700100 + seed, onlineId: `TestUser${seed}`, ticketHex: fakeTicket(seed).toString('hex'), issuedMs: 1700000000000, expiresMs: 2000000000000, server: 'play.example.test' });
