// Trac ecosystem tokens: RESET, TNK, TAP. Read from their own markets and chains.
//   - Trac DEX (intercom-dex) public market view: RESET/USDC, TNK/USDC
//   - RESET supply: fixed emission, 3.125 RESET per Trac block since block 971558 (read the block from the Mine view)
//   - TAP: Uniswap v2 TAP/USDT pool reserves and Swap logs on Ethereum, supply from the token contract
//   - TNK supply: the sum of every account on the Main Settlement Bus, read from Trac's MSB API (tnkSupply below)
import { readFileSync } from 'node:fs';
import { getJSON, n } from '../../src/util.mjs';

export const DEX_VIEW = 'https://reset.much.fun/v1/market/view';
export const MINE_VIEW = 'https://reset.openmayhem.ai/v1/mine/view';
export const ETH_RPC = process.env.TMC_ETH_RPC || 'https://eth.drpc.org';

const TAP_TOKEN = '0x5e7F6e008C6d9D7AD4c7EB75Bd4ce62864cc7454';
const TAP_PAIR = '0x1563E9aF51616E78830de3325da752DE369C1714'; // token0 TAP (18), token1 USDT (6)
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

export const TRAC_VENUES = {
  tracdex: { name: 'Trac DEX', type: 'DEX', site: 'https://tractrader.com/trading-post/dex.html' },
  uniswap: { name: 'Uniswap v2', type: 'DEX', site: 'https://app.uniswap.org' },
};

// The Trac tokens themselves (ids, supply rules, which markets count) live in data-seed/coins.json.

async function rpc(method, params) {
  const r = await getJSON(ETH_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error('eth rpc: ' + JSON.stringify(r.error));
  return r.result;
}
const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));

export async function tracDex() {
  const v = await getJSON(DEX_VIEW);
  return (v.pairs || []).filter(p => p.status !== 'closed').map(p => {
    const [base, quote] = p.pair.split('/');
    return {
      venue: 'tracdex', base, quote, price: n(p.last), volBase: null, volQuote: n(p.volume24h) ?? 0,
      change24h: n(p.change24h) != null ? n(p.change24h) * 100 : null,
      api: DEX_VIEW, trade: 'https://tractrader.com/trading-post/dex.html',
    };
  });
}

export async function resetSupply() {
  const v = await getJSON(MINE_VIEW);
  const block = n(v.counted);
  if (!block) return null;
  const circ = (block - 971558) * 3.125;
  return { circulating: circ, total: circ, max: null, src: MINE_VIEW, note: '3.125 RESET per Trac block, no cap' };
}

// 24h volume from the pool's Swap logs. The free RPC allows only ~100 blocks per log query, so we scan
// forward in 100-block steps and keep a rolling 24h list (about 7,200 blocks a day).
const DAY_BLOCKS = 7200, STEP = 100;
const tapVol = { scanned: 0, swaps: [], usd: null, busy: false, at: 0 };
async function scanTapSwaps() {
  if (tapVol.busy || Date.now() - tapVol.at < 60e3) return;
  tapVol.busy = true;
  try {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    let from = Math.max(tapVol.scanned + 1, head - DAY_BLOCKS);
    for (let calls = 0; from <= head && calls < 80; calls++) {
      const to = Math.min(from + STEP - 1, head);
      const logs = await rpc('eth_getLogs', [{ address: TAP_PAIR, topics: [SWAP_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      for (const l of logs) tapVol.swaps.push([parseInt(l.blockNumber, 16), (Number(word(l.data, 1)) + Number(word(l.data, 3))) / 1e6]); // USDT in + out
      tapVol.scanned = to;
      from = to + 1;
    }
    tapVol.swaps = tapVol.swaps.filter(s => s[0] > head - DAY_BLOCKS);
    if (tapVol.scanned >= head - STEP) tapVol.usd = tapVol.swaps.reduce((s, x) => s + x[1], 0); // only once the day is fully scanned
  } catch { /* try again next minute */ } finally {
    tapVol.busy = false;
    tapVol.at = Date.now();
  }
}

export async function tapUniswap() {
  const res = await rpc('eth_call', [{ to: TAP_PAIR, data: '0x0902f1ac' }, 'latest']);
  const tap = Number(word(res, 0)) / 1e18, usdt = Number(word(res, 1)) / 1e6;
  const price = usdt / tap;
  scanTapSwaps(); // runs in the background
  return [{
    venue: 'uniswap', base: 'TAP', quote: 'USDT', price, volBase: null, volQuote: tapVol.usd,
    change24h: null, depthUsd: usdt * 2,
    api: `https://etherscan.io/address/${TAP_PAIR}#readContract`,
    trade: `https://app.uniswap.org/swap?outputCurrency=${TAP_TOKEN}&chain=mainnet`,
  }];
}

export async function tapSupply() {
  const res = await rpc('eth_call', [{ to: TAP_TOKEN, data: '0x18160ddd' }, 'latest']);
  const total = Number(BigInt(res)) / 1e18;
  return { circulating: total, total, max: null, src: `https://etherscan.io/token/${TAP_TOKEN}` };
}

// ---------- TNK ----------
// TNK is the native token of Trac Network and lives on its Main Settlement Bus (MSB). Read through Trac's public MSB
// API, tracapi.trac.network, documented in the MSB repository (github.com/Trac-Systems/main_settlement_bus,
// docs/trac_network_http_api.openapi.yaml). The API has no supply query, so:
//   total = the sum of balance + stakedBalance (GET /v1/account/{address}) over every address that can hold TNK,
//           plus TNK held in open HTLC escrows (GET /v1/htlc/{id}, status PENDING: amount + additionalFeeAmount).
// TNK only enters the MSB through BALANCE_INITIALIZATION operations (type 3: the TRAC BRC-20 -> TNK upgrade; the MSB
// has no other mint) and only leaves it through the burned part of fees (src/core/state/contracts/transactions).
// So the total must sit at or below the initialized amount, and initialized minus total is the TNK burned as fees.
// The addresses: data-seed/tnk-accounts.json lists, at a ledger checkpoint, every account that held TNK plus every
// validator and bootstrap creator (fee recipients), built by tools/tnk-accounts.mjs from a full read of the ledger.
// Each read scans the ledger from that checkpoint (GET /v1/tx-hashes, POST /v1/tx-payloads-bulk) for new addresses,
// new initializations and HTLC locks, and remembers where it stopped, so the hourly reads after the first are small.
export const TNK_API = (process.env.TMC_TNK_API || 'https://tracapi.trac.network/v1').replace(/\/+$/, '');
const TNK_SEED = () => process.env.TMC_TNK_SEED || new URL('../../data-seed/tnk-accounts.json', import.meta.url);
const TNK_ADDR = /^trac1[0-9a-z]{58}$/;
const TNK_MAX_SCAN = 600000; // ledger entries one read may scan before asking for a new seed
const TNK_CONC = 8;
const TNK_DEC = 10n ** 18n;
let tnkState = null;
export function tnkReset() { tnkState = null; }

const tnkAtomic = (v, what) => {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`tnk: ${what} is not an amount (${JSON.stringify(v)})`);
};
export const tnkNum = a => Number(a / 10n ** 12n) / 1e6; // 18 decimals -> TNK

function tnkLoad() {
  const s = JSON.parse(readFileSync(TNK_SEED(), 'utf8'));
  if (!Number.isSafeInteger(s.confirmedLength) || !Array.isArray(s.accounts) || !s.accounts.every(a => TNK_ADDR.test(a))) throw new Error('tnk: bad seed file');
  return { length: s.confirmedLength, initialized: tnkAtomic(s.initialized, 'seed initialized'), inits: s.initRecords, addrs: new Set(s.accounts), htlc: new Set(s.htlc || []) };
}

async function tnkPool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(TNK_CONC, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Scan the ledger after st.length up to `to`; returns the updated state (st itself is left as it was on error).
async function tnkScan(st, to) {
  if (to - st.length > TNK_MAX_SCAN) throw new Error(`tnk: ${to - st.length} ledger entries since the seed checkpoint; rebuild it with tools/tnk-accounts.mjs`);
  const next = { ...st, addrs: new Set(st.addrs), htlc: new Set(st.htlc) };
  for (let s = st.length + 1; s <= to; s += 1000) {
    const e = Math.min(s + 999, to);
    const h = await getJSON(`${TNK_API}/tx-hashes/${s}/${e}`);
    if (!Array.isArray(h?.hashes)) throw new Error(`tnk: bad tx-hashes ${s}-${e}`);
    const hashes = h.hashes.map(x => x?.hash);
    if (!hashes.every(x => /^[0-9a-f]{64}$/.test(x))) throw new Error('tnk: bad tx hash');
    for (let i = 0; i < hashes.length; i += 500) {
      const batch = hashes.slice(i, i + 500);
      const r = await getJSON(`${TNK_API}/tx-payloads-bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: batch }), timeout: 60000 });
      if (!Array.isArray(r?.results) || r.missing?.length || r.results.length !== batch.length) throw new Error('tnk: incomplete tx payloads');
      for (const { payload: p } of r.results) {
        if (!p || typeof p !== 'object') throw new Error('tnk: bad tx payload');
        if (!Number.isInteger(p.type)) { if (!('address' in p)) continue; throw new Error('tnk: bad tx payload'); } // epoch record
        // Every address an operation names (sender, recipient, validator, initialized account, HTLC parties).
        for (const v of [p.address, ...Object.values(p).filter(o => o && typeof o === 'object').flatMap(o => Object.values(o))]) {
          if (typeof v === 'string' && TNK_ADDR.test(v)) next.addrs.add(v);
        }
        if (p.type === 3) { next.initialized += tnkAtomic(p.bio?.am, 'initialized amount'); next.inits++; }
        if (p.type === 17) { if (!/^[0-9a-f]{64}$/.test(p.hlo?.tx || '')) throw new Error('tnk: bad HTLC lock'); next.htlc.add(p.hlo.tx); }
      }
    }
  }
  next.length = to;
  return next;
}

export async function tnkSupply(rule = {}) {
  let st = tnkState || tnkLoad();
  const len = (await getJSON(`${TNK_API}/confirmed-length`))?.confirmed_length;
  if (!Number.isSafeInteger(len) || len < st.length) throw new Error(`tnk: bad confirmed length ${len}`);
  st = await tnkScan(st, len);

  const addrs = [...st.addrs];
  const accounts = await tnkPool(addrs, a => getJSON(`${TNK_API}/account/${a}`));
  let held = 0n, staked = 0n, holders = 0;
  accounts.forEach((acc, k) => {
    if (acc?.address !== addrs[k]) throw new Error(`tnk: account ${addrs[k]} not returned`);
    const b = tnkAtomic(acc.balance, 'balance'), sb = tnkAtomic(acc.stakedBalance ?? '0', 'stakedBalance');
    held += b; staked += sb;
    if (b + sb > 0n) holders++;
  });

  // Open HTLC escrows hold TNK outside every account until claimed or refunded.
  let escrow = 0n, open = 0;
  const locks = [...st.htlc];
  const esc = await tnkPool(locks, async id => {
    try { return await getJSON(`${TNK_API}/htlc/${id}`); } catch (e) { if (/^404 /.test(e.message)) return null; throw e; }
  });
  esc.forEach((x, k) => {
    if (x === null) { st.htlc.delete(locks[k]); return; } // the lock never applied
    const e = x.escrow || x;
    if (!['PENDING', 'CLAIMED', 'REFUNDED'].includes(e?.status)) throw new Error(`tnk: bad HTLC escrow ${locks[k]}`);
    if (e.status === 'PENDING') { escrow += tnkAtomic(e.amount, 'escrow amount') + tnkAtomic(e.additionalFeeAmount ?? '0', 'escrow fee'); open++; }
    else st.htlc.delete(locks[k]);
  });

  const totalA = held + staked + escrow;
  if (totalA > st.initialized) throw new Error(`tnk: accounts hold ${totalA}, more than the ${st.initialized} ever initialized`);
  const burned = st.initialized - totalA;
  if (burned * 100n > st.initialized) throw new Error(`tnk: ${burned} missing from the accounts, more than 1% of the initialized supply`);
  tnkState = st; // remember the scan position only after a complete read

  const total = tnkNum(totalA);
  if (!(total > 0) || !Number.isFinite(total)) throw new Error('tnk: bad total');
  const fmt = v => Math.round(tnkNum(v)).toLocaleString('en-US');
  const withhold = rule.circulating === false;
  return {
    circulating: withhold ? null : total,
    total,
    src: `${TNK_API}/confirmed-length`,
    excluded: [{ reason: 'Burned as transaction fees (initialized minus all accounts)', amount: tnkNum(burned), src: 'https://github.com/Trac-Systems/main_settlement_bus/tree/main/src/core/state/contracts/transactions' }],
    note: `Read from Trac's Main Settlement Bus API (${TNK_API}) at ledger length ${len.toLocaleString('en-US')}: the sum of all ${holders.toLocaleString('en-US')} accounts holding TNK`
      + ` (${fmt(held)} TNK in balances, ${fmt(staked)} TNK staked by validators${open ? `, ${fmt(escrow)} TNK in ${open} open HTLC escrow${open === 1 ? '' : 's'}` : ''}).`
      + ` ${fmt(st.initialized)} TNK were initialized by the TRAC BRC-20 upgrade (${st.inits.toLocaleString('en-US')} balance initializations, the only way TNK is created); the ${fmt(burned)} TNK difference is burned fees.`
      + (withhold ? ' Circulating is withheld: Trac publishes no list of team, treasury or exchange wallets, so non-circulating TNK cannot be proven.' : ' Staked TNK counts as circulating.'),
  };
}
