// geometry helpers

export const DIRECTIONS = Object.freeze([
    { dir: 'up',    dx: 0,  dy: 1  },
    { dir: 'down',  dx: 0,  dy: -1 },
    { dir: 'right', dx: 1,  dy: 0  },
    { dir: 'left',  dx: -1, dy: 0  }
]);

export function manhattan(a, b) {
    if (!a || !b || a.x === undefined || b.x === undefined) return Infinity;
    return Math.abs(Math.round(a.x) - Math.round(b.x))
         + Math.abs(Math.round(a.y) - Math.round(b.y));
}

export function getClosest(from, candidates) {
    let best = null, bestD = Infinity;
    for (const c of candidates) {
        const d = manhattan(from, c);
        if (d < bestD) { best = c; bestD = d; }
    }
    return best;
}

// one-way tiles
export function tileBlocksFromDirection(tileType, dir) {
    const t = String(tileType);
    return (dir === 'left'  && t === '→')
        || (dir === 'right' && t === '←')
        || (dir === 'up'    && t === '↓')
        || (dir === 'down'  && t === '↑');
}

// min-heap (A* open set)
export class MinHeap {
    constructor() { this.heap = []; }

    push(node) {
        this.heap.push(node);
        this._bubbleUp(this.heap.length - 1);
    }

    pop() {
        if (this.heap.length === 0) return null;
        const top = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    isEmpty() { return this.heap.length === 0; }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.heap[i].f >= this.heap[parent].f) break;
            [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
            i = parent;
        }
    }

    _sinkDown(i) {
        const n = this.heap.length;
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let best = i;
            if (l < n && this.heap[l].f < this.heap[best].f) best = l;
            if (r < n && this.heap[r].f < this.heap[best].f) best = r;
            if (best === i) break;
            [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
            i = best;
        }
    }
}
