// Suite offline 4 — valutazione per-componente della pipeline LLM (stile ablation):
// ogni componente e' testato in isolamento su un piccolo dataset; output = tabella
// componente | casi | passati. Modello scriptato, zero rete.
// Run: node experiments/offline/llm_component_suite.mjs

import { splitMissions, safeJsonParse, parseJsonArray } from '../../agents/llm/util.js';
import { detectRule, detectCoordination } from '../../agents/llm/ruleParser.js';
import { calculate, resolveRelative, getMapInfo, execTool } from '../../agents/llm/tools.js';
import { LlmPlanner } from '../../agents/llm/LlmPlanner.js';
import { LlmAgent } from '../../agents/llm/LlmAgent.js';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const results = [];

function component(name, cases) {
    let passed = 0;
    const failures = [];
    for (const [label, fn] of cases) {
        let okRes = false;
        try { okRes = fn(); } catch (e) { okRes = false; }
        if (okRes) passed++; else failures.push(label);
    }
    results.push({ name, total: cases.length, passed, failures });
}

// fake world: 10x10, delivery lungo x=0
const map = new Map();
for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) map.set(`${x},${y}`, x === 0 ? '2' : '3');
const deliveryZones = []; for (let y = 0; y < 10; y++) deliveryZones.push({ x: 0, y });
const state = { me: { id: 'B', x: 5, y: 5, score: 0 }, map, mapWidth: 10, mapHeight: 10, deliveryZones,
    parcels: new Map(), agents: new Map(), crates: new Map(), config: { capacity: 5, vision: 5 },
    get freeParcels() { return []; }, get carrying() { return []; } };

// --- 1. message splitting ----------------------------------------------------
component('message splitting', [
    ['newline',        () => eq(splitMissions('a (1,1)\nb (2,2)'), ['a (1,1)', 'b (2,2)'])],
    ['semicolon',      () => eq(splitMissions('avoid (3,3); deliver in (2,4)'), ['avoid (3,3)', 'deliver in (2,4)'])],
    ['list markers',   () => eq(splitMissions('1. go to (1,1)\n2. stacks of 3'), ['go to (1,1)', 'stacks of 3'])],
    ['multi-sentence stays whole', () => splitMissions('What is the capital of Italy? Send the answer.').length === 1],
    ['decimals not split', () => splitMissions('stacks of 5 to get 0.3 of the standard reward').length === 1],
]);

// --- 2. L2 rule extraction ---------------------------------------------------
component('L2 rule extraction', [
    ['stack double',   () => eq(detectRule('Deliver stacks of exactly 3 parcels at a time to double the reward'), { rule: 'delivery_stack', n: 3, multiplier: 2 })],
    ['stack 0.3x',     () => eq(detectRule('Deliver stacks of exactly 5 parcels to get 0.3 of the standard reward'), { rule: 'delivery_stack', n: 5, multiplier: 0.3 })],
    ['reward cap',     () => eq(detectRule('If you deliver parcels with a score higher than 10, you get no reward.'), { rule: 'reward_filter', maxReward: 10 })],
    ['avoid tile',     () => detectRule('Do not go through tile (3,3) otherwise you lose 50pts.')?.penalty === 50],
    ['zone 0 pts',     () => detectRule('Every time you deliver in (2,14) you get 0 pts')?.multiplier === 0],
    ['zone 5x multi',  () => detectRule('Every time you deliver in (1,2) or (3,4) you get 5x pts')?.tiles.length === 2],
    ['one-shot not a rule', () => detectRule('Move to coordinate (4,7) and you get +10pts') === null],
    ['"10pts" not zero',    () => detectRule('deliver in (2,14) for 10pts')?.multiplier !== 0],
]);

// --- 3. L3 coordination extraction -------------------------------------------
component('L3 coordination extraction', [
    ['rendezvous',     () => { const r = detectCoordination('Move both agents to the neighborhood of position (4,7) within a maximum distance of 3. You will receive 500pts.'); return r?.task === 'rendezvous' && r.x === 4 && r.dist === 3 && r.reward === 500; }],
    ['red light odd',  () => { const r = detectCoordination('All agents must move to an odd-numbered row and wait for our message. 700 points'); return r?.task === 'red_light' && r.parity === 'odd'; }],
    ['red light even', () => detectCoordination('move to an even row and wait for the signal')?.parity === 'even'],
    ['relay',          () => detectCoordination('If a parcel is picked up by one agent and delivered by the other, 200 points bonus.')?.task === 'relay'],
    ['green light',    () => detectCoordination('green light, you can move now')?.task === 'resume'],
    ['plain text not coord', () => detectCoordination('deliver stacks of 3 to double the reward') === null],
]);

// --- 4. decision parsing -----------------------------------------------------
component('decision parsing', [
    ['fenced json',    () => safeJsonParse('```json\n{"kind":"answer"}\n```')?.kind === 'answer'],
    ['json in prose',  () => safeJsonParse('Sure! {"kind":"goal","effect":{}} hope it helps')?.kind === 'goal'],
    ['array fenced',   () => eq(parseJsonArray('```json\n["a","b"]\n```'), ['a', 'b'])],
    ['garbage -> null', () => safeJsonParse('no json here') === null && parseJsonArray('nope') === null],
]);

// --- 5. tools ------------------------------------------------------------------
component('tools', [
    ['calculate',      () => calculate('4*2') === '8' && calculate('(1+3)*3') === '12'],
    ['calculate error', () => String(execTool('calculate', 'nope(', state)).startsWith('Error')],
    ['unknown tool',   () => String(execTool('bogus', 'x', state)).startsWith('Error')],
    ['leftmost delivery', () => { const t = resolveRelative(deliveryZones, 'leftmost'); return t && t.x === 0; }],
    ['map info',       () => { const i = getMapInfo(state); return i.width === 10 && i.leftmost.x === 0 && i.rightmost.x === 9; }],
]);

// --- 6. react planner (modello scriptato) --------------------------------------
function scripted(replies) {
    let i = 0;
    return { async chat() { return replies[Math.min(i++, replies.length - 1)]; } };
}
async function planKind(replies) {
    const p = new LlmPlanner(scripted(replies), { state });
    const d = await p.plan('test', {});
    return d;
}
const reactCases = [];
{
    const d = await planKind(['Thought: known.\nDecision: {"kind":"answer","effect":{"text":"Rome"}}']);
    reactCases.push(['direct answer', () => d?.kind === 'answer' && d.effect.text === 'Rome']);
}
{
    const d = await planKind(['Thought: compute.\nAction: calculate\nAction Input: 4*2', 'Thought: done.\nDecision: {"kind":"goal","effect":{"goal":"goto","x":8,"y":12,"reward":-10}}']);
    reactCases.push(['tool then decision', () => d?.kind === 'goal' && d.effect.x === 8]);
}
{
    const d = await planKind(['garbage with no format', 'Decision: {"kind":"rule","effect":{"rule":"delivery_stack","n":3,"multiplier":2}}']);
    reactCases.push(['format retry recovers', () => d?.kind === 'rule' && d.effect.n === 3]);
}
{
    const d = await planKind(['Action: bogus_tool\nAction Input: x', 'Decision: {"kind":"ignore","effect":{}}']);
    reactCases.push(['tool error as observation', () => d?.kind === 'ignore']);
}
{
    const d = await planKind(['nope', 'nope', 'nope', 'nope', 'nope', 'nope', 'nope']);
    reactCases.push(['max iterations -> null', () => d === null]);
}
component('react planner', reactCases);

// --- 7. routing safeguards ------------------------------------------------------
const routingCases = [];
{
    const goals = [], said = [];
    const client = { state, say: async (id, m) => said.push(m) };
    const bdi = { beliefs: { constraints: {} }, addMissionGoal: g => goals.push(g), applyRule: () => true };
    const agent = new LlmAgent({ client, bdi, llm: scripted(['Decision: {"kind":"goal","effect":{"goal":"goto","x":4,"y":7,"reward":-10}}']) });
    await agent.handleMission('trap', 's');
    routingCases.push(['negative payoff dropped', () => goals.length === 0]);
}
{
    const goals = [];
    const client = { state, say: async () => {} };
    const bdi = { beliefs: { constraints: {} }, addMissionGoal: g => goals.push(g), applyRule: () => true };
    const agent = new LlmAgent({ client, bdi, llm: scripted(['Decision: {"kind":"goal","effect":{"goal":"goto","x":99,"y":99,"reward":10}}']) });
    await agent.handleMission('off map', 's');
    routingCases.push(['off-map goal rejected', () => goals.length === 0]);
}
{
    const rules = [];
    const client = { state, say: async () => {} };
    const bdi = { beliefs: { constraints: {} }, addMissionGoal: () => {}, applyRule: r => { rules.push(r); return true; } };
    const failing = { async chat() { throw new Error('down'); } };
    const agent = new LlmAgent({ client, bdi, llm: failing });
    await agent.handleMission('Deliver stacks of exactly 3 parcels at a time to double the reward', 's');
    routingCases.push(['llm down -> fallback rule', () => rules.length === 1 && rules[0].n === 3]);
}
component('routing safeguards', routingCases);

// --- report -------------------------------------------------------------------
console.log('\nLLM COMPONENT SUITE');
console.log('component'.padEnd(28) + 'cases'.padStart(6) + 'passed'.padStart(8));
console.log('-'.repeat(42));
let totC = 0, totP = 0;
for (const r of results) {
    totC += r.total; totP += r.passed;
    console.log(r.name.padEnd(28) + String(r.total).padStart(6) + String(r.passed).padStart(8));
    for (const f of r.failures) console.log('    FAIL: ' + f);
}
console.log('-'.repeat(42));
console.log('total'.padEnd(28) + String(totC).padStart(6) + String(totP).padStart(8));
process.exit(totP === totC ? 0 : 1);
