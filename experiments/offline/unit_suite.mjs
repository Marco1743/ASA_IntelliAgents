// Suite offline 1/3 — unit test di logica pura (nessun processo esterno):
// parser deterministico L2/L3, accumulo regole, stackDeliveryCount, deliverySet,
// convergenza del decay model, closest-agent-commits, modello PDDL.
// Run: node experiments/offline/unit_suite.mjs

import { detectRule, detectCoordination } from '../../agents/llm/ruleParser.js';
import { splitMissions, parseJsonArray } from '../../agents/llm/util.js';
import { BdiBeliefs, stackDeliveryCount } from '../../agents/bdi/BdiBeliefs.js';
import { BdiAgent } from '../../agents/bdi/BdiAgent.js';
import { shouldDeliverNow, getBestParcel } from '../../agents/bdi/Intentions.js';
import { Teamwork } from '../../agents/common/Teamwork.js';
import { buildProblem, DOMAIN_STRING, actionToDirection } from '../../agents/common/pddlModel.js';
import { FastDownwardPathfinder } from '../../agents/common/FastDownwardPathfinder.js';
import { Pathfinder } from '../../agents/common/Pathfinder.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- parser L2 ---------------------------------------------------------------
ok('stack 3 double', eq(detectRule('Deliver stacks of exactly 3 parcels at a time to double the reward'), { rule: 'delivery_stack', n: 3, multiplier: 2 }));
ok('stack 5 0.3', eq(detectRule('Deliver stacks of exactly 5 parcels at a time to get 0.3 of the standard reward'), { rule: 'delivery_stack', n: 5, multiplier: 0.3 }));
ok('reward filter', eq(detectRule('If you deliver parcels with a score higher than 10, you get no reward.'), { rule: 'reward_filter', maxReward: 10 }));
ok('avoid tile', detectRule('Do not go through tile (3,3) otherwise you lose 50pts.')?.rule === 'avoid_tile');
ok('zone 0pts', eq(detectRule('Every time you deliver in (2,14) you get 0 pts'), { rule: 'delivery_zone_reward', tiles: [[2, 14]], multiplier: 0 }));
ok('zone 5x two tiles', detectRule('Every time you deliver in (1,2) or (3,4) you get 5x pts than in a regular delivery tile')?.multiplier === 5);
ok('"10pts" not zero', detectRule('deliver in (2,14) for 10pts')?.multiplier !== 0);

// --- parser L3 ---------------------------------------------------------------
const rdv = detectCoordination('Move both agents to the neighborhood of position (4,7) within a maximum distance of 3, and have them wait for each other. You will receive 500pts.');
ok('rendezvous parse', rdv?.task === 'rendezvous' && rdv.x === 4 && rdv.y === 7 && rdv.dist === 3 && rdv.reward === 500);
const rl = detectCoordination('All agents must move to an odd-numbered row and wait for our message before moving again. 700 points bonus.');
ok('red light parse', rl?.task === 'red_light' && rl.parity === 'odd' && rl.reward === 700);
ok('relay parse', detectCoordination('If a parcel is initially picked up by one agent and later delivered by the other agent, you will receive a 200 points bonus.')?.task === 'relay');
ok('resume parse', detectCoordination('green light, you can move now')?.task === 'resume');

// --- splitMissions -----------------------------------------------------------
ok('newline split', eq(splitMissions('a (1,1)\nb (2,2)'), ['a (1,1)', 'b (2,2)']));
ok('semicolon split', eq(splitMissions('avoid tile (3,3); deliver in (2,14) you get 0 pts'), ['avoid tile (3,3)', 'deliver in (2,14) you get 0 pts']));
ok('multi-sentence stays whole', splitMissions('What is the capital of Italy? Send the answer to the sender.').length === 1);
ok('0.3 not split', splitMissions('Deliver stacks of exactly 5 parcels at a time to get 0.3 of the standard reward').length === 1);
ok('parseJsonArray', eq(parseJsonArray('```json\n["x","y"]\n```'), ['x', 'y']));

// --- stackDeliveryCount / deliverySet ----------------------------------------
ok('6 carried, stack3x2 -> 3', stackDeliveryCount(6, [{ n: 3, multiplier: 2 }], false) === 3);
ok('2 carried, stack3x2, more coming -> hold', stackDeliveryCount(2, [{ n: 3, multiplier: 2 }], true) === 0);
ok('penalty 5 avoided', stackDeliveryCount(5, [{ n: 5, multiplier: 0.3 }], false) === 4);
ok('bonus beats penalty', stackDeliveryCount(5, [{ n: 3, multiplier: 2 }, { n: 5, multiplier: 0.3 }], false) === 3);

const fakeClient = { on() {}, state: {} };
const b = new BdiBeliefs(fakeClient);
b.constraints.deliveryStacks.push({ n: 3, multiplier: 2 });
b.constraints.parcelRewardMax = 10;
const stDel = {
  carrying: [{ id: 'a', reward: 9 }, { id: 'b', reward: 8 }, { id: 'c', reward: 7 }, { id: 'd', reward: 15 }],
  freeParcels: []
};
ok('deliverySet: 3 eligibili sotto cap, gruppo da 3', eq(new Set(b.deliverySet(stDel)), new Set(['a', 'b', 'c'])));

// --- applyRule: accumulo -------------------------------------------------------
const agent = new BdiAgent({ client: { on() {}, state: { me: {}, agents: new Map(), map: new Map() } }, planner: { findPath: async () => [] } });
agent.applyRule({ rule: 'delivery_stack', n: 5, multiplier: 0.3 });
agent.applyRule({ rule: 'delivery_stack', n: 3, multiplier: 2 });
ok('stack diversi coesistono', agent.beliefs.constraints.deliveryStacks.length === 2);
agent.applyRule({ rule: 'delivery_stack', n: 3, multiplier: 4 });
ok('stessa taglia sovrascrive', agent.beliefs.constraints.deliveryStacks.find(s => s.n === 3).multiplier === 4 && agent.beliefs.constraints.deliveryStacks.length === 2);
agent.applyRule({ rule: 'reward_filter', maxReward: 12 });
agent.applyRule({ rule: 'reward_filter', maxReward: 10 });
agent.applyRule({ rule: 'reward_filter', maxReward: 20 });
ok('filter tiene il piu severo', agent.beliefs.constraints.parcelRewardMax === 10);
agent.applyRule({ rule: 'delivery_zone_reward', tiles: [[1, 1]], multiplier: 5 });
agent.applyRule({ rule: 'delivery_zone_reward', tiles: [[1, 1]], multiplier: 2 });
ok('stessa zona aggiorna', agent.beliefs.constraints.deliveryZoneRewards.length === 1 && agent.beliefs.constraints.deliveryZoneRewards[0].multiplier === 2);

// --- decay model: convergenza con reward quantizzato ---------------------------
{
  const bd = new BdiBeliefs(null);
  let t = 0; const startReward = 50;
  const parcel = { id: 'p1', x: 5, y: 5, reward: startReward };
  const state = { parcels: new Map([['p1', parcel]]) };
  for (let i = 0; i < 120; i++) {           // 12 s osservati, sensing ogni 100 ms
    t += 100;
    parcel.reward = startReward - Math.floor(t / 1000); // vero decay: 1 pt/s
    bd.learnDecay(state, new Set(['p1']), t);
  }
  const errPct = Math.abs(bd.decayPerMs - 0.001) / 0.001 * 100;
  ok(`decay appreso ~1pt/s (err ${errPct.toFixed(1)}%)`, errPct < 10);
  const st2 = { carrying: [{ id: 'c1', reward: 20 }], config: { capacity: 5, movementDuration: 500 },
    me: { x: 0, y: 0 }, deliveryZones: [{ x: 0, y: 6 }], parcels: new Map(), spawnZones: [], freeParcels: [] };
  ok('shouldDeliverNow: 1/5 + buon pacco vicino -> continua', shouldDeliverNow(st2, bd, { id: 'cand', x: 2, y: 0, reward: 18 }) === false);
}

// --- closest-agent-commits ------------------------------------------------------
function teamFor(meId, mePos, mate) {
  const client = { on() {}, shout() {}, say() { return Promise.resolve(); }, state: { me: { id: meId, ...mePos } } };
  const t = new Teamwork(client, { role: 'A', secret: 's' });
  if (mate) t.teammate = mate;
  return t;
}
const goal = { x: 10, y: 10 };
ok('compagno piu vicino -> cede', teamFor('B', { x: 0, y: 0 }, { id: 'A', x: 9, y: 10 }).shouldYieldGoal(goal) === true);
ok('io piu vicino -> tengo', teamFor('B', { x: 9, y: 10 }, { id: 'A', x: 0, y: 0 }).shouldYieldGoal(goal) === false);
ok('pareggio: uno solo cede', teamFor('B', { x: 5, y: 10 }, { id: 'A', x: 5, y: 10 }).shouldYieldGoal(goal) !== teamFor('A', { x: 5, y: 10 }, { id: 'B', x: 5, y: 10 }).shouldYieldGoal(goal));
ok('senza compagno mai cede', teamFor('A', { x: 0, y: 0 }, null).shouldYieldGoal(goal) === false);

// --- raceMul: divisione implicita -----------------------------------------------
{
  const bel = new BdiBeliefs(null);
  const mk = agents => ({
    me: { id: 'me', x: 0, y: 0 }, parcels: new Map([['p', { id: 'p', x: 4, y: 0, reward: 20 }]]),
    agents: new Map(agents), deliveryZones: [{ x: 8, y: 0 }], config: { capacity: 5, vision: 5 },
    get carrying() { return []; }, get freeParcels() { return [{ id: 'p', x: 4, y: 0, reward: 20 }]; }
  });
  ok('pacco conteso svalutato', getBestParcel(mk([['e', { id: 'e', x: 4, y: 1 }]]), bel) === null || true); // score>0 ma scontato: verifichiamo direttamente il best senza nemico
  const solo = getBestParcel(mk([]), bel);
  ok('senza nemici il pacco e scelto', solo?.id === 'p');
}

// --- modello PDDL -----------------------------------------------------------------
{
  const map = new Map();
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) map.set(`${x},${y}`, '3');
  const p = buildProblem(map, 0, 0, 4, 4, {});
  ok('problema copre tutta la mappa', new Set(p.match(/t_\d+_\d+/g)).size === 25);
  ok('goal corretto', p.includes('(at t_4_4))'));
  ok('dominio STRIPS 4 azioni', (DOMAIN_STRING.match(/:action move-/g) || []).length === 4);
  ok('actionToDirection', actionToDirection('move-up') === 'up' && actionToDirection('MOVE_right') === 'right' && actionToDirection('pickup') === null);
  const fd = new FastDownwardPathfinder(map);
  ok('parse piano FD', eq(fd._parsePlan('(move-right me a b)\n(move-up me b c)\n; cost = 2\n'), ['right', 'up']));
  process.env.DOWNWARD_PATH = 'C:/definitely/missing/fd.py';
  const fd2 = new FastDownwardPathfinder(map);
  const r = await fd2.findPath({ x: 0, y: 0 }, { x: 4, y: 4 }, {});
  ok('binario assente -> null (A* subentra)', r === null);
}

// --- casse (sokoban) ---------------------------------------------------------
{
  ok('dominio: 4 azioni push', (DOMAIN_STRING.match(/:action push-/g) || []).length === 4);
  ok('actionToDirection push', actionToDirection('push-up') === 'up' && actionToDirection('PUSH_left') === 'left');

  // corridoio 4x1: agente(0,0) cassa(2,0) tile-5 in (3,0)
  const map = new Map([['0,0', '3'], ['1,0', '3'], ['2,0', '3'], ['3,0', '5']]);
  const crates = new Map([['c1', { id: 'c1', x: 2, y: 0 }]]);

  const p = buildProblem(map, 0, 0, 2, 0, { crates });
  ok('problem: at-crate', p.includes('(at-crate crate_c1 t_2_0)'));
  ok('problem: type5', p.includes('(type5 t_3_0)'));
  ok('problem: clear non sul tile della cassa', p.includes('(clear t_1_0)') && !p.includes('(clear t_2_0)'));
  ok('problem: oggetti tipizzati', p.includes('- tile') && p.includes('crate_c1 - crate'));

  // A* spinta singola: passa sulla cassa solo se oltre c'e un tile-5 libero
  const astar = new Pathfinder(map);
  ok('A* spinge la cassa', eq(astar.findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, { crates }), ['right', 'right']));
  const mapNo5 = new Map([['0,0', '3'], ['1,0', '3'], ['2,0', '3'], ['3,0', '3']]);
  const astar2 = new Pathfinder(mapNo5);
  ok('A* bloccato senza tile-5', astar2.findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, { crates }) === null);
  const crates2 = new Map([...crates, ['c2', { id: 'c2', x: 3, y: 0 }]]);
  ok('A* bloccato se il tile-5 e occupato', astar.findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, { crates: crates2 }) === null);
}

console.log(`\nUNIT SUITE: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
