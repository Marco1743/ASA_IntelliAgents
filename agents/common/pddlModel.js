// Shared PDDL model for grid navigation (used by both PddlPathfinder and
// FastDownwardPathfinder): one tile = one object, position (at ?t), walkability
// and one-way tiles -> directed (adj-* from to) facts, goal (at target). The
// problem covers the whole walkable map; only walls, obstacles and tiles held by
// other agents are excluded.

import { tileBlocksFromDirection } from './geometry.js';

export const DOMAIN_NAME = 'deliveroo-grid';

export const DOMAIN_STRING = `(define (domain ${DOMAIN_NAME})
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

export const tileName = (x, y) => `t_${x}_${y}`;

// map: WorldState.map ("x,y" -> tile type). Returns the (define (problem …)) text.
export function buildProblem(map, sx, sy, tx, ty, { obstacles = null, agents = null } = {}) {
    const agentBlocked = new Set();
    if (agents) {
        for (const a of agents.values()) {
            const ax = Math.round(a.x), ay = Math.round(a.y);
            if (!(ax === tx && ay === ty)) agentBlocked.add(`${ax},${ay}`);
        }
    }

    const startKey = `${sx},${sy}`;
    const targetKey = `${tx},${ty}`;
    const walkable = new Set();
    const objects = [];

    for (const [key, type] of map.entries()) {
        if (String(type) === '0') continue;
        const [x, y] = key.split(',').map(Number);
        if (key !== startKey && key !== targetKey) {
            if (obstacles && obstacles.has(key)) continue;
            if (agentBlocked.has(key)) continue;
        }
        const name = tileName(x, y);
        walkable.add(name);
        objects.push(name);
    }

    const facts = [];
    const tileTypeAt = (x, y) => map.get(`${x},${y}`);

    for (const name of objects) {
        const [, xs, ys] = name.split('_');
        const x = Number(xs), y = Number(ys);
        const candidates = [
            { dir: 'up',    nx: x,     ny: y + 1 },
            { dir: 'down',  nx: x,     ny: y - 1 },
            { dir: 'right', nx: x + 1, ny: y     },
            { dir: 'left',  nx: x - 1, ny: y     }
        ];
        for (const c of candidates) {
            const nName = tileName(c.nx, c.ny);
            if (!walkable.has(nName)) continue;
            if (tileBlocksFromDirection(tileTypeAt(c.nx, c.ny), c.dir)) continue;
            facts.push(`(adj-${c.dir} ${name} ${nName})`);
        }
    }

    facts.push(`(at ${tileName(sx, sy)})`);

    return `(define (problem pathfind)
    (:domain ${DOMAIN_NAME})
    (:objects ${objects.join(' ')})
    (:init ${facts.join(' ')})
    (:goal (at ${tileName(tx, ty)})))`;
}

// "move-up" / "move_up" -> "up"; null for anything else
export function actionToDirection(action) {
    const a = String(action || '').toLowerCase().replace(/^move[-_]/, '');
    return (a === 'up' || a === 'down' || a === 'left' || a === 'right') ? a : null;
}
