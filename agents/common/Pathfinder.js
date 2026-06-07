
import { DIRECTIONS, MinHeap, tileBlocksFromDirection } from './geometry.js';

export class Pathfinder {

    constructor(mapTiles) {
        this.mapTiles = mapTiles;
    }

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

                if (obstacles && obstacles.has(key)) continue;
                if (blocked && blocked.has(key) && !(nx === tx && ny === ty)) continue;

                const tileType = this.mapTiles.get(key);
                if (tileType === undefined || String(tileType) === '0') continue;

                if (tileBlocksFromDirection(tileType, d.dir)) continue;

                let step = 1;
                if (softCosts) {
                    const soft = softCosts.get(key) || 0;

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
