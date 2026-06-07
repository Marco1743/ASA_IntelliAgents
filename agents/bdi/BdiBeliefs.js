
import { manhattan } from '../common/geometry.js';

export const ENEMY_ADJ_COST       = 4;
export const ENEMY_PREDICTED_COST = 8;
export const ENEMY_ON_TILE_COST   = 20;
export const CONGESTION_MAX_COST  = 6;
export const CONGESTION_DECAY_MS  = 30000;
export const AGENT_FORGET_MS      = 6000;
export const BLOCKED_TILE_MS      = 8000;
export const RACE_LOSS_MARGIN     = 1;

export class BdiBeliefs {

    constructor(client) {
        this.client = client;

        this.obstacles          = new Map();
        this.blacklistedTargets = new Map();
        this.blockedTiles       = new Map();
        this.spawnActivity      = new Map();
        this.lastChecked        = new Map();
        this.congestionMap      = new Map();
        this.teamClaims         = new Map();
        this.teamMessages       = [];

        this.parcelHistory      = new Map();
        this.decayPerMs         = 0;

        this.constraints = {
            deliveryThreshold: null,
            deliveryBonus: null,
            preferredDeliveryTiles: [],
            forbiddenDeliveryTiles: [],
            parcelRewardMax: null,

            tilePenalties: [],
            tileBonuses:   [],

            forcedTarget: null,
            pauseUntilResume: false
        };

        this.metrics = {
            startedAt: Date.now(),
            pickups: 0,
            deliveries: 0,
            scoreSnapshot: 0,
            plansBuilt: 0,
            claimsHonored: 0,
            blockedTilesAdded: 0
        };

        this.currentPlan = null;

        client.on('agents-update', () => this._enrichAgents());

        client.on('parcels-update', () => this._learnDecay());

        client.on('map', () => {
            const now = Date.now();
            for (const z of client.state.spawnZones) {
                this.spawnActivity.set(`${z.x},${z.y}`, now);
            }
        });
    }

    _learnDecay() {
        const now = Date.now();
        let totalSlope = 0, samples = 0;
        for (const p of this.client.state.parcels.values()) {
            const prev = this.parcelHistory.get(p.id);
            if (prev) {
                const dt = now - prev.lastSeen;
                const dr = prev.lastReward - (p.reward || 0);
                if (dt > 50 && dr >= 0 && dr <= 5) {
                    totalSlope += dr / dt;
                    samples++;
                }
                prev.lastSeen = now;
                prev.lastReward = p.reward || 0;
            } else {
                this.parcelHistory.set(p.id, {
                    firstSeen: now, firstReward: p.reward || 0,
                    lastSeen: now,  lastReward:  p.reward || 0
                });
            }
        }
        if (samples > 0) {
            const avg = totalSlope / samples;

            this.decayPerMs = this.decayPerMs === 0 ? avg : (0.9 * this.decayPerMs + 0.1 * avg);
        }

        for (const id of this.parcelHistory.keys()) {
            if (!this.client.state.parcels.has(id)) this.parcelHistory.delete(id);
        }
    }

    expectedRewardAt(parcel, pathSteps) {
        const stepMs = this.client.state.config.movementDuration || 200;
        const travelMs = pathSteps * stepMs;
        const decayed = (parcel.reward || 0) - travelMs * this.decayPerMs;
        return Math.max(decayed, 0);
    }

    _enrichAgents() {
        const st = this.client.state;
        const now = Date.now();
        for (const a of st.agents.values()) {
            let vx = 0, vy = 0;
            if (a.prev) {
                const dx = a.x - a.prev.x;
                const dy = a.y - a.prev.y;
                if (Math.abs(dx) > 0.15) vx = Math.sign(dx);
                if (Math.abs(dy) > 0.15) vy = Math.sign(dy);
            }
            if (vx === 0 && vy === 0) {
                const fx = a.x - Math.floor(a.x);
                const fy = a.y - Math.floor(a.y);
                if (fx > 0.4 && fx < 0.7) vx = 1;
                else if (fx > 0.25 && fx < 0.5) vx = -1;
                if (fy > 0.4 && fy < 0.7) vy = 1;
                else if (fy > 0.25 && fy < 0.5) vy = -1;
            }
            a.vx = vx; a.vy = vy;

            const k = `${Math.round(a.x)},${Math.round(a.y)}`;
            const cell = this.congestionMap.get(k) || { count: 0, lastSeen: now };
            cell.count = Math.min(cell.count + 1, 50);
            cell.lastSeen = now;
            this.congestionMap.set(k, cell);
        }
    }

    buildEnemyCostMap() {
        const cost = new Map();
        const bump = (x, y, c) => {
            const k = `${x},${y}`;
            cost.set(k, (cost.get(k) || 0) + c);
        };
        for (const a of this.client.state.agents.values()) {
            const ax = Math.round(a.x), ay = Math.round(a.y);
            bump(ax, ay, ENEMY_ON_TILE_COST);
            bump(ax + 1, ay, ENEMY_ADJ_COST);
            bump(ax - 1, ay, ENEMY_ADJ_COST);
            bump(ax, ay + 1, ENEMY_ADJ_COST);
            bump(ax, ay - 1, ENEMY_ADJ_COST);
            if (a.vx || a.vy) bump(ax + (a.vx || 0), ay + (a.vy || 0), ENEMY_PREDICTED_COST);
        }
        const now = Date.now();
        for (const [k, info] of this.congestionMap.entries()) {
            const age = now - info.lastSeen;
            if (age > CONGESTION_DECAY_MS) continue;
            const fresh = 1 - (age / CONGESTION_DECAY_MS);
            const penalty = Math.min(info.count * fresh * 0.5, CONGESTION_MAX_COST);
            if (penalty > 0.5) cost.set(k, (cost.get(k) || 0) + penalty);
        }

        for (const t of (this.constraints?.tilePenalties || [])) {
            const k = `${Math.round(t.x)},${Math.round(t.y)}`;
            cost.set(k, (cost.get(k) || 0) + (t.points || 0));
        }
        return cost;
    }

    isRaceLost(target) {
        const me = this.client.state.me;
        const myDist = manhattan(me, target);
        for (const a of this.client.state.agents.values()) {
            if (manhattan(a, target) + RACE_LOSS_MARGIN < myDist) return true;
        }
        return false;
    }

    pruneStale() {
        const now = Date.now();
        for (const [k, info] of this.congestionMap.entries()) {
            if (now - info.lastSeen > CONGESTION_DECAY_MS) this.congestionMap.delete(k);
        }
        for (const [k, ts] of this.blockedTiles.entries()) {
            if (now - ts > BLOCKED_TILE_MS) this.blockedTiles.delete(k);
        }
        for (const [k, ts] of this.obstacles.entries()) {
            if (now - ts > 3000) this.obstacles.delete(k);
        }
    }
}
