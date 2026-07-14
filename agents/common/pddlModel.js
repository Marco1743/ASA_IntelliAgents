// pddl model (domain + problem)

import { tileBlocksFromDirection } from './geometry.js';

export const DOMAIN_NAME = 'deliveroo-grid';

const DIRS = ['up', 'down', 'left', 'right'];

// pddl domain (navigation + sokoban crates)
export const DOMAIN_STRING = `(define (domain ${DOMAIN_NAME})
    (:requirements :strips :typing)
    (:types crate tile)
    (:predicates
        (at ?t - tile)
        (at-crate ?c - crate ?t - tile)
        (clear ?t - tile)
        (type5 ?t - tile)
        (adj-up ?from - tile ?to - tile)
        (adj-down ?from - tile ?to - tile)
        (adj-left ?from - tile ?to - tile)
        (adj-right ?from - tile ?to - tile)
    )
${DIRS.map(d => `    (:action move-${d}
        :parameters (?from - tile ?to - tile)
        :precondition (and (at ?from) (adj-${d} ?from ?to) (clear ?to))
        :effect (and (at ?to) (not (at ?from)))
    )`).join('\n')}
${DIRS.map(d => `    (:action push-${d}
        :parameters (?c - crate ?from - tile ?mid - tile ?to - tile)
        :precondition (and (at ?from) (adj-${d} ?from ?mid) (adj-${d} ?mid ?to)
                           (at-crate ?c ?mid) (type5 ?to) (clear ?to))
        :effect (and (at ?mid) (not (at ?from))
                     (at-crate ?c ?to) (not (at-crate ?c ?mid))
                     (clear ?mid) (not (clear ?to)))
    )`).join('\n')}
)`;

export const tileName = (x, y) => `t_${x}_${y}`;
const crateName = c => `crate_${String(c.id).replace(/[^a-zA-Z0-9_]/g, '_')}`;

// pddl problem
export function buildProblem(map, sx, sy, tx, ty, { obstacles = null, agents = null, crates = null } = {}) {
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

    // tile objects
    for (const [key, type] of map.entries()) {
        if (String(type) === '0') continue;
        if (key !== startKey && key !== targetKey) {
            if (obstacles && obstacles.has(key)) continue;
            if (agentBlocked.has(key)) continue;
        }
        const [x, y] = key.split(',').map(Number);
        const name = tileName(x, y);
        walkable.add(name);
        objects.push(name);
    }

    // crate objects
    const crateAt = new Map();
    const crateObjects = [];
    if (crates) {
        for (const c of crates.values()) {
            const cx = Math.round(c.x), cy = Math.round(c.y);
            const key = `${cx},${cy}`;
            if (!walkable.has(tileName(cx, cy))) continue;
            if (crateAt.has(key)) continue;
            crateAt.set(key, crateName(c));
            crateObjects.push(crateName(c));
        }
    }

    // adjacency + clear + type5 facts
    const facts = [];
    const tileTypeAt = (x, y) => map.get(`${x},${y}`);

    for (const name of objects) {
        const [, xs, ys] = name.split('_');
        const x = Number(xs), y = Number(ys);
        const key = `${x},${y}`;
        if (!crateAt.has(key)) facts.push(`(clear ${name})`);
        if (String(tileTypeAt(x, y)).startsWith('5')) facts.push(`(type5 ${name})`);
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

    for (const [key, cname] of crateAt.entries()) {
        const [x, y] = key.split(',').map(Number);
        facts.push(`(at-crate ${cname} ${tileName(x, y)})`);
    }

    facts.push(`(at ${tileName(sx, sy)})`);

    const objDecl = `${objects.join(' ')} - tile`
        + (crateObjects.length ? ` ${crateObjects.join(' ')} - crate` : '');

    return `(define (problem pathfind)
    (:domain ${DOMAIN_NAME})
    (:objects ${objDecl})
    (:init ${facts.join(' ')})
    (:goal (at ${tileName(tx, ty)})))`;
}

export function actionToDirection(action) {
    const a = String(action || '').toLowerCase().replace(/^(?:move|push)[-_]/, '');
    return (a === 'up' || a === 'down' || a === 'left' || a === 'right') ? a : null;
}
