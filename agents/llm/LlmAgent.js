import { LlmMemory } from './LlmMemory.js';
import { LlmPlanner } from './LlmPlanner.js';
import { detectRule, detectCoordination } from './ruleParser.js';
import { splitMissions, parseJsonArray } from './util.js';
import * as tools from './tools.js';

export const SEGMENT_PROMPT = `
You split a player's chat message into the distinct MISSIONS it contains, for a
DeliverooJS agent. A message may hold one mission or several, joined by "and",
"also", "then", commas, etc.

CRITICAL: many SINGLE missions naturally contain "and" — do NOT split those:
- "move to an odd-numbered row and wait for our message" -> ONE mission
- "a parcel picked up by one agent and delivered by the other for 200pts" -> ONE
- "pick up and deliver three parcels" -> ONE
- "What is the capital of Italy? Send the answer to the sender" -> ONE
Split ONLY when the parts are genuinely SEPARATE objectives that could each stand
alone as their own mission, e.g.:
- "Move to (4,7) for +10pts and deliver stacks of 3 to double the reward"
  -> ["Move to (4,7) for +10pts", "deliver stacks of 3 to double the reward"]

Each returned mission must be SELF-CONTAINED (keep its own coordinates, numbers
and rewards). Output ONLY a JSON array of strings — one element if there is just
one mission. No prose.`.trim();

// Agent B's LLM layer: interprets each special mission (memory -> ReAct planner ->
// decision) and routes it (answer / goal / rule / coordination). The BDI core does
// the moving; the deterministic parsers are only a fallback when the LLM fails.
export class LlmAgent {

    constructor({ client, bdi, llm, coordinator = null, team = null }) {
        this.client = client;
        this.bdi = bdi;
        this.llm = llm;
        this.coordinator = coordinator;
        this.team = team;
        this.memory = new LlmMemory(client, bdi);
        this.planner = new LlmPlanner(llm, client);
    }

    // A message may carry several missions; split and handle each in turn.
    async handleMessage(message, fromId = null) {
        const text = typeof message === 'string'
            ? message : (message?.mission ?? message?.text ?? JSON.stringify(message));
        const missions = await this.segment(text);
        if (missions.length > 1) {
            console.log(`[llm] message holds ${missions.length} missions — handling each in turn.`);
        }
        for (const m of missions) {
            await this.handleMission(m, fromId).catch(err => console.log(`[llm] mission error: ${err.message}`));
        }
    }

    // Heuristic split first; then ask the LLM to split by meaning any part that may
    // join missions with "and"/"also"/"then" (keeps single "…and…" missions whole).
    async segment(text) {
        const base = splitMissions(text);
        const out = [];
        for (const part of base) {
            if (this._mightJoinMissions(part)) {
                const parts = await this._llmSegment(part).catch(() => null);
                if (parts && parts.length > 1) { out.push(...parts); continue; }
            }
            out.push(part);
        }
        return out.length ? out : [text];
    }

    _mightJoinMissions(text) {
        return /\b(and|also|then|plus|as well as)\b/i.test(text) || /[.!?]\s+\S[\s\S]*[.!?]/.test(text);
    }

    async _llmSegment(text) {
        const out = await this.llm.chat(
            [{ role: 'system', content: SEGMENT_PROMPT }, { role: 'user', content: text }],
            { temperature: 0 });
        const arr = parseJsonArray(out);
        if (!arr) return null;
        const missions = arr.map(s => String(s).trim()).filter(s => s.length >= 3);
        return missions.length ? missions : null;
    }

    async handleMission(mission, fromId = null) {
        console.log(`[llm] mission received: "${mission}"`);

        // while a red-light task is parked, a short "go" cue releases both agents
        if (this.coordinator && this.coordinator.isAwaitingGo()
            && /^(go|green ?light|move|proceed|start)\b/i.test(String(mission).trim())) {
            console.log('[llm] green-light cue received — releasing the red-light hold.');
            return this.coordinator.go(fromId);
        }

        let decision = await this.planner.plan(mission, this.memory.context()).catch(() => null);

        // fallback to the deterministic parsers if the LLM gave nothing usable
        if (!decision || !decision.kind) {
            const coord = detectCoordination(mission);
            const rule  = !coord && detectRule(mission);
            if (coord)      decision = { kind: 'coordination', summary: 'parsed deterministically', effect: coord };
            else if (rule)  decision = { kind: 'rule', summary: 'parsed deterministically', effect: rule };
            else            decision = { kind: 'ignore', summary: 'not understood', effect: {} };
            console.log(`[llm] planner produced no decision -> fallback: ${decision.kind}`);
        } else {
            console.log(`[llm] decision: ${decision.kind} — ${decision.summary || ''}`);
        }

        this.memory.remember(mission, decision);

        switch (decision.kind) {
            case 'answer': return this._doAnswer(decision, fromId);
            case 'goal':   return this._doGoal(decision, fromId);
            case 'rule':   return this._doRule(decision, mission);
            case 'coordination': return this._doCoordination(decision, fromId);
            default:
                console.log('[llm] nothing to do (ignored).');
                return;
        }
    }

    async _doAnswer(decision, fromId) {
        const answer = String(decision.effect?.text ?? '');
        console.log(`[llm] answer: ${answer}`);
        if (fromId) await this.client.say(fromId, answer);
        return answer;
    }

    _doGoal(decision, fromId) {
        const e = decision.effect || {};
        const reward = Number(e.reward);
        if (Number.isFinite(reward) && reward <= 0) {
            console.log(`[llm] goal payoff is ${reward} (<= 0) — dropping it (trap).`);
            return;
        }
        const target = this._resolveTarget(e);
        if (!target) {
            const where = Number.isFinite(e.x) ? `(${e.x},${e.y})` : (e.where || 'location');
            console.log(`[llm] goal ${where} is off-grid / not walkable — ignoring (unreachable).`);
            if (fromId) this.client.say(fromId, `cannot reach ${where} — not a valid tile`).catch(() => {});
            return;
        }

        const goal = {
            kind: e.goal || 'goto',
            x: target.x, y: target.y,
            reward: Number.isFinite(reward) ? reward : 1,
            fromId, summary: decision.summary
        };
        this.bdi.addMissionGoal(goal);
        if (this.team) { this.team.sendGoal(goal); console.log('[llm] goal handed to the BDI core and shared with the team-mate.'); }
        else console.log('[llm] goal handed to the BDI core, which will weigh it against normal play.');
    }

    _doCoordination(decision, fromId) {
        if (!this.coordinator) {
            console.log('[llm] coordination mission but no Coordinator wired — ignoring.');
            return;
        }
        console.log(`[llm] coordination -> ${decision.effect?.task || '?'} (handing to Coordinator).`);
        return this.coordinator.handle(decision.effect || {}, fromId);
    }

    _doRule(decision, mission) {
        const e = decision.effect || {};
        let applied = e.rule && this.bdi.applyRule(e) ? e : null;
        if (!applied) {
            const parsed = detectRule(mission);
            if (parsed && this.bdi.applyRule(parsed)) applied = parsed;
        }
        if (applied) {
            if (this.team) this.team.sendRule(applied);
            console.log('[llm] persistent rule applied (and shared with the team-mate).');
        } else {
            console.log('[llm] rule not recognised — ignoring.');
        }
    }

    // returns null for an off-grid / non-walkable tile, so an impossible goal is
    // never injected
    _resolveTarget(effect) {
        if (Number.isFinite(effect.x) && Number.isFinite(effect.y)) {
            const x = Math.round(effect.x), y = Math.round(effect.y);
            return this._isWalkable(x, y) ? { x, y } : null;
        }
        if (effect.where) {
            const st = this.client.state;
            const tiles = effect.goal === 'drop_at' ? st.deliveryZones : tools.walkableTiles(st);
            return tools.resolveRelative(tiles, effect.where);
        }
        return null;
    }

    _isWalkable(x, y) {
        const t = this.client.state.map.get(`${x},${y}`);
        return t !== undefined && String(t) !== '0';
    }
}
