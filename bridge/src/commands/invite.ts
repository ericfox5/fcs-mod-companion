// `ncaa-bridge od invite --did N --persona NAME`: asks the Worker for an invite code for one member of an online dynasty
// and prints the join link. A dynasty's first account can only come from here (the site issues invites only to a
// signed-in commissioner), so bootstrapping accounts proves control of the league server.
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadOdStore, odName } from '../od.js';

export async function odInvite(cfg: BridgeConfig, opts: { did?: number; persona: string }): Promise<void> {
  const store = loadOdStore(cfg.odDir);
  const all = Object.values(store.dynasties);
  const d = opts.did !== undefined ? all.find((x) => x.id === opts.did) : all.length === 1 ? all[0] : undefined;
  if (!d) throw new Error(opts.did !== undefined ? `no dynasty ${opts.did} in ${cfg.odDir}` : `pick a dynasty with --did (${all.map((x) => x.id).join(', ') || 'none in the store'})`);
  const names = d.members.map((m) => m.persona).join(', ') || 'none';
  if (!opts.persona) throw new Error(`--persona is required (members of ${odName(d)}: ${names})`);
  const m = d.members.find((x) => x.persona.toLowerCase() === opts.persona.toLowerCase());
  if (!m) throw new Error(`no member "${opts.persona}" in ${odName(d)} (members: ${names})`);
  const res = await new WorkerApi(cfg).json<{ code: string; slug: string; persona: string }>('POST', '/api/bridge/invites', { od: d.id, blazeId: m.blazeId, note: `bridge invite for ${m.persona}` });
  const joinUrl = `${cfg.workerUrl.replace(/\/+$/, '')}/d/${res.slug}/join?code=${encodeURIComponent(res.code)}`;
  console.log(`invite for ${res.persona} (blaze ${m.blazeId}) in ${odName(d)} [${res.slug}]: ${res.code}`);
  console.log(`join link: ${joinUrl}`);
  console.log('Send it privately: whoever opens it creates the account for that persona (one use).');
}
