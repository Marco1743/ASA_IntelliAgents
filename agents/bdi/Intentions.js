
import { manhattan, getClosest } from '../common/geometry.js';
import { CONGESTION_DECAY_MS, RACE_LOSS_MARGIN } from './BdiBeliefs.js';

export function getBestParcel(state, beliefs) {
    const carrying = state.carrying;
    const isCarrying = carrying.length > 0;
    const carriedSum = carrying.reduce((s, p) => s + (p.reward || 0), 0);
    const targetDeliveryZone = getBestDeliveryZone(state, beliefs);
    const stepMs = state.config.movementDuration || 200;
    const now = Date.now();

    let best = null, bestScore = -Infinity;

    for (const p of state.parcels.values()) {
        if (p.carriedBy) continue;
        const black = beliefs.blacklistedTargets.get(p.id);
        if (black && now - black < 15000) continue;

        if (beliefs.teamClaims.has(p.id)) continue;

        const maxReward = beliefs.constraints?.parcelRewardMax;
        if (maxReward !== null && maxReward !== undefined && (p.reward || 0) > maxReward) continue;

        const dP = Math.max(manhattan(state.me, p), 0.1);
        const closestDel = getClosest(p, state.deliveryZones);
        const dD = manhattan(p, closestDel);

        const totalSteps = dP + dD;
        const expectedReward = beliefs.expectedRewardAt(p, dP);
        const detourSteps = isCarrying && targetDeliveryZone
            ? (manhattan(state.me, p) + manhattan(p, targetDeliveryZone)
               - manhattan(state.me, targetDeliveryZone))
            : 0;
        const carriedDecayCost = detourSteps * stepMs * beliefs.decayPerMs * carrying.length;
        const netGain = expectedReward + carriedSum - carriedDecayCost;
        let score = netGain / Math.max(totalSteps, 1);

        let raceMul = 1;
        for (const a of state.agents.values()) {
            const ad = manhattan(a, p);
            if (ad + RACE_LOSS_MARGIN < dP) { raceMul = 0.25; break; }
            else if (ad < dP)               { raceMul = Math.min(raceMul, 0.6); }
        }
        score *= raceMul;

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

export function deliveryValue(parcels, bonus) {
    const base = parcels.reduce((s, p) => s + (p.reward || 0), 0);
    if (bonus && bonus.n > 0 && parcels.length === bonus.n) {
        return base * (bonus.multiplier ?? 1);
    }
    return base;
}

export function selectDeliverySet(state, beliefs) {
    const bonus = beliefs.constraints?.deliveryBonus;
    const carrying = state.carrying;
    if (!bonus || bonus.n <= 0) return null;

    const mult = bonus.multiplier ?? 1;
    const sorted = [...carrying].sort((a, b) => (b.reward || 0) - (a.reward || 0));

    if (mult > 1) {
        if (carrying.length <= bonus.n) return null;
        const bestN = sorted.slice(0, bonus.n);
        if (deliveryValue(bestN, bonus) <= deliveryValue(carrying, bonus)) return null;
        return bestN.map(p => p.id);
    }

    if (mult < 1 && carrying.length === bonus.n) {
        if (bonus.n - 1 < 1) return null;
        return sorted.slice(0, bonus.n - 1).map(p => p.id);
    }

    return null;
}

export function shouldDeliverNow(state, beliefs, candidate) {
    const carrying = state.carrying;
    const n = carrying.length;
    if (n === 0) return false;
    if (n >= state.config.capacity) return true;

    const bonus = beliefs.constraints?.deliveryBonus;
    if (bonus && bonus.n > 0) return _shouldDeliverWithBonus(state, beliefs, candidate, bonus);

    const threshold = beliefs.constraints?.deliveryThreshold;
    if (threshold && n < threshold)  return false;
    if (threshold && n >= threshold) return true;

    return _defaultDeliverNow(state, beliefs, candidate);
}

function _defaultDeliverNow(state, beliefs, candidate) {
    const carrying = state.carrying;
    if (!candidate) return true;

    const stepMs = state.config.movementDuration || 200;
    const carriedSum = carrying.reduce((s, p) => s + (p.reward || 0), 0);
    const target = getBestDeliveryZone(state, beliefs);
    if (!target) return false;

    const directSteps = manhattan(state.me, target);
    const detourSteps = (manhattan(state.me, candidate) + manhattan(candidate, target)) - directSteps;
    const decayOnCarried = detourSteps * stepMs * beliefs.decayPerMs * carrying.length;
    const candidateGain = beliefs.expectedRewardAt(candidate, manhattan(state.me, candidate));
    return candidateGain < decayOnCarried + Math.max(1, carriedSum * 0.05);
}

function _shouldDeliverWithBonus(state, beliefs, candidate, bonus) {
    const carrying = state.carrying;
    const n = carrying.length;
    const mult = bonus.multiplier ?? 1;

    if (mult < 1) {
        if (n !== bonus.n) return _defaultDeliverNow(state, beliefs, candidate);

        if (candidate && n < state.config.capacity) return false;
        return true;
    }

    if (n >= bonus.n) return true;
    if (!candidate)   return true;

    const stepMs = state.config.movementDuration || 200;
    const target = getBestDeliveryZone(state, beliefs);
    if (!target) return false;

    const detourSteps = (manhattan(state.me, candidate) + manhattan(candidate, target))
                      - manhattan(state.me, target);

    const remaining = bonus.n - n;
    const decayWhileWaiting = Math.max(0, detourSteps) * stepMs
                            * beliefs.decayPerMs * n * remaining;

    const carriedSum = carrying.reduce((s, p) => s + (p.reward || 0), 0);
    const candReward = beliefs.expectedRewardAt(candidate, manhattan(state.me, candidate));
    const bonusGain  = (mult - 1) * (carriedSum + candReward);

    return !(bonusGain > decayWhileWaiting);
}

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

export function getBestDeliveryZone(state, beliefs) {
    const zones = state.deliveryZones || [];
    if (zones.length === 0) return null;

    const forbidden = beliefs?.constraints?.forbiddenDeliveryTiles || [];
    const preferred = beliefs?.constraints?.preferredDeliveryTiles || [];
    const isForbidden = (z) => forbidden.some(f => f.x === z.x && f.y === z.y);
    const isPreferred = (z) => preferred.some(f => f.x === z.x && f.y === z.y);

    let allowed = zones.filter(z => !isForbidden(z));
    if (allowed.length === 0) allowed = zones;

    let best = null, bestScore = Infinity;
    for (const z of allowed) {
        const d = manhattan(state.me, z);

        const adj = isPreferred(z) ? Math.max(0, d - 4) : d;
        if (adj < bestScore) { best = z; bestScore = adj; }
    }
    return best;
}

function estimateValuePerStep(state) {
    let best = 0;
    for (const p of state.parcels.values()) {
        if (p.carriedBy) continue;
        const dPick = Math.max(manhattan(state.me, p), 0.1);
        const dz = getClosest(p, state.deliveryZones);
        const dDeliver = dz ? manhattan(p, dz) : 0;
        const vps = (p.reward || 1) / ((dPick + dDeliver) || 1);
        if (vps > best) best = vps;
    }
    return best;
}

export function getBestBonusTile(state, beliefs) {
    const tiles = beliefs.constraints?.tileBonuses || [];
    if (tiles.length === 0) return null;

    const vps = estimateValuePerStep(state);
    let best = null;
    for (const b of tiles) {
        const steps = Math.max(manhattan(state.me, b), 0.1);
        const net   = (b.points || 0) - steps * vps;
        if (net <= 0) continue;
        const rate = (b.points || 0) / steps;
        if (!best || rate > best.rate) {
            best = { tile: { x: b.x, y: b.y }, points: b.points, steps, rate, net };
        }
    }
    return best;
}

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
