// Deliberation logic for the BDI agent — pure functions over (state, beliefs).
//
// "Intention selection" answers the question: given what I know right now,
// which parcel/zone should I commit to?

import { manhattan, getClosest } from '../common/geometry.js';
import { CONGESTION_DECAY_MS, RACE_LOSS_MARGIN } from './BdiBeliefs.js';

/**
 * Pick the best parcel to chase right now. Combines reward, distance to
 * pickup + delivery, race-loss penalty, and a congestion penalty.
 */
export function getBestParcel(state, beliefs) {
    const isCarrying = state.carrying.length > 0;
    const targetDeliveryZone = getClosest(state.me, state.deliveryZones);
    const now = Date.now();

    let best = null, bestScore = -Infinity;

    for (const p of state.parcels.values()) {
        if (p.carriedBy) continue;
        const black = beliefs.blacklistedTargets.get(p.id);
        if (black && now - black < 15000) continue;

        let dP = manhattan(state.me, p) || 0.1;
        const reward = p.reward || 1;
        let score;

        if (isCarrying && targetDeliveryZone) {
            const direct = manhattan(state.me, targetDeliveryZone);
            const detour = (manhattan(state.me, p) + manhattan(p, targetDeliveryZone)) - direct;
            score = reward / (detour <= 0 ? 0.1 : detour);
        } else {
            const closestDel = getClosest(p, state.deliveryZones);
            score = reward / (dP + manhattan(p, closestDel));
        }

        // Race penalty.
        let raceMul = 1;
        for (const a of state.agents.values()) {
            const ad = manhattan(a, p);
            if (ad + RACE_LOSS_MARGIN < dP) { raceMul = 0.25; break; }
            else if (ad < dP)               { raceMul = Math.min(raceMul, 0.6); }
        }
        score *= raceMul;

        // Congestion penalty.
        const cong = beliefs.congestionMap.get(`${Math.round(p.x)},${Math.round(p.y)}`);
        if (cong) {
            const age = now - cong.lastSeen;
            if (age < CONGESTION_DECAY_MS) {
                const fresh = 1 - (age / CONGESTION_DECAY_MS);
                score *= 1 / (1 + cong.count * fresh * 0.1);
            }
        }

        if (score > bestScore) { best = p; bestScore = score; }
    }
    return best;
}

/**
 * Choose a spawn zone to patrol. Penalises crowded zones, recently-visited
 * zones, and zones the heat-map flags as contested.
 */
export function getBestSpawnZone(state, beliefs) {
    if (state.spawnZones.length === 0) return null;

    const now = Date.now();
    const vision = state.config.vision || 5;
    const crowdedness = Math.min(state.agents.size / 4, 2);

    let bestZone = null, bestScore = Infinity;

    for (const zone of state.spawnZones) {
        const key = `${zone.x},${zone.y}`;
        const dist = manhattan(state.me, zone);

        let opponentsNearby = 0, nearestEnemyDist = Infinity;
        for (const a of state.agents.values()) {
            const d = manhattan(zone, a);
            if (d <= vision) opponentsNearby++;
            if (d < nearestEnemyDist) nearestEnemyDist = d;
        }

        let contested = 0;
        const cong = beliefs.congestionMap.get(key);
        if (cong) {
            const age = now - cong.lastSeen;
            if (age < CONGESTION_DECAY_MS) contested = cong.count * (1 - age / CONGESTION_DECAY_MS);
        }

        const lastCheck = beliefs.lastChecked.get(key) || 0;
        const since = now - lastCheck;
        let recencyPenalty;
        if (since < 15000)      recencyPenalty = 800;
        else if (since < 25000) recencyPenalty = 200;
        else                    recencyPenalty = -Math.min(since / 1000, 60);

        const score = dist
            + opponentsNearby * 18
            + contested * 4
            + (nearestEnemyDist === 0 ? 400 : 0)
            + recencyPenalty;

        if (score < bestScore) { bestScore = score; bestZone = zone; }
    }

    const cutoff = 500 + crowdedness * 300;
    return bestScore > cutoff ? null : bestZone;
}

/**
 * Stable random walkable tile *outside vision* — used as a last-resort "go
 * somewhere new" target when nothing better is available.
 */
export function getRandomExploreTarget(state) {
    const visionRange = state.config.vision || 5;
    const candidates = [];
    for (const [key, type] of state.map.entries()) {
        if (String(type) === '0') continue;
        const [x, y] = key.split(',').map(Number);
        if (manhattan(state.me, { x, y }) > visionRange) {
            candidates.push({ x, y, id: `explore_${x}_${y}` });
        }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}
