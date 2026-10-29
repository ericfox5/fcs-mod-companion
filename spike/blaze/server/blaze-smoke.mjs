// Dev check: replay the captured ps3Login + localizeStrings against a running blaze.mjs and print the decoded replies.
//   node blaze.mjs --port 33199 &   then   node blaze-smoke.mjs 33199
import net from 'node:net';
import { encodePacket, PacketStream, describe } from './packet.mjs';
import { Writer, decode } from './tdf.mjs';
const port = Number(process.argv[2] ?? 33152);
const ticket = '21010000000000f7300000a4000800143231303431300000000000000000000000000000000100040000010000070008000001a1855b431600070008000001a18568feb60002000800000000000761510004002052504353335f38584c6f42473466553200000000000000000000000000000000000800046272000000040004756e0000000800185550303030362d424c555333313135395f30300000000000000100040000000000000000000000003002004b000800045250434e0008003f303d021d00af4dd4eb5716e1c10222289a0e3dac4951e6f81c74b850d792ee54ab021c6baa145148403cb7364202234638599d7069f3d7f412fded27a5a06f';
const sock = net.connect(port, '127.0.0.1');
const stream = new PacketStream();
const got = [];
sock.on('data', (d) => { for (const p of stream.feed(d)) { let b; try { b = decode(p.payload); } catch (e) { b = { err: e.message, hex: p.payload.toString('hex') }; } got.push([describe(p), b]); } });
await new Promise((r) => sock.on('connect', r));
const w = new Writer(); w.str('PASS', ''); w.blob('TCKT', Buffer.from(ticket, 'hex'));
sock.write(encodePacket({ component: 1, command: 200, type: 0, id: 9, payload: w.bytes() }));
const w2 = new Writer(); w2.int('LANG', 1701724754); w2.stringList('LSID', ['SDB_DOD_UNER']);
sock.write(encodePacket({ component: 9, command: 4, type: 0, id: 12, payload: w2.bytes() }));
sock.write(encodePacket({ component: 9, command: 8, type: 0, id: 13 }));
await new Promise((r) => setTimeout(r, 600));
for (const [d, b] of got) console.log(d, JSON.stringify(b).slice(0, 420));
sock.destroy();
