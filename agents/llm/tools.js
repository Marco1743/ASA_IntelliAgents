
import { Pathfinder } from '../common/Pathfinder.js';
import { manhattan, getClosest } from '../common/geometry.js';

const STEP_DELAY_MS = 50;

export const TOOLS_DESCRIPTION = `
- get_status(): returns id, position, score, carried parcels.
- sense_environment(): returns visible parcels, agents, zone counts, vision range.
- get_map_info(): returns map width/height and delivery/spawn zone lists.

- move(direction): moves one step. Input is a direction string. Example: up
- pickup(): picks up parcels on my current tile. Input: none
- putdown(): drops ALL carried parcels. Input: none

- go_to(x,y): plans an A* path and walks to (x,y). Input format: "x,y".  Example: 10,15
- go_to_nearest_parcel(): walks to the best visible free parcel and picks it up. Input: none
- deliver_carried_parcels(): walks to the nearest delivery zone and drops carried parcels. Input: none
- deliver_to(x,y): robust delivery to a SPECIFIC delivery tile. Acquires a parcel
                   if not carrying one, picks the parcel that best survives the
                   trip, retries if a parcel expires en route, and confirms the
                   drop. Use for "deliver to the leftmost/rightmost tile" missions
                   with the coords from get_map_info. Input format: "x,y".
- patrol_spawn_zone(): walks to a less crowded spawn zone to scout. Input: none

- broadcast_message(text): shouts a free-form text to all agents.
- reply_to_sender(text): PRIVATE reply to the agent that sent the current mission.
                         For knowledge/calculation answers ("capital of Italy", "5*5").
- share_belief(kind|payload): structured belief share. Input format: "kind|<json>".
                              Example: parcel|{"id":"p7","x":3,"y":4,"reward":20}
- claim_parcel(parcel_id): broadcasts a CLAIM so teammates yield. Input: parcel id string.
- ask_bdi(question): query the BDI agent and wait up to 2.5s for an answer.
- read_inbox(): drains and returns ASA messages received from other agents. Input: none

- update_notes(note): append a free-form note to my scratchpad memory.
- finish_objective(summary): declare the current mission done. Required to stop the loop.
`.trim();

export function makeTools({ client, memory, asa }) {

    const pathfinder = new Pathfinder(client.state.map);
    const patrolHistory = new Map();

    function findPathLLM(target) {
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

    function get_status() {
        const st = client.state;
        return JSON.stringify({
            id: st.me.id, name: st.me.name,
            x: st.me.x !== undefined ? Math.round(st.me.x) : null,
            y: st.me.y !== undefined ? Math.round(st.me.y) : null,
            score: st.me.score,
            carrying: st.carrying.map(p => p.id),
            capacity: st.config.capacity
        });
    }

    function sense_environment() {
        const st = client.state;
        return JSON.stringify({
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
        });
    }

    function get_map_info() {
        const st = client.state;

        const dz = [...st.deliveryZones].sort((a, b) => a.x - b.x || a.y - b.y);
        return JSON.stringify({
            width: st.mapWidth, height: st.mapHeight,
            deliveryZones: dz,
            leftmostDeliveryZone:  dz[0] || null,
            rightmostDeliveryZone: dz[dz.length - 1] || null,
            spawnZones: st.spawnZones
        });
    }

    async function move(direction) {
        const dir = (direction || '').trim().toLowerCase();
        if (!['up','down','left','right'].includes(dir)) {
            return `Error: invalid direction '${direction}'. Use up/down/left/right.`;
        }
        const r = await client.move(dir);
        return r ? `Successfully moved ${dir}. New position: ${JSON.stringify(r)}.`
                 : `Error: failed to move ${dir} (blocked or invalid).`;
    }

    async function pickup() {
        const picked = await client.pickup();
        const ids = (picked || []).map(p => p.id || p.xy && `(${p.xy.x},${p.xy.y})` || '?');
        return `Picked up ${ids.length} parcel(s): ${JSON.stringify(ids)}`;
    }

    async function putdown() {
        const dropped = await client.putdown();
        const ids = (dropped || []).map(p => p.id || p.xy && `(${p.xy.x},${p.xy.y})` || '?');
        return `Dropped ${ids.length} parcel(s): ${JSON.stringify(ids)}`;
    }

    async function go_to(input) {
        const m = String(input || '').match(/(-?\d+)\s*[,;\s]+\s*(-?\d+)/);
        if (!m) return `Error: invalid input '${input}'. Expected "x,y".`;
        const x = parseInt(m[1], 10), y = parseInt(m[2], 10);
        const path = findPathLLM({ x, y });
        if (!path) return `Error: no path found to (${x},${y}).`;
        if (path.length === 0) return `Already at (${x},${y}).`;
        const r = await walkPath(path);
        return r.ok ? `Reached (${x},${y}) in ${r.steps} steps.`
                    : `Error: ${r.error} (after ${r.steps_taken} steps).`;
    }

    async function go_to_nearest_parcel() {
        const st = client.state;
        const candidates = st.freeParcels;
        if (candidates.length === 0) return 'Error: no visible parcels.';

        let best = null, bestScore = -Infinity;
        for (const p of candidates) {
            const dP = manhattan(st.me, p) || 0.1;
            const dz = getClosest(p, st.deliveryZones);
            const dD = dz ? manhattan(p, dz) : 0;
            const s = (p.reward || 1) / (dP + dD);
            if (s > bestScore) { best = p; bestScore = s; }
        }
        if (!best) return 'Error: no scoreable parcel.';
        const path = findPathLLM(best);
        if (!path) return `Error: no path to parcel ${best.id}.`;
        const w = await walkPath(path);
        if (!w.ok) return `Error: ${w.error} en route to parcel ${best.id}.`;
        const picked = await client.pickup();
        return `Walked to ${best.id} at (${best.x},${best.y}); picked up ${(picked||[]).length} parcel(s).`;
    }

    async function deliver_to(input) {
        const m = String(input || '').match(/(-?\d+)\s*[,;\s]+\s*(-?\d+)/);
        if (!m) return `Error: invalid input '${input}'. Expected "x,y".`;
        const target = { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
        const st = client.state;
        const MAX_ATTEMPTS = 4;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

            if (st.carrying.length === 0) {
                const cands = st.freeParcels;
                if (cands.length === 0) {

                    if (st.spawnZones.length) {
                        const z = getClosest(st.me, st.spawnZones);
                        const p = z ? findPathLLM(z) : null;
                        if (p) await walkPath(p);
                    }
                    continue;
                }

                let best = null, bestScore = -Infinity;
                for (const p of cands) {
                    const dPick = manhattan(st.me, p) || 0.1;
                    const dDeliver = manhattan(p, target);
                    const score = (p.reward || 1) / (dPick + dDeliver);
                    if (score > bestScore) { bestScore = score; best = p; }
                }
                const path = findPathLLM(best);
                if (!path) continue;
                if ((await walkPath(path)).ok === false) continue;
                await client.pickup();
                if (st.carrying.length === 0) continue;
            }

            const path = findPathLLM(target);
            if (!path) return `Error: no path to delivery tile (${target.x},${target.y}).`;
            if ((await walkPath(path)).ok === false) continue;

            if (st.carrying.length === 0) continue;

            const dropped = await client.putdown();
            if ((dropped || []).length > 0) {
                return `Delivered ${dropped.length} parcel(s) at (${target.x},${target.y}). Score now ${st.me.score}. (attempt ${attempt})`;
            }
        }
        return `Error: could not complete delivery to (${target.x},${target.y}) after ${MAX_ATTEMPTS} attempts (parcels expired or none reachable).`;
    }

    async function deliver_carried_parcels() {
        const st = client.state;
        if (st.carrying.length === 0) return 'Error: not carrying any parcel.';
        const target = getClosest(st.me, st.deliveryZones);
        if (!target) return 'Error: no delivery zone known.';
        const path = findPathLLM(target);
        if (!path) return 'Error: no path to delivery zone.';
        const w = await walkPath(path);
        if (!w.ok) return `Error: ${w.error} en route to delivery.`;
        const dropped = await client.putdown();
        return `Delivered at (${target.x},${target.y}); dropped ${(dropped||[]).length} parcel(s).`;
    }

    async function patrol_spawn_zone() {
        const st = client.state;
        if (st.spawnZones.length === 0) return 'Error: no spawn zones known on this map.';
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
        if (!best) return 'Error: could not pick a zone.';
        const path = findPathLLM(best);
        if (!path) return `Error: no path to zone (${best.x},${best.y}).`;
        const w = await walkPath(path);
        if (!w.ok) return `Error: ${w.error} en route to spawn zone.`;
        patrolHistory.set(`${best.x},${best.y}`, Date.now());
        return `Reached spawn zone (${best.x},${best.y}). Call sense_environment to see new parcels.`;
    }

    async function broadcast_message(text) {
        await asa.broadcast('FREE', { text: String(text || '') });
        return `Broadcast sent: "${text}".`;
    }

    async function reply_to_sender(text) {
        const toId = memory.lastMissionSenderId;
        const toName = memory.lastMissionSenderName;
        if (toId) {
            await client.say(toId, String(text || ''));
            return `Reply sent privately to ${toName || toId}: "${text}".`;
        }
        await asa.broadcast('FREE', { text: String(text || '') });
        return `No specific sender known; answer broadcast: "${text}".`;
    }

    async function share_belief(input) {

        const sep = String(input || '').indexOf('|');
        if (sep < 0) return `Error: expected "kind|<json>". Got: ${input}`;
        const kind = input.slice(0, sep).trim();
        let payload;
        try { payload = JSON.parse(input.slice(sep + 1).trim()); }
        catch (e) { return `Error: invalid JSON payload: ${e.message}`; }
        await asa.broadcast('BELIEF', { kind, ...payload });
        return `Belief broadcast: kind=${kind}.`;
    }

    async function claim_parcel(parcel_id) {
        const id = String(parcel_id || '').trim();
        if (!id) return 'Error: parcel_id is empty.';
        await asa.broadcast('CLAIM', { parcel_id: id });
        return `Claim broadcast for parcel ${id}.`;
    }

    async function ask_bdi(question) {
        const answer = await asa.ask(String(question || ''), 2500);
        return answer ? `BDI answered: ${JSON.stringify(answer)}`
                      : 'No answer within timeout.';
    }

    async function read_inbox() {
        const msgs = memory.drainInbox();
        return `Inbox (${msgs.length} message(s)): ${JSON.stringify(msgs)}`;
    }

    function update_notes(note) {
        memory.addNote(String(note || ''));
        return 'Note added.';
    }

    function finish_objective(summary) {

        return `[DONE] ${String(summary || 'objective complete')}`;
    }

    return {
        get_status, sense_environment, get_map_info,
        move, pickup, putdown,
        go_to, go_to_nearest_parcel, deliver_carried_parcels, deliver_to, patrol_spawn_zone,
        broadcast_message, reply_to_sender, share_belief, claim_parcel, ask_bdi, read_inbox,
        update_notes, finish_objective
    };
}
