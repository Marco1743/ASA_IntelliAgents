// A* pathfinder shared by both agents.
//
// The base algorithm is identical; the difference is the *cost map* fed in.
// BDI passes a rich one (enemy adjacency, predicted enemy moves, congestion
// heat); LLM passes a simple one (just current enemy tiles). We don't bake
// either behaviour into this class — callers prepare the cost map.

import { DIRECTIONS, MinHeap, tileBlocksFromDirection } from './geometry.js';

export class Pathfinder {

    /**
     * @param {Map<string,string>} mapTiles - keyed by "x,y", value is the tile type
     */
    constructor(mapTiles) {
        this.mapTiles = mapTiles;
    }

    /**
     * Plan a path from `start` to `target`.
     *
     * @param {{x:number, y:number}} start
     * @param {{x:number, y:number}} target
     * @param {object} [opts]
     * @param {Map<string,number>} [opts.softCosts] - per-tile extra cost ("x,y" -> n)
     * @param {Set<string>|Map<string,any>} [opts.blocked] - tiles to treat as walls
     * @param {Set<string>|Map<string,any>} [opts.obstacles] - same, kept for compat
     * @returns {string[]|null} array of directions ['up','left',...] or null
     */
    findPath(start, target, opts = {}) {
        if (!start || !target || start.x === undefined) return null;

        const sx = Math.round(start.x);
        const sy = Math.round(start.y);
        const tx = Math.round(target.x);
        const ty = Math.round(target.y);

        const softCosts = opts.softCosts || null;
        const blocked   = opts.blocked   || null;
        const obstacles = opts.obstacles || null;

        const heur = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);

        const open = new MinHeap();
        open.push({ x: sx, y: sy, g: 0, f: heur(sx, sy), path: [] });

        const gScore = new Map();
        gScore.set(`${sx},${sy}`, 0);

        while (!open.isEmpty()) {
            const cur = open.pop();
            if (cur.x === tx && cur.y === ty) return cur.path;

            for (const d of DIRECTIONS) {
                const nx = cur.x + d.dx;
                const ny = cur.y + d.dy;
                const key = `${nx},${ny}`;

                // Hard blockers.
                if (obstacles && obstacles.has(key)) continue;
                if (blocked && blocked.has(key) && !(nx === tx && ny === ty)) continue;

                // Off-map or wall.
                const tileType = this.mapTiles.get(key);
                if (tileType === undefined || String(tileType) === '0') continue;

                // One-way tiles.
                if (tileBlocksFromDirection(tileType, d.dir)) continue;

                // Step cost = 1 + per-tile soft cost (enemies, congestion).
                let step = 1;
                if (softCosts) {
                    const soft = softCosts.get(key) || 0;
                    // Goal tile is exempt from heavy soft cost — never refuse the
                    // target itself just because an enemy sits next to it.
                    if (nx === tx && ny === ty) step += Math.min(soft, 4);
                    else step += soft;
                }

                const tentative = cur.g + step;
                if (!gScore.has(key) || tentative < gScore.get(key)) {
                    gScore.set(key, tentative);
                    open.push({
                        x: nx, y: ny,
                        g: tentative,
                        f: tentative + heur(nx, ny),
                        path: [...cur.path, d.dir]
                    });
                }
            }
        }
        return null;
    }
}
