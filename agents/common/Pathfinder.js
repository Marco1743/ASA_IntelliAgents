import { MinHeap, DIRECTIONS, tileBlocksFromDirection } from './geometry.js';

// A* over the tile grid. findPath -> array of step directions or null.
// opts.softCosts (per-tile penalties, e.g. enemy cost map) makes the path route
// around enemies/crowds; without it, enemy-occupied tiles get a flat penalty.
export class Pathfinder {

    constructor(map) {
        this.map = map;
    }

    findPath(start, target, { obstacles = new Map(), agents = new Map(), softCosts = null } = {}) {
        const startX = Math.round(start.x);
        const startY = Math.round(start.y);
        const targetX = Math.round(target.x);
        const targetY = Math.round(target.y);

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

                let extra = 0;
                if (softCosts) {
                    // never penalise the destination tile, so we can still reach a
                    // parcel/zone even if an enemy is standing on it
                    if (!(nx === targetX && ny === targetY)) extra = softCosts.get(key) || 0;
                } else {
                    for (const a of agents.values()) {
                        if (Math.round(a.x) === nx && Math.round(a.y) === ny) {
                            if (!(nx === targetX && ny === targetY)) extra = 14;
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
