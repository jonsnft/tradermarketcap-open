#!/usr/bin/env node
// Rebuilds data-seed/tnk-accounts.json from a full read of Trac's Main Settlement Bus ledger (tracapi.trac.network):
// every address the ledger names, the TNK initialized by balance initializations (type 3), HTLC locks (type 17),
// then each account read once; the seed keeps accounts holding TNK, validators, indexers, licensed accounts and
// bootstrap creators (they receive fees). About 1,400 hash requests, 900 payload requests and one per address.
// Usage: node tools/tnk-accounts.mjs [out.json]
import fs from 'node:fs';
const API = (process.env.TMC_TNK_API || 'https://tracapi.trac.network/v1').replace(/\/+$/, '');
const OUT = process.argv[2] || new URL('../data-seed/tnk-accounts.json', import.meta.url);
const ADDR = /^trac1[0-9a-z]{58}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(url, opts = {}) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (i >= 5) throw e; await sleep(1000 * 2 ** i); }
  }
}
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const length = (await j(`${API}/confirmed-length`)).confirmed_length;
const addrs = new Set(), creators = new Set(), htlc = new Set();
let initialized = 0n, inits = 0;
const starts = []; for (let s = 0; s <= length; s += 1000) starts.push(s);
await pool(starts, 4, async s => {
  const { hashes } = await j(`${API}/tx-hashes/${s}/${Math.min(s + 999, length)}`);
  const hs = hashes.map(h => h.hash);
  for (let i = 0; i < hs.length; i += 500) {
    const r = await j(`${API}/tx-payloads-bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: hs.slice(i, i + 500) }) });
    if (r.missing?.length) throw new Error('missing payloads at ' + s);
    for (const { payload: p } of r.results) {
      if (!Number.isInteger(p?.type)) continue;
      for (const v of [p.address, ...Object.values(p).filter(o => o && typeof o === 'object').flatMap(o => Object.values(o))]) if (typeof v === 'string' && ADDR.test(v)) addrs.add(v);
      if (p.type === 3) { initialized += BigInt(p.bio.am); inits++; }
      if (p.type === 11) creators.add(p.address);
      if (p.type === 17) htlc.add(p.hlo.tx);
    }
  }
  if (s % 100000 === 0) console.error('ledger', s, '/', length);
});
const list = [...addrs];
const accounts = await pool(list, 8, a => j(`${API}/account/${a}`));
const keep = accounts.filter(a => BigInt(a.balance) + BigInt(a.stakedBalance || 0) > 0n || a.isValidator || a.isIndexer || a.license !== null || creators.has(a.address)).map(a => a.address).sort();
const seed = { source: `${API} (Trac Main Settlement Bus API), built by tools/tnk-accounts.mjs`, builtAt: new Date().toISOString(), confirmedLength: length, initialized: initialized.toString(), initRecords: inits, htlc: [...htlc].sort(), accounts: keep };
fs.writeFileSync(OUT, JSON.stringify(seed, null, 0).replace('"accounts":[', '"accounts":[\n').replace(/","/g, '",\n"') + '\n');
console.error(`ledger ${length}, ${list.length} addresses, ${keep.length} kept, ${inits} initializations, ${initialized} initialized (atomic)`);
