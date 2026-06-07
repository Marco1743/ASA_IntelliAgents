
import { onlineSolver, PddlProblem } from '@unitn-asa/pddl-client';
import { tileBlocksFromDirection } from './geometry.js';

const DOMAIN_STRING = `(define (domain default)
    (:requirements :strips)
    (:predicates
        (at ?t)
        (adj-up ?from ?to)
        (adj-down ?from ?to)
        (adj-left ?from ?to)
        (adj-right ?from ?to)
    )
    (:action move-up
        :parameters (?from ?to)
        :precondition (and (at ?from) (adj-up ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-down
        :parameters (?from ?to)
        :precondition (and (at ?from) (adj-down ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-left
        :parameters (?from ?to)
        :precondition (and (at ?from) (adj-left ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move-right
        :parameters (?from ?to)
        :precondition (and (at ?from) (adj-right ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
)`;

export class PddlPathfinder {

    constructor(mapTiles, opts = {}) {
        this.mapTiles = mapTiles;
        this.timeoutMs = opts.timeoutMs || 8000;
        this._domain = DOMAIN_STRING;
    }

    _tileName(x, y) { return `t_${x}_${y}`; }

    _buildProblem(sx, sy, tx, ty, blocked, obstacles) {

        const slack = Math.max(6, Math.abs(tx - sx) + Math.abs(ty - sy));
        const xMin = Math.min(sx, tx) - slack, xMax = Math.max(sx, tx) + slack;
        const yMin = Math.min(sy, ty) - slack, yMax = Math.max(sy, ty) + slack;

        const objects = [];
        const walkable = new Set();
        for (const [key, type] of this.mapTiles.entries()) {
            if (String(type) === '0') continue;
            const [x, y] = key.split(',').map(Number);
            if (x < xMin || x > xMax || y < yMin || y > yMax) continue;
            if (blocked && blocked.has(key)) continue;
            if (obstacles && obstacles.has(key)) continue;
            const name = this._tileName(x, y);
            objects.push(name);
            walkable.add(name);
        }

        const facts = [];
        const tileTypeAt = (x, y) => this.mapTiles.get(`${x},${y}`);

        for (const name of objects) {

            const parts = name.split('_');
            const x = Number(parts[1]);
            const y = Number(parts[2]);

            const candidates = [
                { dir: 'up',    nx: x,     ny: y + 1 },
                { dir: 'down',  nx: x,     ny: y - 1 },
                { dir: 'right', nx: x + 1, ny: y     },
                { dir: 'left',  nx: x - 1, ny: y     }
            ];
            for (const c of candidates) {
                const nName = this._tileName(c.nx, c.ny);
                if (!walkable.has(nName)) continue;
                const nType = tileTypeAt(c.nx, c.ny);
                if (tileBlocksFromDirection(nType, c.dir)) continue;
                facts.push(`(adj-${c.dir} ${name} ${nName})`);
            }
        }

        facts.push(`(at ${this._tileName(sx, sy)})`);

        return new PddlProblem(
            'pathfind',
            objects.join(' '),
            facts.join(' '),
            `at ${this._tileName(tx, ty)}`
        ).toPddlString();
    }

    async findPath(start, target, opts = {}) {
        if (!start || !target || start.x === undefined) return null;

        const sx = Math.round(start.x);
        const sy = Math.round(start.y);
        const tx = Math.round(target.x);
        const ty = Math.round(target.y);

        if (sx === tx && sy === ty) return [];

        const blocked   = opts.blocked   || null;
        const obstacles = opts.obstacles || null;
        const problem   = this._buildProblem(sx, sy, tx, ty, blocked, obstacles);

        let plan;
        try {

            plan = await Promise.race([
                onlineSolver(this._domain, problem),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error(`pddl solver timeout (${this.timeoutMs}ms)`)),
                        this.timeoutMs))
            ]);
        } catch (err) {
            console.log(`[pddl] ${err.message}`);
            return null;
        }
        if (!plan || plan.length === 0) return null;

        const out = [];
        for (const step of plan) {
            const a = String(step.action || '').toLowerCase();
            if (a === 'move-up')    out.push('up');
            else if (a === 'move-down')  out.push('down');
            else if (a === 'move-left')  out.push('left');
            else if (a === 'move-right') out.push('right');
        }
        return out;
    }
}
