// Suite offline 2/3 — pipeline LLM end-to-end con modello SIMULATO (nessuna
// rete): routing delle missioni L1 del PDF, regole L2 applicate e condivise,
// segmentazione, fallback con LLM irraggiungibile.
// Run: node experiments/offline/pipeline_suite.mjs

import { LlmAgent } from '../../agents/llm/LlmAgent.js';
import { LlmPlanner } from '../../agents/llm/LlmPlanner.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

// mondo finto: 10x10 tutto camminabile, delivery lungo x=0
const map = new Map();
for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) map.set(`${x},${y}`, x === 0 ? '2' : '3');
const deliveryZones = []; for (let y = 0; y < 10; y++) deliveryZones.push({ x: 0, y });
const state = { me: { id: 'B', x: 5, y: 5, score: 0 }, map, mapWidth: 10, mapHeight: 10, deliveryZones,
  parcels: new Map(), agents: new Map(), config: { capacity: 5, vision: 5 },
  get freeParcels() { return []; }, get carrying() { return []; } };

function makeAgent(scripted, { team = null } = {}) {
  let i = 0;
  const llm = { async chat(msgs) {
    if (msgs[0].content.startsWith('You split')) return scripted.seg ?? '["single"]';
    return scripted.replies[Math.min(i++, scripted.replies.length - 1)];
  } };
  const goals = [], rules = [], answers = [];
  const client = { state, say: async (id, m) => answers.push({ id, m }) };
  const bdi = { beliefs: { constraints: {} }, addMissionGoal: g => goals.push(g), applyRule: r => { rules.push(r); return true; } };
  return { agent: new LlmAgent({ client, bdi, llm, team }), goals, rules, answers };
}

// --- L1: le 5 missioni del PDF -------------------------------------------------
{
  const { agent, answers } = makeAgent({ replies: ['Thought: calc.\nAction: calculate\nAction Input: 5*5', 'Thought: done.\nDecision: {"kind":"answer","effect":{"text":"25"}}'] });
  await agent.handleMission('Calculate 5*5', 's');
  ok('L1 calculate 5*5 -> 25', answers[0]?.m === '25');
}
{
  const { agent, answers } = makeAgent({ replies: ['Decision: {"kind":"answer","effect":{"text":"Rome"}}'] });
  await agent.handleMission('What is the capital of Italy? Send the answer to the agent who sent the prompt', 's');
  ok('L1 capital -> Rome al mittente', answers[0]?.m === 'Rome' && answers[0]?.id === 's');
}
{
  const { agent, goals } = makeAgent({ replies: ['Decision: {"kind":"goal","effect":{"goal":"goto","x":4,"y":7,"reward":10}}'] });
  await agent.handleMission('Move to coordinate (4,7) and you get +10pts', 's');
  ok('L1 goto queued', goals.length === 1 && goals[0].x === 4 && goals[0].y === 7);
}
{
  const { agent, goals } = makeAgent({ replies: [
    'Action: calculate\nAction Input: 4*2', 'Action: calculate\nAction Input: (1+3)*3',
    'Decision: {"kind":"goal","effect":{"goal":"goto","x":8,"y":12,"reward":-10}}'] });
  await agent.handleMission('Move to x=4*2 y=(1+3)*3 to get -10pts', 's');
  ok('L1 trappola scartata', goals.length === 0);
}
{
  const { agent, goals } = makeAgent({ replies: ['Decision: {"kind":"goal","effect":{"goal":"drop_at","where":"leftmost","reward":5}}'] });
  await agent.handleMission('Drop a package in the leftmost tile to get 5pt', 's');
  ok('L1 leftmost -> tile di consegna x=0', goals.length === 1 && goals[0].kind === 'drop_at' && goals[0].x === 0);
}
// goal fuori mappa rifiutato
{
  const { agent, goals } = makeAgent({ replies: ['Decision: {"kind":"goal","effect":{"goal":"goto","x":4,"y":30,"reward":10}}'] });
  await agent.handleMission('Move to coordinate (4,30) and you get +10pts', 's');
  ok('goal fuori mappa rifiutato', goals.length === 0);
}

// --- L2: regola applicata E condivisa col compagno -------------------------------
{
  let sharedRule = null, sharedGoal = null;
  const team = { sendRule: r => sharedRule = r, sendGoal: g => sharedGoal = g };
  const { agent, rules, goals } = makeAgent({ replies: ['Decision: {"kind":"rule","effect":{"rule":"delivery_stack","n":3,"multiplier":2}}'] }, { team });
  await agent.handleMission('Deliver stacks of exactly 3 parcels at a time to double the reward', 's');
  ok('L2 regola applicata', rules[0]?.n === 3);
  ok('L2 regola inoltrata ad A', sharedRule?.n === 3);
  const { agent: a2, goals: g2 } = makeAgent({ replies: ['Decision: {"kind":"goal","effect":{"goal":"goto","x":4,"y":7,"reward":10}}'] }, { team });
  await a2.handleMission('Move to coordinate (4,7) and you get +10pts', 's');
  ok('L1 goal inoltrato ad A', sharedGoal?.x === 4 && g2.length === 1);
}

// --- segmentazione: "and" fra due missioni vs "and" interno ----------------------
{
  const seg = '["Move to (4,7) for +10pts", "deliver stacks of 3 to double the reward"]';
  const { agent, goals, rules } = makeAgent({ seg, replies: [
    'Decision: {"kind":"goal","effect":{"goal":"goto","x":4,"y":7,"reward":10}}',
    'Decision: {"kind":"rule","effect":{"rule":"delivery_stack","n":3,"multiplier":2}}'] });
  await agent.handleMessage('Move to (4,7) for +10pts and deliver stacks of 3 to double the reward', 's');
  ok('and separa due missioni', goals.length === 1 && rules.length === 1);
}
{
  const seg = '["All agents move to an odd row and wait for our message. 700 points bonus."]';
  const { agent } = makeAgent({ seg, replies: ['Decision: {"kind":"ignore","effect":{}}'] });
  const parts = await agent.segment('All agents move to an odd row and wait for our message. 700 points bonus.');
  ok('and interno resta UNA missione', parts.length === 1);
}

// --- robustezza: LLM giu -> fallback deterministico -------------------------------
{
  const llm = { async chat() { throw new Error('Connection error'); } };
  const rules = []; const client = { state, say: async () => {} };
  const bdi = { beliefs: { constraints: {} }, applyRule: r => { rules.push(r); return true; } };
  const agent = new LlmAgent({ client, bdi, llm });
  await agent.handleMission('Deliver stacks of exactly 3 parcels at a time to double the reward', 's');
  ok('LLM giu -> parser applica la regola', rules[0]?.n === 3 && rules[0]?.multiplier === 2);
}
// output invalido -> retry con richiamo al formato
{
  let calls = 0;
  const llm = { async chat() { calls++; return calls === 1 ? 'garbage output' : 'Decision: {"kind":"answer","effect":{"text":"ok"}}'; } };
  const planner = new LlmPlanner(llm, { state });
  const d = await planner.plan('test', {});
  ok('formato invalido -> retry e decisione', d?.kind === 'answer' && calls === 2);
}
// tool sconosciuto -> errore come Observation, il modello si corregge
{
  let calls = 0;
  const llm = { async chat(msgs) {
    calls++;
    if (calls === 1) return 'Action: bogus_tool\nAction Input: x';
    ok('errore tool tornato come Observation', /Error: unknown tool/.test(msgs.at(-1).content));
    return 'Decision: {"kind":"ignore","effect":{}}';
  } };
  await new LlmPlanner(llm, { state }).plan('test', {});
}

console.log(`\nPIPELINE SUITE: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
