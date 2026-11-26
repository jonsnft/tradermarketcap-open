#!/usr/bin/env node
// reset-dash-watch: restarts the pm2 process RESET-DASH when the RESET dashboard stops updating
// (for example "Live - updated 46 h ago" while the gateway is fine) and pushes a note via ntfy.
// It only reads the local dashboard page and the public gateway state; it never touches a wallet.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DASH_URL = process.env.RDW_DASH_URL || 'http://127.0.0.1:4747/fragment';
const GATEWAY = (process.env.RESET_GATEWAY_URL || 'https://reset.openmayhem.ai').replace(/\/+$/, '');
const PM2_NAME = process.env.RDW_PM2_NAME || 'RESET-DASH';
const EVERY_MS = Number(process.env.RDW_EVERY_SEC || 300) * 1000;
const STALE_MIN = Number(process.env.RDW_STALE_MIN || 30);
const COOLDOWN_MS = Number(process.env.RDW_COOLDOWN_MIN || 30) * 60e3;
const BAD_CHECKS = 2;            // unreachable or unreadable dashboard: restart after this many checks in a row
const LOG_FILE = process.env.RDW_LOG || path.join(os.homedir(), '.reset-dash-watch.log');
const NTFY = process.env.RDW_NTFY || 'https://ntfy.sh';
const TOPIC_FILE = process.env.RDW_TOPIC_FILE || path.join(os.homedir(), '.tmc-watch', 'state.json');

// Age in minutes from the dashboard's status line: "Live \u00b7 updated 46 h ago" or, while the
// gateway is failing, "Showing data from 12 min ago". null when neither is on the page.
export function dashAge(html) {
  const m = /(?:Live \u00b7 updated|data from) (just now|(\d+) (min|h|days) ago)/.exec(String(html));
  if (!m) return null;
  if (m[1] === 'just now') return 0;
  const n = Number(m[2]);
  return m[3] === 'min' ? n : m[3] === 'h' ? n * 60 : n * 1440;
}

// One decision from one look. st carries badChecks and lastRestart between checks.
export function decide({ dashOk, age, gatewayOk }, st, now, { staleMin = STALE_MIN, cooldownMs = COOLDOWN_MS } = {}) {
  let bad = null, hard = false;
  if (!dashOk) bad = 'Dashboard antwortet nicht';
  else if (age === null) {
    if (!gatewayOk) return { action: 'wait', reason: 'Dashboard ohne Stand, Gateway nicht erreichbar' };
    bad = 'Dashboard zeigt keinen Stand';
  }
  else if (age >= staleMin) {
    if (!gatewayOk) return { action: 'wait', reason: `Stand ${age} min alt, aber Gateway nicht erreichbar` };
    bad = `letzte Aktualisierung vor ${age} min`; hard = true;
  }
  if (!bad) { st.badChecks = 0; return { action: 'ok', reason: `aktualisiert vor ${age} min` }; }
  st.badChecks = (st.badChecks || 0) + 1;
  if (!hard && st.badChecks < BAD_CHECKS) return { action: 'wait', reason: `${bad} (${st.badChecks}. Mal)` };
  if (st.lastRestart && now - st.lastRestart < cooldownMs) return { action: 'cooldown', reason: bad };
  return { action: 'restart', reason: bad };
}

const pm2Bin = () => {
  const local = path.join(path.dirname(process.execPath), 'pm2');
  return fs.existsSync(local) ? [process.execPath, [local]] : ['pm2', []];
};

export function makeWatcher({ fetchImpl = fetch, restart, notify, now = Date.now, log = console.log } = {}) {
  restart ??= () => new Promise((ok, fail) => {
    const [cmd, pre] = pm2Bin();
    execFile(cmd, [...pre, 'restart', PM2_NAME], { timeout: 60000 }, (e, out, err) => e ? fail(new Error((err || e.message).trim())) : ok());
  });
  notify ??= async (title, message) => {
    let topic = null;
    try { topic = JSON.parse(fs.readFileSync(TOPIC_FILE, 'utf8')).topic; } catch {}
    if (!topic) return;
    try {
      await fetchImpl(NTFY, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ topic, title, message, priority: 3, tags: ['wrench'] }) });
    } catch (e) { log(`ntfy fehlgeschlagen: ${e.message}`); }
  };
  async function look() {
    let dashOk = false, age = null, gatewayOk = false;
    try {
      const r = await fetchImpl(DASH_URL, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { dashOk = true; age = dashAge(await r.text()); }
    } catch {}
    try {
      const r = await fetchImpl(`${GATEWAY}/v1/state`, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
      gatewayOk = r.ok && Number.isSafeInteger((await r.json())?.counted);
    } catch {}
    return { dashOk, age, gatewayOk };
  }
  async function check(st) {
    const seen = await look();
    const d = decide(seen, st, now());
    if (d.action === 'restart') {
      st.lastRestart = now();
      try {
        await restart();
        st.badChecks = 0;
        log(`${PM2_NAME} neu gestartet: ${d.reason}`);
        await notify(`${PM2_NAME} neu gestartet`, `Das RESET-Dashboard hing (${d.reason}) und wurde neu gestartet.`);
      } catch (e) {
        log(`Neustart von ${PM2_NAME} fehlgeschlagen: ${e.message}`);
        await notify(`${PM2_NAME}: Neustart fehlgeschlagen`, `${d.reason}. Fehler: ${e.message}`);
      }
    }
    return { ...d, ...seen };
  }
  return { look, check };
}

function fileLog(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

async function main() {
  fileLog(`reset-dash-watch startet: prueft ${DASH_URL} alle ${EVERY_MS / 1000}s, Neustart von ${PM2_NAME} ab ${STALE_MIN} min ohne Aktualisierung`);
  const w = makeWatcher({ log: fileLog });
  const st = { badChecks: 0, lastRestart: 0 };
  let last = '';
  for (;;) {
    try {
      const r = await Promise.race([w.check(st), new Promise((_, no) => setTimeout(() => no(new Error('Pruefung haengt')), 120000))]);
      const line = `${r.action}: ${r.reason}`;
      // Log the first result and every change of state, not each quiet check.
      if (r.action !== 'ok' || !last.startsWith('ok')) { if (line !== last) fileLog(line); }
      last = line;
    } catch (e) { fileLog(`Fehler: ${e.message}`); last = ''; }
    await new Promise(r => setTimeout(r, EVERY_MS));
  }
}

if (!process.env.RDW_TEST) main();
