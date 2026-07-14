// Suite offline 3/3 — coordinamento L3 su bus di messaggi simulato, con i
// componenti REALI (Teamwork, Coordinator, BdiAgent, PlanExecutor): discovery,
// scambio credenze, isolamento missioni, rendezvous, relay, red-light.
// Run: node experiments/offline/coordination_suite.mjs

import { EventEmitter } from 'node:events';
import { Teamwork } from '../../agents/common/Teamwork.js';
import { Coordinator } from '../../agents/llm/Coordinator.js';
import { BdiAgent } from '../../agents/bdi/BdiAgent.js';
import { PlanExecutor } from '../../agents/bdi/PlanExecutor.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeState(me, { zones = [{ x: 3, y: 3 }], cap = 2, parcels = [] } = {}) {
  const map = new Map();
  for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) map.set(`${x},${y}`, '3');
  for (const z of zones) map.set(`${z.x},${z.y}`, '2');
  const pMap = new Map(parcels.map(p => [p.id, p]));
  return { me, map, mapWidth: 7, mapHeight: 7, parcels: pMap, agents: new Map(),
    deliveryZones: zones, spawnZones: [{ x: 0, y: 0 }],
    config: { capacity: cap, vision: 5, movementDuration: 0 },
    get carrying() { return [...pMap.values()].filter(p => p.carriedBy === me.id); },
    get freeParcels() { return [...pMap.values()].filter(p => !p.carriedBy); } };
}
class Bus { constructor() { this.c = new Map(); } register(c) { this.c.set(c.state.me.id, c); }
  shout(f, e) { for (const [id, c] of this.c) if (id !== f) c._d(f, e); }
  say(f, t, e) { const c = this.c.get(t); if (c) c._d(f, e); } }
class FC extends EventEmitter {
  constructor(bus, me, opts) { super(); this.bus = bus; this.said = []; this.state = makeState(me, opts); bus.register(this); }
  shout(e) { this.bus.shout(this.state.me.id, e); }
  say(t, e) { this.said.push({ t, e }); this.bus.say(this.state.me.id, t, e); return Promise.resolve(); }
  _d(f, m) { this.emit('msg', { fromId: f, fromName: f, msg: m }); }
}
const bdiStub = () => ({ coord: null, _n: null,
  setCoordination(t, n) { this.coord = t; this._n = n; },
  clearCoordination() { this.coord = null; },
  arrive() { if (this._n) this._n('ready', this.coord); } });

// ===== discovery + scambio credenze + isolamento ==============================
{
  const bus = new Bus();
  const cA = new FC(bus, { id: 'A1', x: 0, y: 0, score: 0 });
  const cB = new FC(bus, { id: 'B1', x: 6, y: 6, score: 0 });
  const tA = new Teamwork(cA, { role: 'A', secret: 's' });
  const tB = new Teamwork(cB, { role: 'B', secret: 's' });
  let missionsLeaked = 0;
  cA.on('msg', ({ fromId, fromName, msg }) => tA.ingest(fromId, fromName, msg));
  cB.on('msg', ({ fromId, fromName, msg }) => { if (!tB.ingest(fromId, fromName, msg)) missionsLeaked++; });
  tA._announce();
  ok('discovery reciproca', tA.teammate?.id === 'B1' && tB.teammate?.id === 'A1');
  cA.state.me.x = 3; cA.state.me.y = 4;
  tA.broadcastState();
  ok('scambio credenze: B vede la posizione di A', tB.teammate.x === 3 && tB.teammate.y === 4);
  ok('messaggi team non trattati come missioni', missionsLeaked === 0);
  cB._d('GOD', 'Deliver stacks of exactly 3 parcels'); // missione vera: NON team
  ok('missione vera passa il filtro', missionsLeaked === 1);
}

// ===== rendezvous end-to-end ====================================================
{
  const bus = new Bus();
  const cA = new FC(bus, { id: 'A1', x: 0, y: 0, score: 0 });
  const cB = new FC(bus, { id: 'B1', x: 6, y: 6, score: 0 });
  const tA = new Teamwork(cA, { role: 'A', secret: 's' });
  const tB = new Teamwork(cB, { role: 'B', secret: 's' });
  const sA = bdiStub(); const sB = bdiStub();
  const nA = st => tA.sendStatus(st);
  cA.on('msg', ({ fromId, fromName, msg }) => tA.ingest(fromId, fromName, msg));
  cB.on('msg', ({ fromId, fromName, msg }) => tB.ingest(fromId, fromName, msg));
  tA.on('coord', ({ cmd, x, y, dist }) => {
    if (cmd === 'rendezvous') sA.setCoordination({ type: 'goto_wait', x, y, dist }, nA);
    else if (cmd === 'release') sA.clearCoordination();
  });
  tA._announce();
  const coord = new Coordinator({ client: cB, bdi: sB, team: tB });
  coord.handle({ task: 'rendezvous', x: 5, y: 5, dist: 3, reward: 500 }, 'MISSION');
  ok('B imposta il proprio goto_wait', sB.coord?.type === 'goto_wait' && sB.coord.dist === 3);
  ok('A riceve la direttiva', sA.coord?.type === 'goto_wait' && sA.coord.x === 5);
  sB.arrive();
  ok('solo B pronto: non completa', !cB.said.some(s => s.t === 'MISSION' && typeof s.e === 'string'));
  sA.arrive();
  const done = cB.said.find(s => s.t === 'MISSION' && /rendezvous complete/i.test(s.e));
  ok('entrambi pronti -> notifica al mission-agent', !!done);
  await sleep(2200);
  ok('release: B torna al gioco', sB.coord === null);
  ok('release: A torna al gioco', sA.coord === null);
}

// ===== rendezvous: macchina a stati del BDI reale ===============================
{
  const st = makeState({ id: 'X', x: 0, y: 0 });
  const a = new BdiAgent({ client: { on() {}, state: st }, planner: { findPath: async () => [] } });
  const states = [];
  a.setCoordination({ type: 'goto_wait', x: 5, y: 5, dist: 3 }, s => states.push(s));
  let r = a._deliberate();
  ok('lontano -> viaggia (coord)', r.intention === 'coord' && r.target.x === 5);
  st.me.x = 5; st.me.y = 3;
  r = a._deliberate(); a._deliberate();
  ok('nel raggio -> attende', r.target === null && r.intention === 'coord-wait');
  ok('notify ready una sola volta', states.filter(s => s === 'ready').length === 1);
  a.clearCoordination();
  ok('clear -> normale', a.beliefs.coordination === null);
}

// ===== relay: ruoli, piano, esecuzione ==========================================
{
  const HANDOFF = { x: 3, y: 2 };
  // collector: raccoglie ignorando la pila, pieno -> porta allo scambio
  const st = makeState({ id: 'A', x: 1, y: 1 }, { cap: 2, parcels: [
    { id: 'c1', x: 1, y: 1, reward: 5, carriedBy: 'A' }, { id: 'c2', x: 1, y: 1, reward: 5, carriedBy: 'A' },
    { id: 'pile', x: 3, y: 2, reward: 9 }] });
  const a = new BdiAgent({ client: { on() {}, state: st }, planner: { findPath: async () => ['right'] } });
  a.setCoordination({ type: 'relay', role: 'collector', handoff: HANDOFF });
  const r = a._deliberate();
  ok('collector pieno -> relay_drop allo scambio', r.intention === 'relay_drop' && r.target.x === 3);
  const steps = await a._buildPlan(r.target, r.intention);
  ok('piano termina con relay_drop', steps.at(-1) === 'relay_drop');
  // esecuzione del drop: non conta come consegna
  st.me.x = 3; st.me.y = 2;
  let put = false;
  const client = { state: st, putdown: async () => { put = true; return [{ id: 'c1' }, { id: 'c2' }] } };
  a.beliefs.currentPlan = { targetId: 'relay_drop', steps: ['relay_drop'] };
  const res = await new PlanExecutor(client, a.beliefs).executeStep('relay_drop', r.target);
  ok('relay_drop esegue il putdown', put && res === 'done');
  ok('drop NON conta come consegna', a.beliefs.metrics.deliveries === 0);
  // deliverer: prende dalla pila e consegna
  const st2 = makeState({ id: 'B', x: 4, y: 2 }, { parcels: [{ id: 'pile', x: 3, y: 2, reward: 9 }] });
  const b2 = new BdiAgent({ client: { on() {}, state: st2 }, planner: { findPath: async () => [] } });
  b2.setCoordination({ type: 'relay', role: 'deliverer', handoff: HANDOFF });
  ok('deliverer raccoglie dalla pila', b2._deliberate().intention === 'pickup');
  st2.parcels.get('pile').carriedBy = 'B';
  ok('deliverer carico -> consegna', b2._deliberate().intention === 'deliver');
}

// ===== red light / green light ===================================================
{
  const st = makeState({ id: 'A', x: 0, y: 0 });
  const a = new BdiAgent({ client: { on() {}, state: st }, planner: { findPath: async () => [] } });
  a.setCoordination({ type: 'red_light', parity: 'odd' });
  let r = a._deliberate();
  ok('va alla riga dispari piu vicina', r.intention === 'coord' && r.target.y % 2 === 1);
  st.me.x = r.target.x; st.me.y = r.target.y;
  r = a._deliberate();
  ok('congelato sulla riga', r.target === null && r.intention === 'coord-wait');
  // il "go" via Coordinator
  const bus = new Bus();
  const cB = new FC(bus, { id: 'B1', x: 6, y: 6, score: 0 });
  const tB = new Teamwork(cB, { role: 'B', secret: 's' });
  const sB = bdiStub();
  const coord = new Coordinator({ client: cB, bdi: sB, team: tB });
  coord.handle({ task: 'red_light', parity: 'odd', reward: 700 }, 'M');
  ok('attende il go', coord.isAwaitingGo());
  coord.go('M');
  ok('go rilascia', !coord.isAwaitingGo() && sB.coord === null);
}

console.log(`\nCOORDINATION SUITE: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
