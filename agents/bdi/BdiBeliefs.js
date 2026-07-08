import { manhattan } from '../common/geometry.js';

export const OBSTACLE_TTL_MS      = 3000;
export const BLACKLIST_TTL_MS     = 15000;

export const CONGESTION_DECAY_MS  = 30000; // how long a crowded-tile memory lasts
export const CONGESTION_COUNT_MAX = 50;    // cap so a parked enemy can't dominate
export const CONGESTION_MAX_COST  = 6;     // max pathfinding penalty from congestion
export const RACE_LOSS_MARGIN     = 1;     // enemy must be this much closer to "win"
export const ENEMY_ON_TILE_COST   = 20;    // pathfinding cost: tile an enemy occupies
export const ENEMY_ADJ_COST       = 4;     // ... a tile next to an enemy
export const ENEMY_PREDICTED_COST = 8;     // ... the tile an enemy seems headed to

export const DEFAULT_MOVE_MS       = 500;  // assumed ms per move step until config says otherwise
export const MIN_DECAY_BASELINE_MS = 1500; // need this long an observation window to trust a rate
export const MAX_DECAY_PER_MS      = 0.01; // clamp: reject implausible rates (>10 pts/sec)

// How many parcels to put down in one action given the active stack rules. Prefers
// the most valuable bonus group (mult>1) that fits; else as many as possible while
// never matching a penalty size (mult<1). 0 = hold and wait for more.
export function stackDeliveryCount(eligibleCount, stacks, moreComing) {
    const bonus = stacks.filter(s => s.multiplier > 1);
    const penaltyNs = new Set(stacks.filter(s => s.multiplier < 1).map(s => s.n));

    const fit = bonus
        .filter(s => s.n <= eligibleCount)
        .sort((a, b) => (b.n * b.multiplier - a.n * a.multiplier) || (b.n - a.n))[0];
    if (fit) return fit.n;
    if (bonus.length && moreComing) return 0;

    let count = eligibleCount;
    while (count > 1 && penaltyNs.has(count)) count--;
    if (penaltyNs.has(count)) return moreComing ? 0 : count;
    return count;
}

// The BDI agent's private memory (on top of the sensed WorldState).
export class BdiBeliefs {

    constructor(client = null) {
        this.client             = client;
        this.obstacles          = new Map(); // "x,y" -> timestamp of a recent failed move
        this.blacklistedTargets = new Map(); // targetId/"x,y" -> timestamp
        this.lastChecked        = new Map(); // spawn zone "x,y" -> last seen timestamp
        this.congestionMap      = new Map(); // "x,y" -> { count, lastSeen }
        this.currentPlan        = null;      // { targetId, target, steps, stuckCount }

        // L1 goals and L3 coordination set by the LLM layer (empty for Agent A alone).
        this.missionGoals       = [];        // [{ id, kind, x, y, reward, fromId, summary }]
        this.coordination       = null;      // { type:'goto_wait'|'hold'|'relay'|'red_light', ... }

        // L2 rules (last the whole match); all empty/null leaves Agent A unchanged.
        this.constraints = {
            avoidTiles:          [],   // [{ x, y, penalty }]
            parcelRewardMax:     null, // number | null
            deliveryZoneRewards: [],   // [{ x, y, multiplier }]
            deliveryStacks:      []    // [{ n, multiplier }] — one per size N, same N overwrites
        };

        // parcel reward decay model
        this.parcelHistory      = new Map(); // id -> { firstSeen, firstReward, lastSeen, lastReward }
        this.decayPerMs         = 0;         // learned reward lost per ms (0 = unknown)
        this.lastPickupAt       = 0;

        this.metrics = {
            startedAt: Date.now(),
            pickups: 0,
            deliveries: 0,
            plansBuilt: 0,
            racesLost: 0
        };

        if (client) {
            client.on('agents',  ({ sensedIds }) => this.observeAgents(client.state, sensedIds));
            client.on('parcels', ({ sensedIds }) => this.learnDecay(client.state, sensedIds));
        }
    }

    // Estimate reward decay (points/ms) from each parcel's full observation window
    // (first sighting -> now), which averages out the 1-point quantisation; clamped.
    learnDecay(state, sensedIds, now = Date.now()) {
        for (const p of state.parcels.values()) {
            if (sensedIds && !sensedIds.has(p.id)) continue;
            const reward = p.reward || 0;
            const h = this.parcelHistory.get(p.id);
            if (!h) {
                this.parcelHistory.set(p.id, { firstSeen: now, firstReward: reward, lastSeen: now, lastReward: reward });
                continue;
            }
            h.lastSeen = now;
            h.lastReward = reward;

            const dt = now - h.firstSeen;
            const dr = h.firstReward - reward;
            if (dt >= MIN_DECAY_BASELINE_MS && dr > 0) {
                const slope = dr / dt;
                if (slope > 0 && slope <= MAX_DECAY_PER_MS) {
                    this.decayPerMs = this.decayPerMs === 0 ? slope : 0.85 * this.decayPerMs + 0.15 * slope;
                }
            }
        }

        for (const id of this.parcelHistory.keys()) {
            if (!state.parcels.has(id)) this.parcelHistory.delete(id);
        }
    }

    // Reward a parcel should still be worth after `steps` moves (last reward minus
    // decay over time-since-seen + travel). Just the stored reward if decay unknown.
    expectedRewardAt(parcel, steps, state, now = Date.now()) {
        const reward = parcel.reward || 0;
        if (this.decayPerMs <= 0) return reward;
        const stepMs = state.config.movementDuration || DEFAULT_MOVE_MS;
        const hist = this.parcelHistory.get(parcel.id);
        const sinceSeen = hist ? (now - hist.lastSeen) : 0;
        const decayed = reward - (sinceSeen + steps * stepMs) * this.decayPerMs;
        return Math.max(decayed, 0);
    }

    // Forget out-of-vision free parcels whose reward has decayed to 0 (expired).
    pruneExpiredParcels(state, now = Date.now()) {
        if (this.decayPerMs <= 0) return;
        const vision = state.config.vision || 5;
        for (const [id, p] of state.parcels) {
            if (p.carriedBy) continue;
            if (manhattan(state.me, p) < vision) continue; // trust the server for visible tiles
            if (this.expectedRewardAt(p, 0, state, now) <= 0) {
                state.parcels.delete(id);
                this.parcelHistory.delete(id);
            }
        }
    }

    // Estimate each enemy's heading from its sub-tile position and bump congestion.
    observeAgents(state, sensedIds = null, now = Date.now()) {
        for (const a of state.agents.values()) {
            if (sensedIds && !sensedIds.has(a.id)) continue;
            let vx = 0, vy = 0;
            const fx = a.x - Math.floor(a.x);
            const fy = a.y - Math.floor(a.y);
            if (fx > 0.4 && fx < 0.7) vx = 1; else if (fx > 0.25 && fx < 0.5) vx = -1;
            if (fy > 0.4 && fy < 0.7) vy = 1; else if (fy > 0.25 && fy < 0.5) vy = -1;
            a.vx = vx; a.vy = vy;

            const k = `${Math.round(a.x)},${Math.round(a.y)}`;
            const cell = this.congestionMap.get(k) || { count: 0, lastSeen: now };
            cell.count = Math.min(cell.count + 1, CONGESTION_COUNT_MAX);
            cell.lastSeen = now;
            this.congestionMap.set(k, cell);
        }
    }

    // Soft-cost map for the pathfinder: penalise enemy tiles, their neighbours and
    // predicted next tile, crowded tiles, and L2 avoid-tiles. Penalties (not walls)
    // so A* still squeezes through when there is no alternative.
    buildEnemyCostMap(state, now = Date.now()) {
        const cost = new Map();
        const bump = (x, y, c) => {
            const k = `${x},${y}`;
            cost.set(k, (cost.get(k) || 0) + c);
        };

        for (const a of state.agents.values()) {
            const ax = Math.round(a.x), ay = Math.round(a.y);
            bump(ax, ay, ENEMY_ON_TILE_COST);
            bump(ax + 1, ay, ENEMY_ADJ_COST);
            bump(ax - 1, ay, ENEMY_ADJ_COST);
            bump(ax, ay + 1, ENEMY_ADJ_COST);
            bump(ax, ay - 1, ENEMY_ADJ_COST);
            if (a.vx || a.vy) bump(ax + (a.vx || 0), ay + (a.vy || 0), ENEMY_PREDICTED_COST);
        }

        for (const [k, info] of this.congestionMap.entries()) {
            const age = now - info.lastSeen;
            if (age > CONGESTION_DECAY_MS) continue;
            const fresh = 1 - age / CONGESTION_DECAY_MS;
            const penalty = Math.min(info.count * fresh * 0.5, CONGESTION_MAX_COST);
            if (penalty > 0.5) {
                const [x, y] = k.split(',').map(Number);
                bump(x, y, penalty);
            }
        }

        for (const t of this.constraints.avoidTiles) {
            bump(Math.round(t.x), Math.round(t.y), t.penalty || 50);
        }
        return cost;
    }

    // Which carried parcels to drop in ONE action now (L2 rules). null -> all,
    // [] -> none yet, [ids] -> drop exactly these. reward_filter: only parcels
    // at/below the cap. delivery_stack: a bonus group of N, else as many as possible
    // without matching a penalty size.
    deliverySet(state) {
        const max    = this.constraints.parcelRewardMax;
        const stacks = this.constraints.deliveryStacks;
        if (max == null && stacks.length === 0) return null;

        let eligible = state.carrying;
        if (max != null) eligible = eligible.filter(p => (p.reward || 0) <= max);
        if (eligible.length === 0) return [];

        if (stacks.length === 0) return eligible.map(p => p.id);

        const count = stackDeliveryCount(eligible.length, stacks, state.freeParcels.length > 0);
        if (count <= 0) return [];
        const sorted = [...eligible].sort((a, b) => (b.reward || 0) - (a.reward || 0));
        return sorted.slice(0, count).map(p => p.id);
    }

    isRaceLost(state, target) {
        const myDist = manhattan(state.me, target);
        for (const a of state.agents.values()) {
            if (manhattan(a, target) + RACE_LOSS_MARGIN < myDist) return true;
        }
        return false;
    }

    pruneStale(now = Date.now()) {
        for (const [key, ts] of this.obstacles.entries()) {
            if (now - ts > OBSTACLE_TTL_MS) this.obstacles.delete(key);
        }
        for (const [key, info] of this.congestionMap.entries()) {
            if (now - info.lastSeen > CONGESTION_DECAY_MS) this.congestionMap.delete(key);
        }
    }
}
