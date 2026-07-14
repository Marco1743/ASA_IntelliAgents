// Driver dei test live per l'agente LLM: L1 (missioni atomiche), L2 (regole
// persistenti con verifica comportamentale), L3 (coordinamento con Agente A).
// Scrive experiments/raw/llm_test_report.json e i log grezzi dei processi.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AG   = join(__dirname, '..');
const SRV  = 'C:/Users/marco/Desktop/asa/Deliveroo.js/backend';
const NODE = 'C:/nvm4w/nodejs/node.exe';
const RAW  = join(__dirname, 'raw');
const PORT = 8083;
const MAP  = '26c1_1';
mkdirSync(RAW, { recursive: true });

// --- coordinate valide dalla mappa -----------------------------------------
const level = JSON.parse(readFileSync(
  `C:/Users/marco/Desktop/asa/Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games/${MAP}.json`, 'utf8'));
const tiles = level.map.tiles; // tiles[x][y]
const delivery = [], walkable = [];
for (let x = 0; x < level.map.width; x++)
  for (let y = 0; y < level.map.height; y++) {
    const t = String(tiles[x]?.[y] ?? '0');
    if (t === '2') delivery.push({ x, y });
    else if (t !== '0') walkable.push({ x, y });
  }
const mid = walkable[Math.floor(walkable.length / 2)];
const avoidT = walkable[Math.floor(walkable.length / 3)];
const [z1, z2] = [delivery[0], delivery[delivery.length - 1]];
console.log(`[driver] map ${MAP}: ${delivery.length} delivery, ${walkable.length} walkable; goto=(${mid.x},${mid.y}) avoid=(${avoidT.x},${avoidT.y}) zones=(${z1.x},${z1.y}),(${z2.x},${z2.y})`);

// --- infrastruttura ----------------------------------------------------------
const t0 = Date.now();
const now = () => Date.now() - t0;
function tracked(name, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, shell: false });
  p.lines = [];
  p.logName = name;
  const push = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => p.lines.push({ t: now(), l }));
  p.stdout.on('data', push);
  p.stderr.on('data', push);
  return p;
}
function waitFor(p, re, timeoutMs, since = 0) {
  return new Promise(resolve => {
    const from = since;
    const check = () => {
      for (let i = from; i < p.lines.length; i++)
        if (re.test(p.lines[i].l)) return resolve({ ok: true, i, t: p.lines[i].t, line: p.lines[i].l });
      if (now() - start > timeoutMs) return resolve({ ok: false, i: p.lines.length });
      setTimeout(check, 150);
    };
    const start = now();
    check();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { map: MAP, startedAt: new Date().toISOString(), l1: [], l2: [], l3: [], meta: {} };

// --- server -------------------------------------------------------------------
const server = tracked('server', NODE, ['index.js'],
  { cwd: SRV, env: { ...process.env, GAME_NAME: MAP, PORT: String(PORT) } });
await sleep(7000);

// --- Agente B (LLM) -------------------------------------------------------------
const envB = { ...process.env, HOST: `http://localhost:${PORT}`, TOKEN: '', NAME: 'llmB', TEAM_SECRET: 'exp-team' };
const B = tracked('agentB', NODE, ['LLM_agent.js'], { cwd: AG, env: envB });
const ready = await waitFor(B, /\[llm\] ready/, 30000);
if (!ready.ok) { console.log('[driver] FATAL: agent B not ready'); process.exit(1); }
console.log('[driver] agent B ready');

let cursor = B.lines.length;
async function mission(text, checks, timeoutMs = 45000) {
  const sentAt = now();
  const from = B.lines.length;
  B.stdin.write(text + '\n');
  const out = { mission: text, sentAt, checks: [] };
  // latenza alla decisione (o al fallback)
  const dec = await waitFor(B, /\[llm\] (decision:|planner produced no decision)/, timeoutMs, from);
  out.decisionMs = dec.ok ? dec.t - sentAt : null;
  out.viaFallback = dec.ok ? /produced no decision/.test(dec.line) : null;
  out.decisionLine = dec.ok ? dec.line : 'TIMEOUT';
  for (const c of checks) {
    const r = await waitFor(B, c.re, c.timeoutMs ?? timeoutMs, from);
    out.checks.push({ name: c.name, pass: r.ok, at: r.ok ? r.t - sentAt : null, line: r.ok ? r.line : null });
  }
  console.log(`[driver] ${out.viaFallback ? 'FBK' : 'LLM'} ${out.decisionMs}ms | ${text.slice(0, 60)} | ` +
    out.checks.map(c => `${c.name}:${c.pass ? 'OK' : 'FAIL'}`).join(' '));
  return out;
}

// ============================ FASE L1 ============================
console.log('[driver] === L1 ===');
results.l1.push(await mission('Calculate 5*5',
  [{ name: 'answer=25', re: /\[llm\] answer: 25\b/ }]));
results.l1.push(await mission('What is the capital of Italy? Send the answer to the agent who sent the prompt',
  [{ name: 'answer=Rome', re: /\[llm\] answer: .*Rome/i }]));
results.l1.push(await mission(`Move to coordinate (${mid.x},${mid.y}) and you get +50pts`,
  [{ name: 'goal-queued', re: new RegExp(`mission goal queued: g\\d+ goto\\(${mid.x},${mid.y}\\)`) },
   { name: 'goal-done', re: /mission goal done/, timeoutMs: 90000 }]));
results.l1.push(await mission('Move to x=4*2 y=(1+3)*3 to get -10pts',
  [{ name: 'trap-dropped', re: /dropping it \(trap\)|payoff is -?\d+ \(<= 0\)/ }]));
results.l1.push(await mission('Drop a package in the leftmost tile to get 5pt',
  [{ name: 'dropgoal-queued', re: /mission goal queued: g\d+ drop_at\(/ }]));

// ============================ FASE L2 ============================
console.log('[driver] === L2 ===');
results.l2.push(await mission('Deliver stacks of exactly 3 parcels at a time to double the reward',
  [{ name: 'rule-stack3', re: /L2 rule applied: .*"deliveryStacks":\[\{"n":3,"multiplier":2\}/ },
   { name: 'delivers-in-3', re: /delivery at .*requested 3, server dropped 3/, timeoutMs: 150000 }]));
results.l2.push(await mission(`Every time you deliver in (${z1.x},${z1.y}) or (${z2.x},${z2.y}) you get 5x pts than in a regular delivery tile`,
  [{ name: 'rule-zone5x', re: /"deliveryZoneRewards":\[.*"multiplier":5/ }]));
results.l2.push(await mission('If you deliver parcels with a score higher than 10, you get no reward.',
  [{ name: 'rule-cap10', re: /"parcelRewardMax":10/ }]));
results.l2.push(await mission(`Do not go through tile (${avoidT.x},${avoidT.y}) otherwise you lose 50pts.`,
  [{ name: 'rule-avoid', re: new RegExp(`"avoidTiles":\\[.*"x":${avoidT.x},"y":${avoidT.y}`) }]));
results.l2.push(await mission('Calculate 7*3 and deliver stacks of exactly 5 parcels at a time to get 0.3 of the standard reward',
  [{ name: 'split-2', re: /message holds 2 missions/ },
   { name: 'answer=21', re: /\[llm\] answer: 21\b/ },
   { name: 'rule-stack5', re: /"n":5,"multiplier":0\.3/ }]));

// ============================ FASE L3 ============================
console.log('[driver] === L3 ===');
const envA = { ...process.env, HOST: `http://localhost:${PORT}`, TOKEN: '', NAME: 'bdiA', TEAM_SECRET: 'exp-team', BDI_USE_PDDL: 'false' };
const A = tracked('agentA', NODE, ['BDI_agent.js'], { cwd: AG, env: envA });
const mateB = await waitFor(B, /teammate found/, 30000, cursor);
const mateA = await waitFor(A, /teammate found/, 30000);
results.l3.push({ test: 'discovery', passB: mateB.ok, passA: mateA.ok, ms: mateB.ok ? mateB.t : null });
console.log(`[driver] discovery: A=${mateA.ok} B=${mateB.ok}`);

// -- rendezvous
{
  const fromA = A.lines.length; const sentAt = now();
  const r = await mission(`Move both agents to the neighborhood of position (${mid.x},${mid.y}) within a maximum distance of 3, and have them wait for each other. You will receive 500pts.`,
    [{ name: 'rendezvous-start', re: /\[coord\] rendezvous near/ },
     { name: 'both-arrived', re: /BOTH agents have arrived/, timeoutMs: 120000 },
     { name: 'released', re: /released both agents/, timeoutMs: 130000 }]);
  const aReady = await waitFor(A, /coordination: ready \(goto_wait\)/, 120000, fromA);
  r.checks.push({ name: 'A-ready', pass: aReady.ok, at: aReady.ok ? aReady.t - sentAt : null });
  results.l3.push(r);
}
await sleep(4000);

// -- relay (finestra di osservazione 150s)
{
  const fromA = A.lines.length; const fromB = B.lines.length;
  const r = await mission('If a parcel is initially picked up by one agent and later delivered by the other agent, you will receive a 200 points bonus.',
    [{ name: 'relay-active', re: /relay active: A = collector/ }]);
  await sleep(150000);
  const handoffs = A.lines.slice(fromA).filter(x => /relay hand-off at .* dropped \d+/.test(x.l));
  const nDropped = handoffs.reduce((s, x) => s + Number(x.l.match(/dropped (\d+)/)[1]), 0);
  const bDeliv = B.lines.slice(fromB).filter(x => /\[bdi\] delivery at/.test(x.l))
      .reduce((s, x) => s + Number((x.l.match(/server dropped (\d+)/) || [0, 0])[1]), 0);
  r.relayStats = { handoffEvents: handoffs.length, parcelsHandedOff: nDropped, parcelsDeliveredByB: bDeliv };
  console.log(`[driver] relay 150s: handoffs=${handoffs.length} parcels=${nDropped} deliveredByB=${bDeliv}`);
  results.l3.push(r);
}

// -- red light / green light
{
  const fromA = A.lines.length; const sentAt = now();
  const r = await mission("All agents must move to an odd-numbered row and wait for our message before moving again, as in a 'red light, green light' game. 700 points bonus.",
    [{ name: 'redlight-start', re: /red light: both agents/ }]);
  const bReady = await waitFor(B, /coordination: ready \(red_light\)/, 90000, cursor);
  const aReady = await waitFor(A, /coordination: ready \(red_light\)/, 90000, fromA);
  r.checks.push({ name: 'B-frozen', pass: bReady.ok, at: bReady.ok ? bReady.t - sentAt : null });
  r.checks.push({ name: 'A-frozen', pass: aReady.ok, at: aReady.ok ? aReady.t - sentAt : null });
  await sleep(3000);
  const fromB2 = B.lines.length; const fromA2 = A.lines.length;
  B.stdin.write('go\n');
  const green = await waitFor(B, /GREEN LIGHT/, 20000, fromB2);
  const aResume = await waitFor(A, /coordination cleared/, 20000, fromA2);
  r.checks.push({ name: 'green-light', pass: green.ok });
  r.checks.push({ name: 'A-resumed', pass: aResume.ok });
  console.log(`[driver] redlight: frozen A=${aReady.ok} B=${bReady.ok} green=${green.ok} resumed=${aResume.ok}`);
  results.l3.push(r);
}

// --- riepilogo LLM vs fallback e latenze -------------------------------------
const all = [...results.l1, ...results.l2];
const lat = all.filter(m => m.decisionMs != null && !m.viaFallback).map(m => m.decisionMs);
results.meta = {
  missionsSent: all.length + 3,
  viaLLM: all.filter(m => m.viaFallback === false).length,
  viaFallback: all.filter(m => m.viaFallback === true).length,
  llmLatencyMs: lat.length ? { min: Math.min(...lat), max: Math.max(...lat), avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) } : null
};

writeFileSync(join(RAW, 'llm_test_report.json'), JSON.stringify(results, null, 2));
writeFileSync(join(RAW, 'llm_agentB.log'), B.lines.map(x => `${x.t} ${x.l}`).join('\n'));
writeFileSync(join(RAW, 'llm_agentA.log'), A.lines.map(x => `${x.t} ${x.l}`).join('\n'));
console.log('[driver] report written. meta=', JSON.stringify(results.meta));

for (const p of [A, B, server]) { try { p.kill(); } catch {} }
process.exit(0);
