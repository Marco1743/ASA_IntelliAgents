// Shared geometry primitives used by both agents.
//
// The four cardinal directions are kept in a single source of truth so a tile
// type like '→' is rejected the same way regardless of who is planning.

export const DIRECTIONS = Object.freeze([
    { dir: 'up',    dx: 0,  dy: 1  },
    { dir: 'down',  dx: 0,  dy: -1 },
    { dir: 'right', dx: 1,  dy: 0  },
    { dir: 'left',  dx: -1, dy: 0  }
]);

/** Manhattan distance between two integer-or-fractional positions. */
export function manhattan(a, b) {
    if (!a || !b || a.x === undefined || b.x === undefined) return Infinity;
    return Math.abs(Math.round(a.x) - Math.round(b.x))
         + Math.abs(Math.round(a.y) - Math.round(b.y));
}

/** Closest point in `candidates` to `from`, by Manhattan distance. */
export function getClosest(from, candidates) {
    let best = null, bestD = Infinity;
    for (const c of candidates) {
        const d = manhattan(from, c);
        if (d < bestD) { best = c; bestD = d; }
    }
    return best;
}

/** Returns true if `tileType` blocks movement coming from `dir` (one-way tiles). */
export function tileBlocksFromDirection(tileType, dir) {
    const t = String(tileType);
    return (dir === 'left'  && t === '→')
        || (dir === 'right' && t === '←')
        || (dir === 'up'    && t === '↓')
        || (dir === 'down'  && t === '↑');
}

/**
 * Binary min-heap, ordered by the `.f` field of inserted nodes.
 * Shared by the Pathfinder; kept here so both agents pull from one source.
 */
export class MinHeap {
    constructor() { this.h = []; }

    push(node) {
        this.h.push(node);
        this._bubbleUp(this.h.length - 1);
    }

    pop() {
        if (this.h.length === 0) return null;
        const top = this.h[0];
        const last = this.h.pop();
        if (this.h.length > 0) {
            this.h[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    get size() { return this.h.length; }
    isEmpty()  { return this.h.length === 0; }

    _bubbleUp(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.h[i].f >= this.h[p].f) break;
            [this.h[i], this.h[p]] = [this.h[p], this.h[i]];
            i = p;
        }
    }

    _sinkDown(i) {
        const n = this.h.length;
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let best = i;
            if (l < n && this.h[l].f < this.h[best].f) best = l;
            if (r < n && this.h[r].f < this.h[best].f) best = r;
            if (best === i) break;
            [this.h[i], this.h[best]] = [this.h[best], this.h[i]];
            i = best;
        }
    }
}
