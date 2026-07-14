// option scoring

import { manhattan, getClosest } from '../common/geometry.js';
import { BLACKLIST_TTL_MS, CONGESTION_DECAY_MS, RACE_LOSS_MARGIN, DEFAULT_MOVE_MS } from './BdiBeliefs.js';

const FAR_TRIP_STEPS         = 8;
const ACCUMULATE_PATIENCE_MS = 5000;

// best parcel
export function getBestParcel(state, beliefs, { excludeTile = null } = {}) {
    const carrying = state.carrying;
    const isCarrying = carrying.length > 0;
    const targetDeliveryZone = getClosest(state.me, state.deliveryZones);
    const now = Date.now();

    let best = null;
    let bestScore = -Infinity;

    const maxReward = beliefs.constraints?.parcelRewardMax;
    const canDecay = (beliefs.decayPerMs || 0) > 0;

    for (const p of state.parcels.values()) {
        if (p.carriedBy) continue;
        if (excludeTile && Math.round(p.x) === excludeTile.x && Math.round(p.y) === excludeTile.y) continue;

        const blacklistedAt = beliefs.blacklistedTargets.get(p.id);
        if (blacklistedAt && now - blacklistedAt < BLACKLIST_TTL_MS) continue;

        // reward filter
        if (maxReward != null && (p.reward || 0) > maxReward && !canDecay) continue;

        let distToParcel = manhattan(state.me, p);
        if (distToParcel === 0) distToParcel = 0.1;

        let reward = beliefs.expectedRewardAt
            ? beliefs.expectedRewardAt(p, distToParcel, state)
            : (p.reward || 1);
        if (maxReward != null && reward > maxReward) reward = maxReward;
        if (reward <= 0) continue;
        let score;

        if (isCarrying && targetDeliveryZone) {
            // detour scoring
            const directPath   = manhattan(state.me, targetDeliveryZone);
            const pathWithDetour = manhattan(state.me, p) + manhattan(p, targetDeliveryZone);
            let detourCost = pathWithDetour - directPath;
            if (detourCost <= 0) detourCost = 0.1;
            score = reward / detourCost;
        } else {
            const closestDelivery = getClosest(p, state.deliveryZones);
            const distToDelivery = manhattan(p, closestDelivery);
            score = reward / (distToParcel + distToDelivery);
        }

        // race factor
        let raceMul = 1;
        for (const a of state.agents.values()) {
            const ad = manhattan(a, p);
            if (ad + RACE_LOSS_MARGIN < distToParcel) { raceMul = 0.25; break; }
            else if (ad < distToParcel) raceMul = Math.min(raceMul, 0.6);
        }
        score *= raceMul;

        // congestion factor
        const cong = beliefs.congestionMap?.get(`${Math.round(p.x)},${Math.round(p.y)}`);
        if (cong) {
            const age = now - cong.lastSeen;
            if (age < CONGESTION_DECAY_MS) {
                const fresh = 1 - age / CONGESTION_DECAY_MS;
                score *= 1 / (1 + cong.count * fresh * 0.1);
            }
        }

        if (!best || score > bestScore) {
            best = p;
            bestScore = score;
        }
    }

    return best;
}

// best delivery zone
export function getBestDeliveryZone(state, beliefs) {
    const zones = state.deliveryZones;
    if (!zones || zones.length === 0) return null;

    const rewards = beliefs?.constraints?.deliveryZoneRewards || [];
    if (rewards.length === 0) return getClosest(state.me, zones);

    const multOf = z => {
        const r = rewards.find(e => e.x === z.x && e.y === z.y);
        return r ? r.multiplier : 1;
    };

    const carriedValue = state.carrying.reduce((s, p) => s + (p.reward || 0), 0) || 10;

    let best = null, bestScore = -Infinity;
    for (const z of zones) {
        const mult = multOf(z);
        if (mult <= 0) continue;
        const score = carriedValue * mult - manhattan(state.me, z);
        if (score > bestScore) { bestScore = score; best = z; }
    }
    return best || getClosest(state.me, zones);
}

// deliver-now decision
export function shouldDeliverNow(state, beliefs, candidate) {
    const carrying = state.carrying;
    if (carrying.length === 0) return false;
    if (carrying.length >= state.config.capacity) return true;

    // stack rules
    const bonusNs = (beliefs.constraints?.deliveryStacks || [])
        .filter(s => s.multiplier > 1).map(s => s.n);
    if (bonusNs.length && carrying.length < Math.min(...bonusNs)) {
        return candidate ? false : true;
    }

    // reward cap + decay timing
    const maxR = beliefs.constraints?.parcelRewardMax;
    if (maxR != null && beliefs.decayPerMs > 0) {
        const overCap = carrying.filter(p => (p.reward || 0) > maxR);
        if (overCap.length > 0) {
            const zone = getBestDeliveryZone(state, beliefs);
            const stepsToZone = zone ? manhattan(state.me, zone) : 0;
            const stepMs = state.config.movementDuration || DEFAULT_MOVE_MS;
            const soonestSteps = Math.min(...overCap.map(p =>
                ((p.reward - maxR) / beliefs.decayPerMs) / stepMs));
            if (soonestSteps <= stepsToZone + 1) return true;
        }
    }

    if (!candidate) {
        // lingering
        const zone = getClosest(state.me, state.deliveryZones);
        const tripSteps = zone ? manhattan(state.me, zone) : 0;
        const sincePickup = Date.now() - (beliefs.lastPickupAt || 0);
        if (tripSteps >= FAR_TRIP_STEPS
            && state.spawnZones && state.spawnZones.length > 0
            && sincePickup < ACCUMULATE_PATIENCE_MS) {
            return false;
        }
        return true;
    }

    if (!beliefs.expectedRewardAt || !beliefs.decayPerMs || beliefs.decayPerMs <= 0) return false;

    // decay trade-off
    const target = getClosest(state.me, state.deliveryZones);
    if (!target) return false;

    const stepMs = state.config.movementDuration || DEFAULT_MOVE_MS;
    const directSteps = manhattan(state.me, target);
    const detourSteps = (manhattan(state.me, candidate) + manhattan(candidate, target)) - directSteps;
    const decayOnCarried = Math.max(0, detourSteps) * stepMs * beliefs.decayPerMs * carrying.length;
    const candidateGain  = beliefs.expectedRewardAt(candidate, manhattan(state.me, candidate), state);
    const carriedSum     = carrying.reduce((s, p) => s + (p.reward || 0), 0);

    return candidateGain < decayOnCarried + Math.max(1, carriedSum * 0.05);
}

// best spawn zone
export function getBestSpawnZone(state, beliefs) {
    if (state.spawnZones.length === 0) return null;

    const now = Date.now();
    const vision = state.config.vision || 5;
    const crowdedness = Math.min(state.agents.size / 4, 2);

    let bestZone = null;
    let bestScore = Infinity;

    for (const zone of state.spawnZones) {
        const key = `${zone.x},${zone.y}`;
        const distToZone = manhattan(state.me, zone);

        let opponentsNearby = 0;
        let nearestEnemyDist = Infinity;
        for (const a of state.agents.values()) {
            const d = manhattan(zone, a);
            if (d <= vision) opponentsNearby++;
            if (d < nearestEnemyDist) nearestEnemyDist = d;
        }

        let contested = 0;
        const cong = beliefs.congestionMap?.get(key);
        if (cong) {
            const age = now - cong.lastSeen;
            if (age < CONGESTION_DECAY_MS) contested = cong.count * (1 - age / CONGESTION_DECAY_MS);
        }

        // recency
        const lastCheck = beliefs.lastChecked.get(key) || 0;
        const since = now - lastCheck;
        let recencyPenalty;
        if (since < 15000)      recencyPenalty = 800;
        else if (since < 25000) recencyPenalty = 200;
        else                    recencyPenalty = -Math.min(since / 1000, 60);

        const score = distToZone
            + opponentsNearby * 18
            + contested * 4
            + (nearestEnemyDist === 0 ? 400 : 0)
            + recencyPenalty;

        if (score < bestScore) {
            bestScore = score;
            bestZone = zone;
        }
    }

    const cutoff = 500 + crowdedness * 300;
    return bestScore > cutoff ? null : bestZone;
}

// explore target
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
