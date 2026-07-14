import { MinHeap, DIRECTIONS, tileBlocksFromDirection } from './geometry.js';

// A* pathfinding
export class Pathfinder {

    constructor(map) {
        this.map = map;
    }

    findPath(start, target, { obstacles = new Map(), agents = new Map(), softCosts = null, crates = null } = {}) {
        const startX = Math.round(start.x);
        const startY = Math.round(start.y);
        const targetX = Math.round(target.x);
        const targetY = Math.round(target.y);

        // crate tiles
        const crateKeys = new Set();
        if (crates) {
            for (const c of crates.values()) crateKeys.add(`${Math.round(c.x)},${Math.round(c.y)}`);
        }

        const heuristic = (x, y) => Math.abs(x - targetX) + Math.abs(y - targetY);

        const open = new MinHeap();
        open.push({ x: startX, y: startY, g: 0, f: heuristic(startX, startY), path: [] });

        const gScores = new Map([[`${startX},${startY}`, 0]]);

        while (!open.isEmpty()) {
            const current = open.pop();

            if (current.x === targetX && current.y === targetY) {
                return current.path;
            }

            for (const d of DIRECTIONS) {
                const nx = current.x + d.dx;
                const ny = current.y + d.dy;
                const key = `${nx},${ny}`;

                if (obstacles.has(key)) continue;

                const tileType = this.map.get(key);
                if (tileType === undefined || String(tileType) === '0') continue;
                if (tileBlocksFromDirection(tileType, d.dir)) continue;

                // single push: crate ahead is passable only if it can slide onto a free type-5 tile
                let pushCost = 0;
                if (crateKeys.has(key)) {
                    const bx = nx + d.dx, by = ny + d.dy;
                    const beyondKey = `${bx},${by}`;
                    const beyondType = this.map.get(beyondKey);
                    if (beyondType === undefined || !String(beyondType).startsWith('5')) continue;
                    if (crateKeys.has(beyondKey)) continue;
                    pushCost = 2;
                }

                // soft costs
                let extra = pushCost;
                if (softCosts) {
                    if (!(nx === targetX && ny === targetY)) extra += softCosts.get(key) || 0;
                } else {
                    for (const a of agents.values()) {
                        if (Math.round(a.x) === nx && Math.round(a.y) === ny) {
                            if (!(nx === targetX && ny === targetY)) extra += 14;
                            break;
                        }
                    }
                }

                const stepCost = 1 + extra;
                const tentativeG = current.g + stepCost;

                if (!gScores.has(key) || tentativeG < gScores.get(key)) {
                    gScores.set(key, tentativeG);
                    open.push({
                        x: nx,
                        y: ny,
                        g: tentativeG,
                        f: tentativeG + heuristic(nx, ny),
                        path: [...current.path, d.dir]
                    });
                }
            }
        }

        return null;
    }
}
