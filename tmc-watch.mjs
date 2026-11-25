#!/usr/bin/env node
// tmc-watch: watches the TraderMarketCap bounty issues, claims a free task at once and pushes a message via ntfy.
// Free = open bounty issue, no open pull request mentions it, and nobody holds a live claim (claims expire after 48 h).
// Only one claim of ours at a time (repo rule). No packages needed, Node 20+.
// v2: pushes when the title or text of any open bounty task changes (also taken ones), and does not auto-claim a
// task that replaces an older one ("replaces #9") while claims or pull requests on the old one still count.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const REPO = process.env.TMC_REPO || 'tradermarketcap/tradermarketcap-open';
const DIR = process.env.TMC_DIR || path.join(os.homedir(), '.tmc-watch');
const TRAC = process.env.TMC_TRAC || 'trac1376drmts39jksahm3plf634tpt8nkpg8ejatqanfdyvflzl0qcwqxx32ps';
const AUTOCLAIM = process.env.TMC_AUTOCLAIM !== '0';
// Auto-claim only issues that appear after the watcher started; free older ones are pushed for a manual check.
const CLAIM_EXISTING = process.env.TMC_CLAIM_EXISTING === '1';
const EVERY_MS = Number(process.env.TMC_EVERY_SEC || 60) * 1000;
const NTFY = process.env.TMC_NTFY || 'https://ntfy.sh';
const API = 'https://api.github.com';
const CLAIM_MS = 48 * 3600e3;
const SKIP_LABELS = /paused|done|closed|wontfix|invalid|duplicate/i;
const CLAIM_RE = /^\s*claim\s+trac1[0-9a-z]{20,}/i;
const REPLACES_RE = /\b(?:replaces|supersedes|moved from|ersetzt)\s+(?:issue\s+)?#(\d+)/i;
const OLD_CHECK_MS = 30 * 60e3;

const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'watch.log');

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}
function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function save(s) {
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.renameSync(STATE + '.tmp', STATE);
}

export function makeCtx({ fetchImpl = fetch, token, now = () => Date.now() } = {}) {
  async function gh(p, { method = 'GET', body } = {}) {
    const r = await fetchImpl(p.startsWith('http') ? p : API + p, {
      method,
      headers: {
        accept: 'application/vnd.github+json', 'user-agent': 'tmc-watch', 'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const left = r.headers?.get?.('x-ratelimit-remaining');
      throw new Error(`GitHub ${r.status} ${method} ${p}${left === '0' ? ' (Rate-Limit erreicht)' : ''}`);
    }
    return r.status === 204 ? null : r.json();
  }
  async function notify(state, title, message, { priority = 3, click, tags } = {}) {
    try {
      await fetchImpl(NTFY, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ topic: state.topic, title, message, priority, ...(click ? { click } : {}), ...(tags ? { tags } : {}) }),
      });
    } catch (e) { log('ntfy fehlgeschlagen:', e.message); }
  }
  return { gh, notify, now };
}

const refsIn = text => new Set([...String(text || '').matchAll(/#(\d+)\b/g)].map(m => Number(m[1])));
const bountyOf = body => (String(body || '').match(/Bounty:\s*([\d.]+)\s*RESET/i) || [])[1] || '?';
const issueUrl = n => `https://github.com/${REPO}/issues/${n}`;
const sigOf = i => crypto.createHash('sha1').update(`${i.title}\n${String(i.body || '').replace(/\s+/g, ' ').trim()}`).digest('hex');
// Lines of the new text that were not in the old one, shortened for a push message.
function addedLines(oldBody, newBody) {
  const old = new Set(String(oldBody || '').split('\n').map(l => l.trim()).filter(Boolean));
  const add = String(newBody || '').split('\n').map(l => l.trim()).filter(l => l && !old.has(l)).join(' / ');
  return add.length > 300 ? add.slice(0, 297) + '...' : add;
}
const fmt = ms => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });

async function pages(ctx, p, max = 5) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const batch = await ctx.gh(`${p}${p.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// One round. Returns a short summary for the log.
export async function tick(ctx, state) {
  state.issues ??= {};
  state.reminded ??= {};
  if (!state.me) state.me = (await ctx.gh('/user')).login;

  const issues = (await pages(ctx, `/repos/${REPO}/issues?labels=bounty&state=open`))
    .filter(i => !i.pull_request && !i.labels?.some(l => SKIP_LABELS.test(l.name || '')))
    .sort((a, b) => (Number(bountyOf(b.body)) || 0) - (Number(bountyOf(a.body)) || 0) || b.number - a.number); // highest bounty first
  const pulls = await pages(ctx, `/repos/${REPO}/pulls?state=open`);

  const prFor = new Map(); // issue number -> [pr logins]
  for (const pr of pulls) {
    for (const n of new Set([...refsIn(pr.title), ...refsIn(pr.body)])) {
      if (!prFor.has(n)) prFor.set(n, []);
      prFor.get(n).push(pr.user?.login);
    }
  }

  const firstRun = !state.started;
  const open = new Set(issues.map(i => i.number));

  // Our claim: reminders and cleanup
  if (state.claimed) {
    const k = state.claimed, t = ctx.now(), age = t - k.at;
    const ourPr = (prFor.get(k.number) || []).includes(state.me);
    if (!open.has(k.number)) {
      log(`Unsere Aufgabe #${k.number} ist geschlossen.`);
      await ctx.notify(state, `#${k.number} geschlossen`, `${k.title}\nEin Claim ist wieder frei.`, { priority: 3, click: issueUrl(k.number) });
      state.claimed = null;
    } else if (ourPr) {
      if (!state.reminded[`${k.number}:pr`]) { log(`PR für #${k.number} gefunden – Frist erfüllt.`); state.reminded[`${k.number}:pr`] = true; }
    } else {
      for (const h of [24, 40, 46]) {
        const key = `${k.number}:${h}`;
        if (age >= h * 3600e3 && !state.reminded[key]) {
          state.reminded[key] = true;
          await ctx.notify(state, `Noch ${48 - h} h für #${k.number}`, `${k.title}\nNoch kein PR. Frist: ${fmt(k.at + CLAIM_MS)}`, { priority: 4, click: issueUrl(k.number) });
        }
      }
      if (age >= CLAIM_MS) { log(`Claim #${k.number} abgelaufen.`); state.claimed = null; }
    }
  }

  let free = 0;

  for (const i of issues) {
    const c = state.issues[i.number] ??= { claims: [], comments: -1 };
    if (c.comments !== i.comments) {
      const comments = i.comments ? await pages(ctx, `/repos/${REPO}/issues/${i.number}/comments`, 3) : [];
      c.claims = comments.filter(x => CLAIM_RE.test(x.body || '')).map(x => ({ login: x.user?.login, at: Date.parse(x.created_at) }));
      c.comments = i.comments;
    }
    const t = ctx.now();
    const prs = prFor.get(i.number) || [];
    // A claim by someone else counts for 48 h; after that it has expired (any PR of theirs is caught by prs above).
    const liveOthers = c.claims.filter(x => x.login !== state.me && t - x.at < CLAIM_MS);
    const mine = c.claims.some(x => x.login === state.me);

    // A task that replaces an older one keeps the old one's claims and pull requests, in their order.
    const replaced = Number((String(i.body || '').match(REPLACES_RE) || [])[1]) || null;
    let oldTaken = '';
    if (replaced && !mine) {
      if (!c.old || c.old.number !== replaced || t - c.old.at > OLD_CHECK_MS) {
        const oc = await pages(ctx, `/repos/${REPO}/issues/${replaced}/comments`, 3);
        c.old = { number: replaced, at: t, claims: oc.filter(x => CLAIM_RE.test(x.body || '')).map(x => ({ login: x.user?.login, at: Date.parse(x.created_at) })) };
      }
      const oldPrs = (prFor.get(replaced) || []).filter(l => l !== state.me);
      const oldClaims = c.old.claims.filter(x => x.login !== state.me && t - x.at < CLAIM_MS);
      if (oldPrs.length || oldClaims.length) oldTaken = `auf #${replaced}: ${oldPrs.length} PR${oldPrs.length === 1 ? '' : 's'}, ${oldClaims.length} Claim${oldClaims.length === 1 ? '' : 's'}`;
    }
    const isFree = !mine && prs.length === 0 && liveOthers.length === 0 && !oldTaken;
    if (isFree) free++;

    const bounty = bountyOf(i.body);
    const takenText = oldTaken ? `Ersetzt #${replaced}, dort schon vergeben (${oldTaken.replace(/^auf #\d+: /, '')}).` : 'Schon vergeben.';
    if (!c.seen) {
      c.seen = true;
      c.newSinceStart = !firstRun;
      if (!firstRun) {
        log(`Neue Bounty #${i.number} (${bounty} RESET): ${i.title} – ${isFree ? 'FREI' : takenText}`);
        if (!isFree) await ctx.notify(state, `Neue Bounty #${i.number} (${bounty} RESET)`, `${i.title}\n${takenText}`, { priority: oldTaken ? 3 : 2, click: issueUrl(i.number) });
      }
    }

    // Title or text changed since the last round (only for tasks we have seen before).
    const sig = sigOf(i);
    if (c.sig && c.sig !== sig) {
      const titleChanged = typeof c.title === 'string' && c.title !== i.title;
      const added = addedLines(c.body, i.body);
      const status = isFree ? 'Frei.' : mine ? 'Unser Claim.' : `Vergeben (${c.claims.length} Claim${c.claims.length === 1 ? '' : 's'}, ${prs.length} PR${prs.length === 1 ? '' : 's'}${oldTaken ? ', ' + oldTaken : ''}).`;
      log(`GEÄNDERT #${i.number}: ${titleChanged ? `Titel "${c.title}" -> "${i.title}"` : 'Text geändert'}`);
      await ctx.notify(state, `GEÄNDERT: Bounty #${i.number} (${bounty} RESET)`,
        `${titleChanged ? `Neuer Titel: ${i.title}\nVorher: ${c.title}` : i.title}${added ? `\nNeu im Text: ${added}` : ''}\n${status} Lohnt ein Blick?`,
        { priority: titleChanged ? 4 : 3, click: issueUrl(i.number), tags: ['pencil2'] });
    }
    c.sig = sig; c.title = i.title; c.body = String(i.body || '');

    const busy = !!state.claimed;
    if (isFree && AUTOCLAIM && !busy && (c.newSinceStart || CLAIM_EXISTING)) {
      {
        await ctx.gh(`/repos/${REPO}/issues/${i.number}/comments`, { method: 'POST', body: { body: `claim ${TRAC}` } });
        state.claimed = { number: i.number, title: i.title, bounty, at: t };
        c.claims.push({ login: state.me, at: t });
        c.comments += 1;
        log(`GECLAIMT #${i.number} (${bounty} RESET): ${i.title}`);
        await ctx.notify(state, `GECLAIMT #${i.number} (${bounty} RESET)`,
          `${i.title}\nPR bis ${fmt(t + CLAIM_MS)} öffnen. Schick Claude den Link.`, { priority: 5, click: issueUrl(i.number), tags: ['rotating_light'] });
      }
      c.freeNotified = true;
    } else if (isFree && !c.freeNotified) {
      log(`FREI #${i.number}: ${i.title}${busy ? ` (nicht geclaimt, #${state.claimed.number} läuft noch)` : ''}`);
      await ctx.notify(state, `FREI: Bounty #${i.number} (${bounty} RESET)`,
        `${i.title}${busy ? `\nDu hältst noch #${state.claimed.number}.` : '\nBitte kurz prüfen, dann claimen.'}`, { priority: 4, click: issueUrl(i.number) });
      c.freeNotified = true;
    }
    if (!isFree) c.freeNotified = false;
  }

  for (const n of Object.keys(state.issues)) if (!open.has(Number(n))) delete state.issues[n];
  if (firstRun) {
    state.started = ctx.now();
    await ctx.notify(state, 'TMC-Wächter läuft', `${issues.length} offene Bounties, davon frei: ${free}.\nDu bekommst hier sofort Bescheid.`, { priority: 3 });
  }
  return `${issues.length} offen, ${pulls.length} PRs, frei ${free}${state.claimed ? `, unser Claim #${state.claimed.number}` : ''}`;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(DIR, 'token');
  if (!fs.existsSync(tokenFile)) { log(`Token fehlt: ${tokenFile}`); process.exit(1); }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const state = load();
  state.topic ??= 'tmc-' + crypto.randomBytes(9).toString('hex');
  save(state);
  log(`tmc-watch startet. Repo ${REPO}, alle ${EVERY_MS / 1000}s, Auto-Claim ${AUTOCLAIM ? 'AN' : 'AUS'}, Auszahlung an ${TRAC}`);
  log(`ntfy-Thema (in der App abonnieren): ${state.topic}`);
  const ctx = makeCtx({ token });
  let lastErr = '';
  for (;;) {
    try {
      const s = await tick(ctx, state);
      save(state);
      if (s !== state.lastSummary) { log(s); state.lastSummary = s; save(state); }
      lastErr = '';
    } catch (e) {
      if (e.message !== lastErr) log('Fehler:', e.message);
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, EVERY_MS));
  }
}

if (!process.env.TMC_TEST) main();
