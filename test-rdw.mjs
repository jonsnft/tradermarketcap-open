// Tests for reset-dash-watch. Run: RDW_TEST=1 node test-rdw.mjs <path-to-reset-repo>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.RDW_TEST = '1';
const repo = process.argv[2];
const { dashAge, decide } = await import('./reset-dash-watch.mjs');

// 1. The age parser against the real dashboard renderer.
const { renderMain } = await import(pathToFileURL(path.join(repo, 'signer/dashboard/render.mjs')).href);
const { History } = await import(pathToFileURL(path.join(repo, 'signer/dashboard/history.mjs')).href);
const addr = '8fb4d1ed7089656876fb887e9d46ab0acf3b0507ccbab0766969189f8bef061c';
const state = { tip: { height: 977689, hash: '00'.repeat(32) }, counted: 977684, params: { min_amount: '10000000', mine_capacity: '44550000000' }, gateways: [] };
const account = { balance: '921084', deposit: '846245719', exits: [], moves_this_height: 0, mine: { r: 1332, claim: null, fair_share_estimate: '340410', strikes: 0, clean: 6, last_result: null } };
const NOW = 1_800_000_000_000;
const history = await History.load('/nonexistent-rdw-test', addr).catch(() => null);
const snap = (over) => ({ address: addr, gateway: 'https://g', state, account, error: null, updatedAt: NOW, lastBlockAt: null, counted: state.counted, history, historyError: null, ...over });
const html = (over, now = NOW) => renderMain(snap(over), now);
assert.equal(dashAge(html({ updatedAt: NOW - 5000 })), 0, 'just now');
assert.equal(dashAge(html({ updatedAt: NOW - 12 * 60e3 })), 12, 'minutes');
assert.equal(dashAge(html({ updatedAt: NOW - 46 * 3600e3 })), 46 * 60, 'hours, as on 26 Nov');
assert.equal(dashAge(html({ updatedAt: NOW - 3 * 86400e3 })), 3 * 1440, 'days');
assert.equal(dashAge(html({ updatedAt: NOW - 40 * 60e3, error: 'Gateway timed out' })), 40, 'error banner');
assert.equal(dashAge('<p>Connecting</p>'), null);
console.log('ok  age parser matches the real renderer');

// 2. Decisions.
const T = 10_000_000;
let st = { badChecks: 0, lastRestart: 0 };
assert.equal(decide({ dashOk: true, age: 0, gatewayOk: true }, st, T).action, 'ok');
assert.equal(decide({ dashOk: true, age: 2760, gatewayOk: true }, st, T).action, 'restart', 'stale 46 h -> restart at once');
st = { badChecks: 0, lastRestart: 0 };
assert.equal(decide({ dashOk: true, age: 2760, gatewayOk: false }, st, T).action, 'wait', 'gateway down -> no restart');
assert.equal(decide({ dashOk: true, age: 29, gatewayOk: true }, st, T).action, 'ok', 'under 30 min is fine');
assert.equal(decide({ dashOk: false, age: null, gatewayOk: true }, st, T).action, 'wait', 'first unreachable check waits');
assert.equal(decide({ dashOk: false, age: null, gatewayOk: false }, st, T).action, 'restart', 'second unreachable check restarts');
st = { badChecks: 0, lastRestart: T - 10 * 60e3 };
assert.equal(decide({ dashOk: true, age: 600, gatewayOk: true }, st, T).action, 'cooldown', 'no second restart within 30 min');
assert.equal(decide({ dashOk: true, age: 600, gatewayOk: true }, st, T + 25 * 60e3).action, 'restart', 'after cooldown');
st = { badChecks: 0, lastRestart: 0 };
assert.equal(decide({ dashOk: true, age: null, gatewayOk: true }, st, T).action, 'wait');
assert.equal(decide({ dashOk: true, age: 0, gatewayOk: true }, st, T).action, 'ok');
assert.equal(st.badChecks, 0, 'a good check resets the count');
assert.equal(decide({ dashOk: true, age: null, gatewayOk: false }, st, T).action, 'wait', 'no page state and gateway down');
console.log('ok  decisions');

// 3. End to end with a hanging-dashboard fake, a fake gateway and fake pm2/ntfy.
const page = { body: '' };
const srv = createServer((req, res) => {
  if (req.url === '/fragment') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page.body); return; }
  if (req.url === '/v1/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ counted: 977684 })); return; }
  res.writeHead(404).end();
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
process.env.RDW_DASH_URL = `${base}/fragment`;
process.env.RESET_GATEWAY_URL = base;
const fresh = await import(`./reset-dash-watch.mjs?e2e`);
const restarts = [], pushes = [], logs = [];
let clock = T;
const w = fresh.makeWatcher({ restart: async () => { restarts.push(clock); page.body = html({ updatedAt: NOW - 5000 }); },
  notify: async (t, m) => pushes.push(`${t}: ${m}`), now: () => clock, log: s => logs.push(s) });
const st2 = { badChecks: 0, lastRestart: 0 };
page.body = html({ updatedAt: NOW - 46 * 3600e3 });
let r = await w.check(st2);
assert.equal(r.action, 'restart'); assert.equal(restarts.length, 1); assert.equal(pushes.length, 1);
assert.match(pushes[0], /RESET-DASH neu gestartet/); assert.match(pushes[0], /2760 min/);
clock += 5 * 60e3;
r = await w.check(st2);
assert.equal(r.action, 'ok'); assert.equal(restarts.length, 1);
const failing = fresh.makeWatcher({ restart: async () => { throw new Error('pm2 not found'); },
  notify: async (t, m) => pushes.push(`${t}: ${m}`), now: () => clock, log: s => logs.push(s) });
page.body = html({ updatedAt: NOW - 2 * 3600e3 });
r = await failing.check({ badChecks: 0, lastRestart: 0 });
assert.equal(r.action, 'restart'); assert.match(pushes.at(-1), /Neustart fehlgeschlagen.*pm2 not found/);
srv.close();
console.log('ok  end to end (stale page -> one restart + push, then quiet; failed restart -> push)');
console.log('ALLE TESTS OK');
