// Tool catalog the LLM sees + JS implementations.
//
// The catalog is split into sensing / low-level actions / high-level actions
// / coordination / control. The OpenAI-compatible JSON schemas live next to
// their implementation so adding a new tool means touching one place.

import { Pathfinder } from '../common/Pathfinder.js';
import { manhattan, getClosest } from '../common/geometry.js';

const STEP_DELAY_MS = 50;

// ---------------------------------------------------------------------------
// JSON schemas (OpenAI function-calling format)
// ---------------------------------------------------------------------------
export function getOpenAITools() {
    return [
        fn('get_status',
           'Return my id, position, score, and how many parcels I am carrying.', {}),
        fn('sense_environment',
           'Return parcels and other agents currently visible, plus zone counts.', {}),
        fn('get_map_info',
           'Return map width/height and lists of delivery and spawn zones.', {}),

        fn('move',
           'Move one tile in the given direction. Use go_to for multi-step navigation.',
           { direction: { type: 'string', enum: ['up','down','left','right'] } },
           ['direction']),
        fn('pickup',
           'Pick up parcels on my current tile. Returns picked-up parcel ids.', {}),
        fn('putdown',
           'Put down all carried parcels. Only scores points on a delivery tile.', {}),

        fn('go_to',
           'Plan an A* path and walk to (x,y). Stops on first failure or arrival.',
           { x: { type: 'integer' }, y: { type: 'integer' } }, ['x','y']),
        fn('go_to_nearest_parcel',
           'Walk to the highest-value visible non-carried parcel and pick it up.', {}),
        fn('deliver_carried_parcels',
           'Walk to the nearest delivery zone and put down all carried parcels.', {}),
        fn('patrol_spawn_zone',
           'Walk to a less-recently-visited and less-crowded spawn zone to scout.', {}),

        fn('broadcast_message',
           'Shout a free-form text to all agents (visible in the game UI).',
           { text: { type: 'string' } }, ['text']),
        fn('share_belief',
           'Send a structured belief to the BDI agent (e.g. parcel sighting, intent).',
           { kind: { type: 'string', description: 'parcel | agent | intent | note' },
             payload: { type: 'object', description: 'Belief contents.' } },
           ['kind','payload']),
        fn('claim_parcel',
           'Announce I am committing to a parcel id (BDI honours it via blacklist).',
           { parcel_id: { type: 'string' } }, ['parcel_id']),
        fn('ask_bdi',
           'Ask the BDI agent a question and wait up to 2.5s for its answer.',
           { question: { type: 'string' } }, ['question']),
        fn('read_inbox',
           'Return and clear any structured messages received from other agents.', {}),

        fn('update_notes',
           'Append a free-form note to my scratchpad memory.',
           { note: { type: 'string' } }, ['note']),
        fn('finish_objective',
           'Declare the current objective complete. Required to stop the loop.',
           { summary: { type: 'string' } }, ['summary'])
    ];
}

function fn(name, description, properties, required = []) {
    return {
        type: 'function',
        function: {
            name, description,
            parameters: { type: 'object', properties, required }
        }
    };
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------
export function makeToolImpls({ client, memory, asa }) {

    const pathfinder = new Pathfinder(client.state.map);
    const patrolHistory = new Map();

    function findPathLLM(target) {
        // LLM uses a simpler soft-cost map: enemies on tiles only.
        const softCosts = new Map();
        for (const a of client.state.agents.values()) {
            softCosts.set(`${Math.round(a.x)},${Math.round(a.y)}`, 12);
        }
        return pathfinder.findPath(client.state.me, target, { softCosts });
    }

    async function walkPath(path) {
        let steps = 0;
        for (const dir of path) {
            const r = await client.move(dir);
            if (!r) return { ok: false, error: `blocked while moving ${dir}`,
                             steps_taken: steps, remaining: path.length - steps };
            steps++;
            if (STEP_DELAY_MS) await new Promise(res => setTimeout(res, STEP_DELAY_MS));
        }
        return { ok: true, steps };
    }

    // -- sensing --

    async function get_status() {
        const st = client.state;
        return {
            id: st.me.id, name: st.me.name,
            x: st.me.x !== undefined ? Math.round(st.me.x) : null,
            y: st.me.y !== undefined ? Math.round(st.me.y) : null,
            score: st.me.score,
            carrying: st.carrying.map(p => p.id),
            capacity: st.config.capacity
        };
    }

    async function sense_environment() {
        const st = client.state;
        return {
            parcels: [...st.parcels.values()].map(p => ({
                id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy || null
            })),
            agents: [...st.agents.values()].map(a => ({
                id: a.id, name: a.name,
                x: Math.round(a.x), y: Math.round(a.y), score: a.score
            })),
            delivery_zone_count: st.deliveryZones.length,
            spawn_zone_count: st.spawnZones.length,
            vision_range: st.config.vision
        };
    }

    async function get_map_info() {
        const st = client.state;
        return {
            width: st.mapWidth, height: st.mapHeight,
            deliveryZones: st.deliveryZones,
            spawnZones: st.spawnZones
        };
    }

    // -- low-level actions --

    async function move({ direction }) {
        if (!['up','down','left','right'].includes(direction))
            return { ok: false, error: `invalid direction '${direction}'` };
        const r = await client.move(direction);
        return r ? { ok: true, position: r } : { ok: false, error: 'move blocked or invalid' };
    }

    async function pickup() {
        return { ok: true, picked_up: (await client.pickup()) || [] };
    }

    async function putdown() {
        return { ok: true, dropped: (await client.putdown()) || [] };
    }

    // -- high-level actions --

    async function go_to({ x, y }) {
        const path = findPathLLM({ x, y });
        if (!path) return { ok: false, error: 'no path found' };
        if (path.length === 0) return { ok: true, reached: true, steps: 0 };
        const r = await walkPath(path);
        return r.ok ? { ok: true, reached: true, steps: r.steps } : r;
    }

    async function go_to_nearest_parcel() {
        const st = client.state;
        const candidates = st.freeParcels;
        if (candidates.length === 0) return { ok: false, error: 'no visible parcels' };

        let best = null, bestScore = -Infinity;
        for (const p of candidates) {
            const dP = manhattan(st.me, p) || 0.1;
            const dz = getClosest(p, st.deliveryZones);
            const dD = dz ? manhattan(p, dz) : 0;
            const s = (p.reward || 1) / (dP + dD);
            if (s > bestScore) { best = p; bestScore = s; }
        }
        if (!best) return { ok: false, error: 'no parcel scoreable' };

        const path = findPathLLM(best);
        if (!path) return { ok: false, error: `no path to parcel ${best.id}` };
        const w = await walkPath(path);
        if (!w.ok) return { ...w, parcel_id: best.id };
        const picked = await client.pickup();
        return { ok: true, parcel_id: best.id, picked_up: picked || [] };
    }

    async function deliver_carried_parcels() {
        const st = client.state;
        if (st.carrying.length === 0)
            return { ok: false, error: 'not carrying any parcel' };
        const target = getClosest(st.me, st.deliveryZones);
        if (!target) return { ok: false, error: 'no delivery zone known' };
        const path = findPathLLM(target);
        if (!path) return { ok: false, error: 'no path to delivery zone' };
        const w = await walkPath(path);
        if (!w.ok) return w;
        return { ok: true, dropped: (await client.putdown()) || [] };
    }

    async function patrol_spawn_zone() {
        const st = client.state;
        if (st.spawnZones.length === 0)
            return { ok: false, error: 'no spawn zones known on this map' };
        const now = Date.now();
        let best = null, bestScore = Infinity;
        for (const z of st.spawnZones) {
            const dist = manhattan(st.me, z);
            let nearby = 0;
            for (const a of st.agents.values()) {
                if (manhattan(a, z) <= 4) nearby++;
            }
            const lastVisit = patrolHistory.get(`${z.x},${z.y}`) || 0;
            const ageS = (now - lastVisit) / 1000;
            const score = dist + nearby * 15 - Math.min(ageS, 60);
            if (score < bestScore) { best = z; bestScore = score; }
        }
        if (!best) return { ok: false, error: 'could not pick a zone' };
        const path = findPathLLM(best);
        if (!path) return { ok: false, error: `no path to zone (${best.x},${best.y})` };
        const w = await walkPath(path);
        if (!w.ok) return { ...w, zone: best };
        patrolHistory.set(`${best.x},${best.y}`, Date.now());
        return { ok: true, reached: best,
                 hint: 'now call sense_environment to see if parcels appeared' };
    }

    // -- coordination --

    async function broadcast_message({ text }) {
        await asa.broadcast('FREE', { text });
        return { ok: true };
    }

    async function share_belief({ kind, payload }) {
        await asa.broadcast('BELIEF', { kind, ...payload });
        return { ok: true };
    }

    async function claim_parcel({ parcel_id }) {
        await asa.broadcast('CLAIM', { parcel_id });
        return { ok: true, claimed: parcel_id };
    }

    async function ask_bdi({ question }) {
        const answer = await asa.ask(question, 2500);
        return answer ? { ok: true, answer }
                      : { ok: false, error: 'no answer within timeout' };
    }

    async function read_inbox() {
        return { messages: memory.drainInbox() };
    }

    // -- control --

    async function update_notes({ note }) {
        memory.addNote(note);
        return { ok: true };
    }

    async function finish_objective({ summary }) {
        return { ok: true, finished: true, summary };
    }

    return {
        get_status, sense_environment, get_map_info,
        move, pickup, putdown,
        go_to, go_to_nearest_parcel, deliver_carried_parcels, patrol_spawn_zone,
        broadcast_message, share_belief, claim_parcel, ask_bdi, read_inbox,
        update_notes, finish_objective
    };
}
