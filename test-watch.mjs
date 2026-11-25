// Offline test of tmc-watch with a fake GitHub and a fake ntfy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TMC_TEST = "1";
process.env.TMC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcw-'));
const { makeCtx, tick } = await import('./tmc-watch.mjs');

const H = 3600e3;
let NOW = Date.parse('2026-11-21T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const claimBody = 'claim trac142mcxkuxs4y379kdje30k08k7mv644aps3ukkt2vhhz4t0z55p4sdn9lps';

const world = {
  issues: [
    { number: 70, title: 'Existing free task', comments: 0, body: 'Bounty: 2 RESET', labels: [{ name: 'bounty' }] },
    { number: 71, title: 'Read XYZ supply', comments: 1, body: 'Bounty: 1 RESET', labels: [{ name: 'bounty' }] },
    { number: 72, title: 'Add HTX reader', comments: 0, body: 'Bounty: 2 RESET', labels: [{ name: 'bounty' }] },
    { number: 73, title: 'Old claim, expired', comments: 1, body: 'Bounty: 0.5 RESET', labels: [{ name: 'bounty' }] },
    { number: 74, title: 'Paused task', comments: 0, body: 'Bounty: 3 RESET', labels: [{ name: 'bounty' }, { name: 'paused' }] },
  ],
  comments: {
    71: [{ user: { login: 'otheragent' }, body: claimBody, created_at: iso(NOW - 2 * H) }],
    73: [{ user: { login: 'slowagent' }, body: claimBody, created_at: iso(NOW - 50 * H) }],
  },
  pulls: [{ title: '[bounty #72] Add an HTX (Huobi) exchange reader', body: '', user: { login: 'devin' } }],
};
const posted = [], pushes = [];
const titles = () => pushes.map(p => p.title);

async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.host === 'ntfy.sh') { pushes.push(JSON.parse(opts.body)); return json({}); }
  if (u.pathname === '/user') return json({ login: 'weissio' });
  if (u.pathname.endsWith('/pulls')) return json(world.pulls);
  const m = u.pathname.match(/\/issues\/(\d+)\/comments$/);
  if (m && opts.method === 'POST') {
    const n = Number(m[1]); const b = JSON.parse(opts.body);
    posted.push({ n, body: b.body });
    (world.comments[n] ??= []).push({ user: { login: 'weissio' }, body: b.body, created_at: iso(NOW) });
    world.issues.find(i => i.number === n).comments++;
    return json({}, 201);
  }
  if (m) return json(world.comments[Number(m[1])] || []);
  if (u.pathname.endsWith('/issues')) return json(world.issues);
  return json({ message: 'not found' }, 404);
}

const ctx = makeCtx({ fetchImpl: fakeFetch, token: 'x', now: () => NOW });
const state = { topic: 'tmc-test' };

// 1) Start: existing free tasks (#70, expired claim #73) are only pushed, not claimed.
await tick(ctx, state);
assert.equal(posted.length, 0, 'Altaufgaben werden nicht automatisch geclaimt');
assert.ok(titles().some(t => /FREI: Bounty #70/.test(t)));
assert.ok(titles().some(t => /FREI: Bounty #73/.test(t)), 'abgelaufener Claim gilt als frei');
assert.ok(!titles().some(t => /#71|#72|#74/.test(t)), 'belegt/PR/pausiert bleiben still');
assert.ok(titles().some(t => /Wächter läuft/.test(t)));

// 2) Nothing changes: no duplicate pushes.
let n = pushes.length;
await tick(ctx, state);
assert.equal(pushes.length, n);

// 3) Two new bounties appear: the higher one is claimed at once, the other is pushed as free.
world.issues.push({ number: 80, title: 'Add a Coinbase International reader', comments: 0, body: 'Bounty: 2 RESET', labels: [{ name: 'bounty' }] });
world.issues.push({ number: 81, title: 'Fix a typo in rules', comments: 0, body: 'Bounty: 0.5 RESET', labels: [{ name: 'bounty' }] });
await tick(ctx, state);
assert.deepEqual(posted.map(p => p.n), [80], 'höchste neue Bounty sofort geclaimt');
assert.match(posted[0].body, /^claim trac1376drmts39jksahm3plf634tpt8nkpg8ejatqanfdyvflzl0qcwqxx32ps$/);
assert.ok(pushes.some(p => /GECLAIMT #80/.test(p.title) && p.priority === 5));
assert.ok(pushes.some(p => /FREI: Bounty #81/.test(p.title) && /Du hältst noch #80/.test(p.message)));

// 4) A new bounty someone else claimed first is reported as taken, never claimed.
world.issues.push({ number: 82, title: 'Taken quickly', comments: 1, body: 'Bounty: 3 RESET', labels: [{ name: 'bounty' }] });
world.comments[82] = [{ user: { login: 'fastagent' }, body: claimBody, created_at: iso(NOW) }];
await tick(ctx, state);
assert.equal(posted.length, 1);
assert.ok(pushes.some(p => /Neue Bounty #82/.test(p.title) && /vergeben/.test(p.message)));

// 5) 25 h without our PR -> reminder.
NOW += 25 * H;
await tick(ctx, state);
assert.ok(titles().some(t => /Noch 24 h für #80/.test(t)));

// 6) Our PR is open -> no more reminders; issue closes -> slot frees -> next NEW free task (#81) claimed in the same round.
world.pulls.push({ title: '[bounty #80] Add a Coinbase International reader', body: '', user: { login: 'weissio' } });
NOW += 16 * H;
await tick(ctx, state);
assert.ok(!titles().some(t => /Noch 8 h für #80/.test(t)));
world.issues = world.issues.filter(i => i.number !== 80);
world.pulls = world.pulls.filter(p => !/#80/.test(p.title));
await tick(ctx, state);
assert.ok(titles().some(t => /#80 geschlossen/.test(t)));
assert.deepEqual(posted.map(p => p.n), [80, 81], 'nächste neue freie Aufgabe sofort geclaimt, Altaufgaben nicht');
await tick(ctx, state);
assert.equal(posted.length, 2, 'nie zwei Claims gleichzeitig');

// ---------- v2: changed tasks and replacement tasks ----------
// Fresh world and state, like the real #9 -> #98 case.
world.issues = [
  { number: 9, title: 'Split AVAX locked stake out of the total', comments: 2, body: 'Bounty: 2 RESET\nDone when: AVAX circulating excludes locked stake.', labels: [{ name: 'bounty' }] },
  { number: 12, title: 'Read FOO supply', comments: 0, body: 'Bounty: 1 RESET', labels: [{ name: 'bounty' }] },
];
world.comments = {
  9: [{ user: { login: 'agent-6257' }, body: claimBody, created_at: iso(NOW - 3 * 24 * H) },
      { user: { login: 'kinshu7777' }, body: claimBody, created_at: iso(NOW - 1 * H) }],
};
world.pulls = [{ title: '[bounty #9] Read AVAX circulating supply with locked P-chain stake excluded', body: '', user: { login: 'agent-6257' } }];
posted.length = 0; pushes.length = 0;
const s2 = { topic: 'tmc-test2' };
await tick(ctx, s2);
assert.equal(pushes.filter(p => /GEÄNDERT/.test(p.title)).length, 0, 'erster Lauf meldet keine Änderungen');

// 7) The maintainer corrects the taken task #9: title changes -> push (prio 4) with old and new title.
world.issues[0].title = "Read AVAX supply per Avalanche's published method";
world.issues[0].body = 'Bounty: 2 RESET\nCorrected Nov 24, 2026. Staked AVAX counts as circulating.\nDone when: P-chain supply minus burns.';
await tick(ctx, s2);
let ch = pushes.find(p => /GEÄNDERT: Bounty #9/.test(p.title));
assert.ok(ch, 'Änderung an vergebener Aufgabe wird gemeldet');
assert.equal(ch.priority, 4);
assert.match(ch.message, /Neuer Titel: Read AVAX supply/);
assert.match(ch.message, /Vorher: Split AVAX locked stake/);
assert.match(ch.message, /Neu im Text: Corrected Nov 24, 2026\. Staked AVAX counts as circulating\./);
assert.match(ch.message, /Vergeben \(2 Claims, 1 PR\)/);
n = pushes.length;
await tick(ctx, s2);
assert.equal(pushes.length, n, 'dieselbe Änderung nur einmal');

// 8) Text-only change -> push with prio 3.
world.issues[1].body = 'Bounty: 1 RESET\nAlso count the treasury.';
await tick(ctx, s2);
ch = pushes.find(p => /GEÄNDERT: Bounty #12/.test(p.title));
assert.ok(ch && ch.priority === 3 && /Neu im Text: Also count the treasury\./.test(ch.message) && /Frei\./.test(ch.message));
// whitespace-only edits are ignored
n = pushes.length;
world.issues[1].body = 'Bounty: 1 RESET\n\nAlso count the treasury.  ';
await tick(ctx, s2);
assert.equal(pushes.length, n, 'nur Leerzeichen geändert: keine Meldung');

// 9) #9 is replaced by #98 while PRs/claims on #9 still count -> NOT claimed, push explains why.
world.issues = world.issues.filter(i => i.number !== 9);
world.issues.push({ number: 98, title: "Read AVAX supply per Avalanche's published method", comments: 0,
  body: 'Bounty: 2 RESET\nThis task replaces #9 (same bounty and rules). Claims and pull requests already made on #9 still count, in the same order.', labels: [{ name: 'bounty' }] });
world.pulls.push({ title: "[bounty #9] Read AVAX supply per Avalanche's published method", body: 'Resolves #9.', user: { login: 'kinshu7777' } });
await tick(ctx, s2);
assert.equal(posted.length, 0, 'Ersatz-Aufgabe mit belegter Vorgängerin wird nicht geclaimt');
ch = pushes.find(p => /Neue Bounty #98/.test(p.title));
assert.ok(ch && ch.priority === 3, 'Ersatz-Aufgabe wird gemeldet');
assert.match(ch.message, /Ersetzt #9, dort schon vergeben \(2 PRs, 1 Claim\)/);
assert.ok(!pushes.some(p => /FREI: Bounty #98/.test(p.title)));

// 10) A replacement for an old task nobody worked on is claimed like any new task.
world.issues.push({ number: 99, title: 'Read BAR supply', comments: 0, body: 'Bounty: 1.5 RESET\nThis task replaces #13.', labels: [{ name: 'bounty' }] });
await tick(ctx, s2);
assert.deepEqual(posted.map(p => p.n), [99], 'Ersatz für unbearbeitete Aufgabe wird normal geclaimt');

console.log('ALLE TESTS OK');
for (const p of pushes) console.log(` push p${p.priority}: ${p.title} | ${p.message.replace(/\n/g, ' / ')}`);
