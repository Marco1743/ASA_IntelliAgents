
import { TOOLS_DESCRIPTION } from './tools.js';
import { manhattan, getClosest } from '../common/geometry.js';

export function extractAction(text) {
    const a = text.match(/^Action:\s*(.+)$/im);
    const i = text.match(/^Action Input:\s*([\s\S]*?)(?:\n\s*\n|$)/im);
    if (!a) return null;
    return { action: a[1].trim(), actionInput: stripWrappingQuotes(i ? i[1].trim() : '') };
}

function stripWrappingQuotes(s) {
    if (s.length >= 2) {
        const f = s[0], l = s[s.length - 1];
        if ((f === '"' && l === '"') || (f === "'" && l === "'") ||
            (f === '`' && l === '`')) {
            return s.slice(1, -1).trim();
        }
    }
    return s;
}

export function extractFinalAnswer(text) {
    const m = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}

export function countActions(text) {
    const m = text.match(/^Action:\s*.+$/gim);
    return m ? m.length : 0;
}

export function hasBothActionAndFinalAnswer(text) {
    return /^Action:\s*.+$/im.test(text)
        && /^Final Answer:\s*[\s\S]*$/im.test(text);
}

function isL2Conditional(text) {
    return /\b(?:do\s+not|don['']t|every\s+time\s+you|if\s+you\s+deliver|stacks?\s+of|deliver\s+in\s*\()/i.test(text);
}

function isL3Coordination(text) {

    if (/\b(?:rendezvous|meet)\s+(?:at|on)\s*\(/i.test(text)) return true;
    if (/\bboth\s+(?:agents?\s+)?(?:go\s+to|move\s+to|head\s+to)\s*\(/i.test(text)) return true;
    if (/\bmove\s+(?:both\s+)?agents?\s+to\b[^()]*\(\s*-?\d+\s*,\s*-?\d+\s*\)/i.test(text)) return true;
    if (/\bneighborhood\s+of\s+position\s*\(\s*-?\d+\s*,\s*-?\d+\s*\)/i.test(text)) return true;
    if (/\bgo\s+to\s*\(\s*-?\d+\s*,\s*-?\d+\s*\)\s+together\b/i.test(text)) return true;

    if (/\b(?:all\s+)?agents?\s+(?:must\s+)?(?:move\s+to|go\s+to)\s+(?:an?\s+)?(?:odd|even)[-\s]numbered\s+(?:row|column)/i.test(text)) return true;
    if (/\bmove\s+to\s+(?:an?\s+)?(?:odd|even)[-\s]numbered\s+(?:row|column)/i.test(text)) return true;

    if (/\b(?:drop|leave|release)\s+(?:a\s+)?parcel.*\b(?:for|to)\s+(?:(?:the|a|your|my)\s+)?(?:teammate|partner|other\s+agent)/i.test(text)) return true;
    if (/\bhand\s*off\s+(?:a\s+)?parcel/i.test(text)) return true;

    if (/\bpicked\s+up\s+by\s+one\s+agent\b[\s\S]*\bdelivered\s+by\s+(?:the\s+)?(?:other|another)\s+agent/i.test(text)) return true;
    if (/\bpicked\s+up\s+by\s+one\b[\s\S]*\bdelivered\s+by\s+(?:the\s+)?(?:other|another)/i.test(text)) return true;

    if (/\b(?:stop|freeze|halt)\s+(?:moving|all\s+motion).*\b(?:until|wait)/i.test(text)) return true;
    if (/\bwait\s+for\s+(?:my|our|the)\s+(?:go|signal|message|green[-\s]?light)/i.test(text)) return true;
    if (/\bred\s+light[,\s]+green\s+light\b/i.test(text)) return true;
    if (/\bdon['']t\s+move\s+until\b/i.test(text)) return true;
    if (/\bwait\s+for\s+(?:our|my|the)\s+message\b/i.test(text)) return true;

    if (/^\s*(?:go|resume|continue|green[-\s]?light|you\s+can\s+(?:move|go))\s*[.!]?\s*$/i.test(text)) return true;
    return false;
}

export function classifyMissionReward(text) {
    if (!text || typeof text !== 'string') return { kind: 'unknown', match: '' };

    if (isL3Coordination(text)) return { kind: 'l3', match: 'multi-agent coordination' };
    if (isL2Conditional(text))  return { kind: 'l2', match: 'conditional/persistent constraint' };

    const negatives = [
        /\bto\s+get\s+(?:-|–|−)\s*\d+/i,
        /\bget\s+(?:-|–|−)\s*\d+\s*pts?/i,
        /\byou\s+lose\s+\d+/i,
        /\bget\s+0\s*pts?\b/i,
        /\bno\s+reward\b/i,
        /\b0\.\d+\s+of\s+the\s+(?:standard|normal)\s+reward/i,
        /\botherwise\s+you\s+lose\s+\d+/i
    ];
    for (const p of negatives) {
        const m = text.match(p);
        if (m) return { kind: 'negative', match: m[0].trim() };
    }

    const knowledge = [
        /\bwhat\s+is\s+the\s+(?:capital|colour|color)/i,
        /\bcalculate\s+\d/i,
        /\bcompute\s+\d/i,
        /\bhow\s+much\s+is\s+\d/i,
        /\bwhat['']s\s+\d.*[+\-*/].*\d/i
    ];
    for (const p of knowledge) {
        const m = text.match(p);
        if (m) return { kind: 'knowledge', match: m[0].trim() };
    }

    if (/\b\+\s*\d+\s*pts?|\bbonus\b|\byou\s+(?:get|gain|receive)\s+\d/i.test(text)) {
        return { kind: 'positive', match: 'reward signal detected' };
    }
    return { kind: 'unknown', match: '' };
}

function parseCoordList(text) {
    const out = [];
    const re = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push({ x: parseInt(m[1], 10), y: parseInt(m[2], 10) });
    }
    return out;
}

export function parseRewardMultiplier(text) {
    const s = String(text || '');
    if (/\bdouble\b/i.test(s))    return 2;
    if (/\btriple\b/i.test(s))    return 3;
    if (/\bquadruple\b/i.test(s)) return 4;

    if (/\bno\s+reward\b/i.test(s) || /\bget\s+0\s*pts?\b/i.test(s) || /\b0\s*pts?\b/i.test(s)) return 0;

    let m = s.match(/\b(0?\.\d+)\s+of\s+(?:the\s+)?(?:standard|normal|regular)?\s*reward/i);
    if (m) return parseFloat(m[1]);

    m = s.match(/(\d+(?:\.\d+)?)\s*x\b/i);
    if (m) return parseFloat(m[1]);
    m = s.match(/(\d+(?:\.\d+)?)\s+times\b/i);
    if (m) return parseFloat(m[1]);
    return null;
}

export function parseL2Mission(text) {
    if (!text || typeof text !== 'string') return null;

    let m = text.match(/\bdeliver\s+(?:in\s+)?stacks?\s+of\s+(?:exactly\s+)?(\d+)\s+parcels?/i);
    if (m) {
        const n = parseInt(m[1], 10);

        const multiplier = parseRewardMultiplier(text);
        if (multiplier !== null && multiplier !== 1) {
            return { kind: 'set_delivery_bonus', data: { n, multiplier } };
        }
        const positiveBonus = /\bbonus\b/i.test(text) || /\b\+\s*\d+\s*pts?\b/i.test(text);
        if (positiveBonus) return { kind: 'set_delivery_bonus', data: { n, multiplier: 2 } };

        return { kind: 'set_delivery_threshold', data: { n } };
    }

    if (/\bdeliver\s+in\b/i.test(text) && /\(/.test(text)) {
        const tiles = parseCoordList(text);
        if (tiles.length > 0) {
            const positive = /\b\d+x\s+(?:pts|reward)|\bbonus\b|\bmultiplier\b/i.test(text);
            const negative = /\bget\s+0\s*pts?|\bno\s+reward\b|\b0\.\d+\s+of/i.test(text);
            if (positive)  return { kind: 'set_preferred_delivery', data: { tiles } };
            if (negative)  return { kind: 'set_forbidden_delivery', data: { tiles } };
        }
    }

    m = text.match(/parcels?\s+with\s+(?:a\s+)?(?:score|reward)\s+(?:higher|greater|more)\s+than\s+(\d+)/i);
    if (m) return { kind: 'set_parcel_filter', data: { max_reward: parseInt(m[1], 10) } };

    m = text.match(/do\s+not\s+go\s+through\s+(?:tile\s+)?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
    if (m) {
        return {
            kind: 'avoid_zone',
            data: {
                x: parseInt(m[1], 10), y: parseInt(m[2], 10),
                radius: 0,
                ttlMs: 24 * 60 * 60 * 1000
            }
        };
    }
    return null;
}

export function parseL3Mission(text) {
    if (!text || typeof text !== 'string') return null;

    let m = text.match(/(?:rendezvous|meet|both\s+(?:agents?\s+)?(?:go\s+to|move\s+to|head\s+to)|move\s+(?:both\s+)?agents?\s+to(?:\s+the\s+neighborhood\s+of\s+position)?|neighborhood\s+of\s+position)\s*(?:at|on)?\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
    if (m) {
        const x = parseInt(m[1], 10), y = parseInt(m[2], 10);
        const tolMatch = text.match(/(?:tolerance|within(?:\s+a\s+maximum\s+distance\s+of)?|max(?:imum)?\s+distance\s+of)\s+(\d+)/i);
        const tolerance = tolMatch ? parseInt(tolMatch[1], 10) : 1;
        return { kind: 'rendezvous', data: { x, y, tolerance } };
    }

    m = text.match(/(?:odd|even)[-\s]numbered\s+(row|column)/i);
    if (m) {
        const parity = /odd/i.test(text) ? 'odd' : 'even';
        const axis   = /column/i.test(m[1]) ? 'column' : 'row';
        return { kind: 'rendezvous_parity', data: { parity, axis } };
    }

    if (/\bpicked\s+up\s+by\s+one\b[\s\S]*\bdelivered\s+by\s+(?:the\s+)?(?:other|another)/i.test(text)) {
        return { kind: 'handoff_bonus', data: {} };
    }

    m = text.match(/(?:drop|leave|release)\s+(?:a\s+)?parcel\s+(?:at\s+)?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
    if (m) {
        return {
            kind: 'handoff',
            data: { x: parseInt(m[1], 10), y: parseInt(m[2], 10) }
        };
    }

    if (/^\s*(?:go|resume|continue|green[-\s]?light|you\s+can\s+(?:move|go))\s*[.!]?\s*$/i.test(text)) {
        return { kind: 'resume', data: {} };
    }

    if (/\b(?:wait\s+for\s+(?:my|our|the)\s+(?:go|signal|message|green[-\s]?light)|stop\s+moving\b.*\buntil|freeze\s+(?:movement|all\s+motion)|don['']t\s+move\s+until|red\s+light[,\s]+green\s+light)\b/i.test(text)) {
        return { kind: 'wait_for_signal', data: {} };
    }

    return null;
}

export function extractRewardPts(text) {
    const s = String(text || '');

    let m = s.match(/([+-]?\d+)\s*(?:pt|pts|point|points)\b/i);
    if (m) return parseInt(m[1], 10);

    m = s.match(/\b(get|gain|receive|earn|lose)\s+(?:you\s+)?([+-]?\d+)\b/i);
    if (m) {
        const v = parseInt(m[2], 10);
        return /lose/i.test(m[1]) ? -Math.abs(v) : v;
    }
    return null;
}

export function estimateValuePerStep(state) {
    let best = 0;
    for (const p of (state.freeParcels || [])) {
        const dPick = manhattan(state.me, p) || 0.1;
        const dz = getClosest(p, state.deliveryZones);
        const dDeliver = dz ? manhattan(p, dz) : 0;
        const vps = (p.reward || 1) / ((dPick + dDeliver) || 1);
        if (vps > best) best = vps;
    }
    return best;
}

export function safeEvalArith(expr) {
    const s = String(expr || '').trim();
    if (!s || !/^[\d+\-*/().\s]+$/.test(s)) return null;
    try {
        const v = Function(`"use strict"; return (${s});`)();
        return Number.isFinite(v) ? v : null;
    } catch (_) { return null; }
}

export function parseMoveCoords(text) {
    let m = text.match(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
    if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
    m = text.match(/x\s*=\s*([\d+\-*/().\s]+?)\s+y\s*=\s*([\d+\-*/().\s]+?)(?=\s+to\b|\s+and\b|[,.]|$)/i);
    if (m) {
        const x = safeEvalArith(m[1]), y = safeEvalArith(m[2]);
        if (x !== null && y !== null) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
}

export function recognizeStandingRules(text, state) {
    const reward = extractRewardPts(text);
    if (reward === null || reward === 0) return null;

    let m = text.match(/\b(left|right)most\s+tile\b/i);
    if (m && /\b(drop|deliver|put)\b/i.test(text)) {
        const side = m[1].toLowerCase();
        const dz = [...(state.deliveryZones || [])].sort((a, b) => a.x - b.x || a.y - b.y);
        const tile = side === 'left' ? dz[0] : dz[dz.length - 1];
        if (!tile) return null;
        if (reward < 0) return [{
            request: { intent: 'set_forbidden_delivery', tiles: [{ x: tile.x, y: tile.y }] },
            summary: `never deliver on ${side}most tile (${tile.x},${tile.y}) — costs ${reward}pts`
        }];
        return [{
            request: { intent: 'set_preferred_delivery', tiles: [{ x: tile.x, y: tile.y }], reward },
            summary: `prefer ${side}most delivery tile (${tile.x},${tile.y}) — +${reward}pts`
        }];
    }

    if (/\bmove\s+to\b/i.test(text) || /\bgo\s+to\b/i.test(text)) {
        const c = parseMoveCoords(text);
        if (c) {
            if (reward < 0) return [{
                request: { intent: 'add_tile_penalty', x: c.x, y: c.y, points: Math.abs(reward) },
                summary: `avoid tile (${c.x},${c.y}) for the rest of the game — costs ${Math.abs(reward)}pts`
            }];
            return [{
                request: { intent: 'add_tile_bonus', x: c.x, y: c.y, points: reward },
                summary: `standing bonus tile (${c.x},${c.y}) — +${reward}pts when reached`
            }];
        }
    }
    return null;
}

export function recognizeOpportunity(text, tools, state) {
    const reward = extractRewardPts(text);

    let m = text.match(/\b(left|right)most\s+tile\b/i);
    if (m && /\b(drop|deliver|put)\b/i.test(text)) {
        const side = m[1].toLowerCase();
        const dz = [...state.deliveryZones].sort((a, b) => a.x - b.x || a.y - b.y);
        const target = side === 'left' ? dz[0] : dz[dz.length - 1];
        if (!target) return null;
        const nearest = getClosest(state.me, state.deliveryZones);
        const stepsTarget = manhattan(state.me, target);
        const stepsNearest = nearest ? manhattan(state.me, nearest) : stepsTarget;

        const extraSteps = Math.max(0, stepsTarget - stepsNearest);
        return {
            kind: `deliver_${side}most`, reward, extraSteps,
            toolName: 'deliver_to', toolArg: `${target.x},${target.y}`,
            execute: () => tools.deliver_to(`${target.x},${target.y}`)
        };
    }

    m = text.match(/\bmove\s+to\b[\s\S]*?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
    if (m) {
        const x = parseInt(m[1], 10), y = parseInt(m[2], 10);
        const extraSteps = manhattan(state.me, { x, y });
        return {
            kind: 'move_to', reward, extraSteps,
            toolName: 'go_to', toolArg: `${x},${y}`,
            execute: () => tools.go_to(`${x},${y}`)
        };
    }
    return null;
}

export function deliberateOpportunity(opp, state) {
    if (opp.reward === null) {
        return { worth: true, reason: 'plain command (no reward to weigh) → execute' };
    }
    if (opp.reward <= 0) {
        return { worth: false, reason: `reward ${opp.reward} ≤ 0 → ignore` };
    }
    const vps  = estimateValuePerStep(state);
    const cost = opp.extraSteps * vps;
    const net  = opp.reward - cost;
    return {
        worth: net > 0, net,
        reason: `reward=${opp.reward}, extraSteps=${opp.extraSteps}, ` +
                `valuePerStep=${vps.toFixed(2)}, opportunityCost=${cost.toFixed(2)}, net=${net.toFixed(2)}`
    };
}

const AGENT_PROMPT = `
You are an LLM agent connected to the Deliveroo.js game.

Available tools:
${TOOLS_DESCRIPTION}

You solve the user's request step by step.

STRICT OUTPUT FORMAT — choose exactly one format.

FORMAT 1 — use one tool:

Thought: <brief reasoning>
Action: <tool name>
Action Input: <args, or "none" for no-arg tools>

FORMAT 2 — final answer:

Thought: I have enough information to answer.
Final Answer: <clear final answer for the user>

Rules:
- Output exactly one action at a time.
- Never output two actions in the same message.
- Never output an Action and a Final Answer in the same message.
- Never write Action: None.
- Do not invent tool results.
- After receiving an Observation, decide the next Action or give the Final Answer.
- Use only the available tools.
- When the mission is satisfied, call finish_objective(summary) and stop.

SPECIAL MISSION REWARD CHECK
Before doing anything, look at the mission's REWARD:
- POSITIVE ("+10pts", "+500 bonus", "double", "5x"): execute it.
- NEGATIVE ("-10pts", "you lose 50pts", "0 pts", "no reward", "0.3 of standard"):
  call finish_objective with summary "refused: negative reward".
- KNOWLEDGE / MATH ("capital of Italy?", "calculate 5*5"): compute the answer
  in your head, call reply_to_sender(answer), then finish_objective.

COORDINATES with arithmetic ("x=4*2 y=(1+3)*3"): evaluate first → x=8, y=12.

DROP / DELIVER MISSIONS
- putdown() only EARNS POINTS on a delivery-zone tile (type 2). Dropping
  anywhere else just abandons the parcel.
- If the mission asks to drop/deliver a package but get_status() shows you
  carry nothing, FIRST acquire one with go_to_nearest_parcel.
- "leftmost tile" / "rightmost tile" in a drop/deliver mission means a DELIVERY
  zone: call get_map_info and read leftmostDeliveryZone / rightmostDeliveryZone
  (the delivery tile with the smallest / largest x).
- To actually deliver there, call deliver_to(x,y) with those coords — it acquires
  a parcel if needed, picks one that survives the trip, RETRIES if a parcel
  expires en route, and confirms the drop. Prefer deliver_to over doing
  go_to_nearest_parcel + go_to + putdown by hand. Only call finish_objective
  AFTER deliver_to reports a successful "Delivered ..." (not on an Error).
`.trim();

export const INTERPRETER_ACTIONS = new Set([
    'delivery_bonus', 'delivery_threshold', 'preferred_delivery', 'forbidden_delivery',
    'parcel_filter', 'avoid_zone', 'tile_bonus', 'tile_penalty',
    'rendezvous', 'rendezvous_parity', 'handoff', 'handoff_bonus',
    'wait_for_signal', 'resume', 'knowledge', 'refuse', 'open_ended'
]);

const INTERPRETER_PROMPT = `
You are the planner of an autonomous agent in the Deliveroo.js grid game. A mission
arrives in natural language. Interpret it, reason about the game context provided,
then output EXACTLY ONE JSON object (no prose, no code fences) describing the action.

Choose "action" from this catalogue and fill "params":

PERSISTENT STRATEGY (level 2) — changes how the agent collects/delivers from now on:
- "delivery_bonus"      {n, multiplier}  // deliver EXACTLY n parcels at once → reward ×multiplier. multiplier<1 is a PENALTY: 0 = "no reward"/"0 pts", 0.3 = "0.3 of the reward"; "double"=2, "triple"=3, "5x"=5
- "delivery_threshold"  {n}              // plain "deliver in stacks of n" with NO reward change
- "preferred_delivery"  {tiles:[{x,y}]}  // delivering on these tiles gives MORE points → prefer them
- "forbidden_delivery"  {tiles:[{x,y}]}  // delivering on these tiles gives 0/negative → never use them
- "parcel_filter"       {max_reward}     // parcels worth MORE than max_reward give no reward → ignore them
- "avoid_zone"          {x,y}            // "do not go through (x,y)" → block that tile

STANDING TILE RULES (level 1, persistent) — a tile gives/loses points when reached:
- "tile_bonus"          {x,y,points}     // "move to (x,y) → +P pts"
- "tile_penalty"        {x,y,points}     // "move to (x,y) → -P pts" — avoid it for the whole game

COORDINATION (level 3) — coordinate with the teammate BDI agent:
- "rendezvous"          {x,y,tolerance}  // both agents meet near (x,y)
- "rendezvous_parity"   {parity:"odd"|"even", axis:"row"|"column"}
- "handoff"             {x,y}            // drop a parcel at (x,y) for the teammate
- "handoff_bonus"       {}               // bonus when one agent picks up and the other delivers
- "wait_for_signal"     {}               // freeze until a resume/go signal ("red light", "don't move until...")
- "resume"              {}               // unfreeze ("go", "green light", "you can move")

OTHER:
- "knowledge"  put the computed result in "answer"  // a knowledge/math question
- "refuse"     put why in "reason"                  // negative/zero reward with NOTHING persistent to learn
- "open_ended" {}                                   // none of the above fits → free-form task needing step-by-step tools

Param rules:
- Resolve arithmetic coordinates: "x=4*2 y=(1+3)*3" → x:8, y:12.
- "leftmost/rightmost tile" in a DELIVER mission = the delivery zone with smallest/largest x (see the list in the context).
- Output numbers as numbers, never strings.

Examples:
Mission: "Deliver stacks of exactly 3 parcels at a time to double the reward"
{"action":"delivery_bonus","params":{"n":3,"multiplier":2}}
Mission: "Deliver stacks of exactly 5 parcels and you get 0 pts"
{"action":"delivery_bonus","params":{"n":5,"multiplier":0}}
Mission: "If you deliver parcels with a score higher than 10 you get no reward"
{"action":"parcel_filter","params":{"max_reward":10}}
Mission: "Move to x=4*2 y=(1+3)*3 to get -10pts"
{"action":"tile_penalty","params":{"x":8,"y":12,"points":10}}
Mission: "Drop a package in the leftmost tile to get 5pt"  (delivery zones: (1,5) (9,5))
{"action":"preferred_delivery","params":{"tiles":[{"x":1,"y":5}]}}
Mission: "rendezvous at (5,5) within a maximum distance of 1"
{"action":"rendezvous","params":{"x":5,"y":5,"tolerance":1}}
Mission: "wait for my signal"
{"action":"wait_for_signal","params":{}}
Mission: "what is the capital of France?"
{"action":"knowledge","answer":"Paris"}
`.trim();

export function summarizeStateForLLM(state) {
    if (!state) return 'Game context: (unavailable).';
    const me = state.me || {};
    const dz = (state.deliveryZones || []).map(z => `(${z.x},${z.y})`).join(' ');
    const carrying = (state.carrying || []).length;
    return [
        'Game context:',
        `- my position: (${me.x ?? '?'},${me.y ?? '?'})`,
        `- carrying: ${carrying} parcel(s)`,
        `- delivery zones: ${dz || 'none'}`
    ].join('\n');
}

export function extractJsonObject(s) {
    if (!s) return null;
    let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i < 0 || j < 0 || j < i) return null;
    try { return JSON.parse(t.slice(i, j + 1)); } catch (_) { return null; }
}

export class Planner {

    constructor({ llmClient, model, memory, tools, asa = null,
                  maxIterations = 12, llmTimeoutMs = 120000,
                  useLlmInterpreter = true }) {
        this.llmClient = llmClient;
        this.model     = model;
        this.memory    = memory;
        this.tools     = tools;
        this.asa       = asa;
        this.maxIterations = maxIterations;
        this.llmTimeoutMs  = llmTimeoutMs;

        this.useLlmInterpreter = useLlmInterpreter;
    }

    async run() {
        const memory = this.memory;
        if (!memory.objective) {
            console.log('[planner] no objective set — idling');
            return;
        }
        const text = memory.objective;

        if (this.useLlmInterpreter) {
            const decision = await this._interpretWithLLM(text);
            if (decision && decision.action !== 'open_ended') {
                console.log(`[planner] LLM interpreted mission → ${decision.action}`);
                if (await this._dispatchInterpretation(decision)) return;
                console.log('[planner] LLM action not dispatchable (missing params) — regex fallback');
            } else if (decision) {
                console.log('[planner] LLM judged mission open-ended → ReAct loop');
            }
        }

        const verdict = classifyMissionReward(text);
        console.log(`[planner] classify=${verdict.kind}${verdict.match ? ` ("${verdict.match}")` : ''}`);

        const standing = recognizeStandingRules(text, this.memory.client.state);
        if (standing && standing.length) {
            console.log(`[planner] STANDING RULE mission — installing ${standing.length} persistent belief(s)`);
            await this._applyStandingRules(standing);
            return;
        }

        if (verdict.kind === 'negative') {
            console.log('[planner] NEGATIVE-REWARD mission detected — refusing without action');
            memory.recordToolCall('finish_objective', { auto: true },
                `[DONE] refused: mission has negative/zero/penalty reward (${verdict.match})`);
            return;
        }
        if (verdict.kind === 'knowledge') {
            console.log('[planner] KNOWLEDGE mission detected — direct-answer path');
            await this._answerKnowledgeMission();
            return;
        }
        if (verdict.kind === 'l2') {
            const c = parseL2Mission(text);
            if (c) {
                console.log(`[planner] L2 mission — constraint kind=${c.kind}`);
                await this._applyL2Constraint(c);
                return;
            }
            console.log('[planner] L2 wording recognised but parser found no constraint; falling through to LLM');
        }
        if (verdict.kind === 'l3') {
            const c = parseL3Mission(text);
            if (c) {
                console.log(`[planner] L3 mission — coordination kind=${c.kind}`);
                await this._applyL3Mission(c);
                return;
            }
            console.log('[planner] L3 wording recognised but parser found no shape; falling through to LLM');
        }

        if (verdict.kind === 'positive' || verdict.kind === 'unknown') {
            const state = this.memory.client.state;
            const opp = recognizeOpportunity(text, this.tools, state);
            if (opp) {
                const decision = deliberateOpportunity(opp, state);
                console.log(`[planner] deliberation (${opp.kind}): ${decision.reason}`);
                if (!decision.worth) {
                    memory.recordToolCall('finish_objective', { auto: true },
                        `[DONE] special mission ignored — not worth it: ${decision.reason}`);
                    return;
                }
                const obs = await opp.execute();
                memory.recordToolCall(opp.toolName, opp.toolArg, obs);
                console.log(`[planner] opportunity executed: ${truncate(obs, 160)}`);
                memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] special mission done (${opp.kind}): ${truncate(obs, 100)}`);
                return;
            }
        }

        const turnMessages = [
            { role: 'system', content: AGENT_PROMPT },
            { role: 'user',   content: text }
        ];

        const recentSignatures = [];
        let loopNudgeIssued = false;

        for (let iter = 0; iter < this.maxIterations; iter++) {
            const assistantMessage = await this._callModel(turnMessages, iter);
            if (assistantMessage === null) return;
            console.log(`[planner] iter ${iter+1} model output:\n${truncate(assistantMessage)}`);
            turnMessages.push({ role: 'assistant', content: assistantMessage });

            const nActions = countActions(assistantMessage);
            const mixed    = hasBothActionAndFinalAnswer(assistantMessage);
            if (nActions > 1) console.log(`[planner] warning: ${nActions} actions in one output, executing first only`);
            if (mixed)        console.log(`[planner] warning: mixed Action + Final Answer, executing Action first`);

            const parsedAction = extractAction(assistantMessage);

            if (parsedAction) {
                const { action, actionInput } = parsedAction;
                const fn = this.tools[action];
                let observation;
                if (typeof fn !== 'function') {
                    observation = `Error: unknown tool '${action}'. Available: ${Object.keys(this.tools).join(', ')}`;
                } else {
                    try {
                        observation = await fn(actionInput);
                        observation = (observation === undefined || observation === null) ? '' : String(observation);
                    } catch (err) {
                        observation = `Error: ${err.message}`;
                    }
                }
                console.log(`[planner] iter ${iter+1}: ${action}(${truncate(actionInput, 80)}) → ${truncate(observation)}`);
                memory.recordToolCall(action, actionInput, observation);

                if (typeof observation === 'string' && observation.startsWith('[DONE]')) {
                    console.log(`[planner] objective complete: ${observation.slice(6).trim()}`);
                    return;
                }

                turnMessages.push({
                    role: 'user',
                    content: `Observation: ${observation}\n\nContinue solving the original user request. If still missing information, choose the next Action. Otherwise call finish_objective or give a Final Answer.`
                });

                const sig = `${action}|${actionInput}|${observation.slice(0,40)}`;
                recentSignatures.push(sig);
                if (recentSignatures.length > 6) recentSignatures.shift();
                if (recentSignatures.length >= 3) {
                    const last3 = recentSignatures.slice(-3);
                    if (last3.every(s => s === last3[0])) {
                        if (!loopNudgeIssued) {
                            console.log('[planner] LOOP detected — injecting strategy nudge');
                            turnMessages.push({
                                role: 'user',
                                content: 'You called the same Action with the same Input 3 times in a row with the same result. Stop repeating. Either change strategy completely or call finish_objective with a truthful summary.'
                            });
                            loopNudgeIssued = true;
                        } else {
                            console.log('[planner] LOOP persists — aborting');
                            memory.recordToolCall('_planner', 'loop_forced_exit', '[DONE] loop guard');
                            return;
                        }
                    } else {
                        loopNudgeIssued = false;
                    }
                }
                continue;
            }

            const finalAnswer = extractFinalAnswer(assistantMessage);
            if (finalAnswer) {
                console.log(`[planner] Final Answer: ${truncate(finalAnswer, 200)}`);
                memory.recordToolCall('_final_answer', '', finalAnswer);
                return;
            }

            turnMessages.push({
                role: 'user',
                content: 'Error: invalid format. You must output either one Action (with Action Input) or one Final Answer.'
            });
        }
        console.log('[planner] max iterations reached without Final Answer');
    }

    async _answerKnowledgeMission() {
        const prompt = [
            { role: 'system',
              content: 'You answer a short knowledge or math question in ONE LINE OF TEXT, with NO preamble, NO formatting, NO explanation. Just the answer.' },
            { role: 'user', content: this.memory.objective }
        ];
        let answer = '';
        try {
            const resp = await this._rawCall(prompt);
            answer = (resp || '').trim().split('\n')[0].trim();
        } catch (err) {
            console.log(`[planner] knowledge LLM call failed: ${err.message}`);
        }
        if (!answer) answer = '(no answer)';
        const obs = await this.tools.reply_to_sender(answer);
        this.memory.recordToolCall('reply_to_sender', answer, obs);
        const done = this.tools.finish_objective(`answered knowledge question with: ${answer}`);
        this.memory.recordToolCall('finish_objective', '', done);
        console.log(`[planner] objective complete: ${done.replace(/^\[DONE\]\s*/, '')}`);
    }

    async _interpretWithLLM(text) {
        const state = this.memory?.client?.state;
        const messages = [
            { role: 'system', content: INTERPRETER_PROMPT },
            { role: 'user',   content: `${summarizeStateForLLM(state)}\n\nMission: "${text}"\n\nRespond with ONE JSON object.` }
        ];
        let raw;
        try {
            const budget = Math.min(this.llmTimeoutMs, 30000);
            raw = await Promise.race([
                this._rawCall(messages),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`interpret timeout ${budget}ms`)), budget))
            ]);
        } catch (err) {
            console.log(`[planner] LLM interpret failed (${err.message}) — regex fallback`);
            return null;
        }
        const obj = extractJsonObject(raw);
        if (!obj || typeof obj.action !== 'string') {
            console.log('[planner] LLM interpret: no valid JSON — regex fallback');
            return null;
        }
        return this._normalizeDecision(obj);
    }

    _normalizeDecision(obj) {
        const action = String(obj.action || '').trim().toLowerCase();
        if (!INTERPRETER_ACTIONS.has(action)) return null;
        const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : undefined; };
        const src = obj.params || {};
        const p = {};
        for (const k of ['n', 'multiplier', 'x', 'y', 'points', 'max_reward', 'tolerance', 'radius']) {
            if (src[k] !== undefined) p[k] = num(src[k]);
        }
        if (src.parity) p.parity = String(src.parity).toLowerCase();
        if (src.axis)   p.axis   = String(src.axis).toLowerCase();
        if (Array.isArray(src.tiles)) {
            p.tiles = src.tiles
                .map(t => ({ x: num(t.x), y: num(t.y) }))
                .filter(t => t.x !== undefined && t.y !== undefined);
        }
        return { action, params: p, answer: obj.answer, reason: obj.reason };
    }

    async _dispatchInterpretation(d) {
        const p = d.params || {};
        const has = (...keys) => keys.every(k => p[k] !== undefined);
        const L2 = (kind, data) => this._applyL2Constraint({ kind, data });
        const L3 = (kind, data) => this._applyL3Mission({ kind, data });

        switch (d.action) {
            case 'delivery_bonus':
                if (!has('n')) return false;
                await L2('set_delivery_bonus', { n: p.n, multiplier: p.multiplier !== undefined ? p.multiplier : 2 });
                return true;
            case 'delivery_threshold':
                if (!has('n')) return false;
                await L2('set_delivery_threshold', { n: p.n });
                return true;
            case 'preferred_delivery':
                if (!p.tiles || !p.tiles.length) return false;
                await L2('set_preferred_delivery', { tiles: p.tiles });
                return true;
            case 'forbidden_delivery':
                if (!p.tiles || !p.tiles.length) return false;
                await L2('set_forbidden_delivery', { tiles: p.tiles });
                return true;
            case 'parcel_filter':
                if (!has('max_reward')) return false;
                await L2('set_parcel_filter', { max_reward: p.max_reward });
                return true;
            case 'avoid_zone':
                if (!has('x', 'y')) return false;
                await L2('avoid_zone', { x: p.x, y: p.y, radius: p.radius || 0, ttlMs: 24 * 60 * 60 * 1000 });
                return true;

            case 'tile_bonus':
                if (!has('x', 'y')) return false;
                await this._applyStandingRules([{
                    request: { intent: 'add_tile_bonus', x: p.x, y: p.y, points: Math.abs(p.points || 0) },
                    summary: `standing bonus tile (${p.x},${p.y}) +${Math.abs(p.points || 0)}pts`
                }]);
                return true;
            case 'tile_penalty':
                if (!has('x', 'y')) return false;
                await this._applyStandingRules([{
                    request: { intent: 'add_tile_penalty', x: p.x, y: p.y, points: Math.abs(p.points || 0) },
                    summary: `avoid tile (${p.x},${p.y}) -${Math.abs(p.points || 0)}pts for the whole game`
                }]);
                return true;

            case 'rendezvous':
                if (!has('x', 'y')) return false;
                await L3('rendezvous', { x: p.x, y: p.y, tolerance: p.tolerance !== undefined ? p.tolerance : 1 });
                return true;
            case 'rendezvous_parity':
                if (!p.parity) return false;
                await L3('rendezvous_parity', { parity: p.parity, axis: p.axis || 'row' });
                return true;
            case 'handoff':
                if (!has('x', 'y')) return false;
                await L3('handoff', { x: p.x, y: p.y });
                return true;
            case 'handoff_bonus':   await L3('handoff_bonus', {});   return true;
            case 'wait_for_signal': await L3('wait_for_signal', {}); return true;
            case 'resume':          await L3('resume', {});          return true;

            case 'knowledge': {
                const ans = String(d.answer || '').trim() || '(no answer)';
                const obs = await this.tools.reply_to_sender(ans);
                this.memory.recordToolCall('reply_to_sender', ans, obs);
                const done = this.tools.finish_objective(`answered knowledge question (LLM): ${ans}`);
                this.memory.recordToolCall('finish_objective', '', done);
                return true;
            }
            case 'refuse':
                this.memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] refused (LLM): ${d.reason || 'negative/zero reward, nothing to learn'}`);
                return true;

            default:
                return false;
        }
    }

    async _applyStandingRules(rules) {
        const memory = this.memory;
        if (!this.asa) {
            console.log('[planner] standing rule: no ASA bridge — cannot dispatch');
            memory.recordToolCall('finish_objective', { auto: true },
                '[DONE] standing rule NOT applied: no ASA bridge');
            return;
        }
        for (const r of rules) {
            await this.asa.broadcast('REQUEST', r.request);
            memory.addRule({ kind: r.request.intent, data: r.request });
            console.log(`[planner] standing rule applied: ${r.summary}`);
        }
        memory.recordToolCall('finish_objective', { auto: true },
            `[DONE] standing rule(s) added to beliefs: ${rules.map(r => r.summary).join('; ')}`);
    }

    async _applyL2Constraint(constraint) {
        const memory = this.memory;
        if (constraint.kind === 'noop') {
            console.log(`[planner] L2 noop: ${constraint.reason}`);
            memory.recordToolCall('finish_objective', { auto: true },
                `[DONE] L2 acknowledged (no-op): ${constraint.reason}`);
            return;
        }
        const intent = constraint.kind;
        const data = { intent, ...(constraint.data || {}) };
        if (!this.asa) {
            console.log('[planner] L2: no ASA bridge — cannot dispatch constraint');
            memory.recordToolCall('finish_objective', { auto: true },
                '[DONE] L2 constraint NOT applied: no ASA bridge');
            return;
        }
        await this.asa.broadcast('REQUEST', data);
        memory.addRule({ kind: intent, data: constraint.data || null });
        console.log(`[planner] L2 REQUEST sent: ${JSON.stringify(data)}`);
        memory.recordToolCall('finish_objective', { auto: true },
            `[DONE] L2 constraint applied via REQUEST: ${intent}`);
    }

    async _applyL3Mission(constraint) {
        const memory = this.memory;
        if (!this.asa) {
            console.log('[planner] L3: no ASA bridge — cannot dispatch coordination intent');
            memory.recordToolCall('finish_objective', { auto: true },
                '[DONE] L3 coordination NOT applied: no ASA bridge');
            return;
        }
        const { kind, data } = constraint;

        switch (kind) {
            case 'rendezvous': {
                const req = { intent: 'goto_and_wait', x: data.x, y: data.y, tolerance: data.tolerance };
                await this.asa.broadcast('REQUEST', req);
                console.log(`[planner] L3 rendezvous: REQUEST sent ${JSON.stringify(req)}; LLM also walks to (${data.x},${data.y})`);

                try {
                    const obs = await this.tools.go_to(`${data.x},${data.y}`);
                    memory.recordToolCall('go_to', `${data.x},${data.y}`, obs);
                    console.log(`[planner] L3 LLM go_to → ${truncate(obs, 120)}`);
                } catch (err) {
                    console.log(`[planner] L3 LLM go_to failed: ${err.message}`);
                }
                memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] L3 rendezvous at (${data.x},${data.y}) tol=${data.tolerance}`);
                return;
            }
            case 'handoff': {

                console.log(`[planner] L3 handoff at (${data.x},${data.y}): noop — BDI will pick up via normal deliberation`);
                memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] L3 handoff acknowledged at (${data.x},${data.y}) — BDI will collect on its next pass`);
                return;
            }
            case 'rendezvous_parity': {

                const reqIntent = data.axis === 'column'
                    ? 'goto_parity_col_and_wait' : 'goto_parity_row_and_wait';
                await this.asa.broadcast('REQUEST', { intent: reqIntent, parity: data.parity });
                console.log(`[planner] L3 rendezvous_parity: REQUEST ${reqIntent} parity=${data.parity}`);

                let myX = 0, myY = 0;
                try {
                    const s = JSON.parse(this.tools.get_status());
                    myX = s.x ?? 0; myY = s.y ?? 0;
                } catch (_) {  }
                const parityVal = data.parity === 'even' ? 0 : 1;
                let tx = myX, ty = myY;
                if (data.axis === 'column') {
                    if ((myX % 2 + 2) % 2 !== parityVal) tx = myX + 1;
                } else {
                    if ((myY % 2 + 2) % 2 !== parityVal) ty = myY + 1;
                }
                try {
                    const obs = await this.tools.go_to(`${tx},${ty}`);
                    memory.recordToolCall('go_to', `${tx},${ty}`, obs);
                    console.log(`[planner] L3 LLM go_to(${tx},${ty}) → ${truncate(obs, 120)}`);
                } catch (err) {
                    console.log(`[planner] L3 LLM go_to failed: ${err.message}`);
                }
                memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] L3 rendezvous_parity ${data.axis}=${data.parity}`);
                return;
            }
            case 'handoff_bonus': {

                const log = [];
                let mapInfo = null;
                try { mapInfo = JSON.parse(this.tools.get_map_info()); } catch (_) {}

                let status = null;
                try { status = JSON.parse(this.tools.get_status()); } catch (_) {}
                const carryingCount = status?.carrying?.length || 0;
                let pickedSomething = carryingCount > 0;
                if (!pickedSomething) {
                    let obs = await this.tools.go_to_nearest_parcel();
                    console.log(`[planner] handoff_bonus pickup#1: ${truncate(obs, 120)}`);
                    log.push(`pickup#1: ${truncate(obs, 80)}`);
                    memory.recordToolCall('go_to_nearest_parcel', '', obs);
                    let m = obs.match(/picked up (\d+) parcel/);
                    if (m && parseInt(m[1], 10) > 0) pickedSomething = true;

                    if (!pickedSomething && obs.startsWith('Error: no visible parcels')) {
                        const patrol = await this.tools.patrol_spawn_zone();
                        console.log(`[planner] handoff_bonus patrol: ${truncate(patrol, 120)}`);
                        log.push(`patrol: ${truncate(patrol, 80)}`);
                        memory.recordToolCall('patrol_spawn_zone', '', patrol);
                        obs = await this.tools.go_to_nearest_parcel();
                        console.log(`[planner] handoff_bonus pickup#2: ${truncate(obs, 120)}`);
                        log.push(`pickup#2: ${truncate(obs, 80)}`);
                        memory.recordToolCall('go_to_nearest_parcel', '', obs);
                        m = obs.match(/picked up (\d+) parcel/);
                        if (m && parseInt(m[1], 10) > 0) pickedSomething = true;
                    }
                } else {
                    log.push(`already carrying ${carryingCount}`);
                }

                if (!pickedSomething) {
                    console.log('[planner] L3 handoff_bonus: nothing to drop — abort');
                    memory.recordToolCall('finish_objective', { auto: true },
                        `[DONE] L3 handoff_bonus aborted: no parcel to relay (${log.join(' | ')})`);
                    return;
                }

                try { status = JSON.parse(this.tools.get_status()); } catch (_) {}

                const me = { x: status.x, y: status.y };
                const dzs = (mapInfo?.deliveryZones || []);
                const dz = getClosest(me, dzs);
                let dropTile = null;
                if (dz) {
                    const candidates = [
                        { x: dz.x + 1, y: dz.y }, { x: dz.x - 1, y: dz.y },
                        { x: dz.x,     y: dz.y + 1 }, { x: dz.x, y: dz.y - 1 }
                    ];
                    for (const c of candidates) {

                        if (dzs.some(z => z.x === c.x && z.y === c.y)) continue;
                        dropTile = c; break;
                    }
                }
                if (dropTile) {
                    const obs = await this.tools.go_to(`${dropTile.x},${dropTile.y}`);
                    log.push(`go_to(${dropTile.x},${dropTile.y}): ${truncate(obs, 80)}`);
                    memory.recordToolCall('go_to', `${dropTile.x},${dropTile.y}`, obs);
                } else {
                    log.push('no delivery zone known; dropping in place');
                }

                const dropped = await this.tools.putdown();
                log.push(`putdown: ${truncate(dropped, 80)}`);
                memory.recordToolCall('putdown', '', dropped);

                console.log(`[planner] L3 handoff_bonus orchestrated: ${log.join(' | ')}`);
                memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] L3 handoff_bonus: relay parcel staged for BDI to deliver`);
                return;
            }
            case 'wait_for_signal': {
                await this.asa.broadcast('REQUEST', { intent: 'wait_for_signal' });
                console.log('[planner] L3 wait_for_signal: REQUEST sent — BDI will freeze until "resume"');
                memory.recordToolCall('finish_objective', { auto: true },
                    '[DONE] L3 wait_for_signal applied — BDI frozen');
                return;
            }
            case 'resume': {
                await this.asa.broadcast('REQUEST', { intent: 'resume' });
                console.log('[planner] L3 resume: REQUEST sent — BDI is back to normal deliberation');
                memory.recordToolCall('finish_objective', { auto: true },
                    '[DONE] L3 resume applied');
                return;
            }
            default:
                console.log(`[planner] L3 unknown kind: ${kind}`);
                memory.recordToolCall('finish_objective', { auto: true },
                    `[DONE] L3 unknown coordination kind: ${kind}`);
        }
    }

    async _callModel(turnMessages, iter) {
        const t0 = Date.now();
        console.log(`[planner] iter ${iter+1}: thinking (model=${this.model})...`);
        const hb = setInterval(() => {
            process.stdout.write(`\r[planner] iter ${iter+1}: thinking… ${Math.floor((Date.now()-t0)/1000)}s `);
        }, 1000);
        try {
            const out = await this._rawCall(turnMessages);
            clearInterval(hb); process.stdout.write('\n');
            return out;
        } catch (err) {
            clearInterval(hb); process.stdout.write('\n');
            const detail = [
                err.message,
                err.status ? `status=${err.status}` : null,
                err.code ? `code=${err.code}` : null,
                err.cause?.code ? `cause=${err.cause.code}` : null
            ].filter(Boolean).join(' ');
            console.log(`[planner] LLM call failed: ${detail}`);
            if (err.cause?.code === 'ENOTFOUND' || err.cause?.code === 'ECONNREFUSED') {
                console.log('[planner] hint: endpoint unreachable. If remote profile, connect to unitn VPN; if local, check Ollama.');
            }
            return null;
        }
    }

    async _rawCall(messages) {
        const completion = this.llmClient.chat.completions.create({
            model: this.model,
            messages,
            temperature: 0
        });
        const response = await Promise.race([
            completion,
            new Promise((_, rej) => setTimeout(
                () => rej(new Error(`LLM call exceeded ${this.llmTimeoutMs}ms timeout`)),
                this.llmTimeoutMs))
        ]);
        return response.choices?.[0]?.message?.content ?? '';
    }
}

function truncate(s, n = 220) {
    if (typeof s !== 'string') s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
}
