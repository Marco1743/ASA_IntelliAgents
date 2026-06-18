// Extra belief state specific to the BDI agent — sits alongside the base
// WorldState owned by GameClient. Holds everything the crowded-world logic
// needs: enemy velocity history, congestion heat map, blocked tiles, claims
// honoured from other agents, blacklisted parcels, current plan.

import { manhattan } from '../common/geometry.js';

// Tunables — kept here so the agent loop can read them without magic numbers.
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
        this.client = client;            // GameClient reference (read-only here)

        this.obstacles          = new Map();   // "x,y" -> ts (failed move target)
        this.blacklistedTargets = new Map();   // parcel/zone id -> ts
        this.blockedTiles       = new Map();   // "x,y" -> ts (stuck-handler hard block)
        this.spawnActivity      = new Map();   // "x,y" -> ts (last seen parcel here)
        this.lastChecked        = new Map();   // "x,y" -> ts (we visited this zone)
        this.congestionMap      = new Map();   // "x,y" -> { count, lastSeen }
        this.teamClaims         = new Map();   // parcel_id -> { byId, at }
        this.teamMessages       = [];

        this.currentPlan = null;

        // Inject enemy-velocity tracking onto GameClient's sensing.
        client.on('agents-update', () => this._enrichAgents());

        // Initialise spawn-activity timestamps once map arrives.
        client.on('map', () => {
            const now = Date.now();
            for (const z of client.state.spawnZones) {
                this.spawnActivity.set(`${z.x},${z.y}`, now);
            }
        });
    }

    /** Estimate enemy velocity from prior observation + 0.6 mid-step heuristic. */
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

            // Bump congestion at the enemy's current tile.
            const k = `${Math.round(a.x)},${Math.round(a.y)}`;
            const cell = this.congestionMap.get(k) || { count: 0, lastSeen: now };
            cell.count = Math.min(cell.count + 1, 50);
            cell.lastSeen = now;
            this.congestionMap.set(k, cell);
        }
    }

    /** Build a per-tile soft cost map used by A* when planning. */
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
        return cost;
    }

    /** True if any sensed enemy can reach `target` strictly sooner than I can. */
    isRaceLost(target) {
        const me = this.client.state.me;
        const myDist = manhattan(me, target);
        for (const a of this.client.state.agents.values()) {
            if (manhattan(a, target) + RACE_LOSS_MARGIN < myDist) return true;
        }
        return false;
    }

    /** Expire stale entries in all the time-windowed maps. */
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
