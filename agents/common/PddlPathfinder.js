import { onlineSolver } from '@unitn-asa/pddl-client';
import { DOMAIN_STRING, buildProblem, actionToDirection } from './pddlModel.js';

// PDDL motion planner using the ONLINE solver (kept for comparison via
// PDDL_SOLVER=online; the default is the local FastDownwardPathfinder). The HTTP
// solver is slow, so we race it against a timeout and return null on timeout.
// Same findPath contract as Pathfinder: -> directions | [] (already there) | null.
export class PddlPathfinder {

    constructor(map, opts = {}) {
        this.map = map;
        this.timeoutMs = opts.timeoutMs || 8000;
        this._domain = DOMAIN_STRING;
    }

    async findPath(start, target, opts = {}) {
        if (!start || !target || start.x === undefined) return null;

        const sx = Math.round(start.x), sy = Math.round(start.y);
        const tx = Math.round(target.x), ty = Math.round(target.y);
        if (sx === tx && sy === ty) return [];

        const targetType = this.map.get(`${tx},${ty}`);
        if (targetType === undefined || String(targetType) === '0') return null;

        const problem = buildProblem(this.map, sx, sy, tx, ty, opts);

        let plan;
        try {
            const solverP = onlineSolver(this._domain, problem);
            solverP.catch(() => {}); // avoid unhandled rejection if the timeout wins
            plan = await Promise.race([
                solverP,
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`solver timeout (${this.timeoutMs}ms)`)), this.timeoutMs))
            ]);
        } catch (err) {
            console.log(`[pddl] ${err.message} — falling back`);
            return null;
        }

        if (!plan || plan.length === 0) return null;

        const out = [];
        for (const step of plan) {
            const dir = actionToDirection(step.action);
            if (dir) out.push(dir);
        }
        return out.length ? out : null;
    }
}
