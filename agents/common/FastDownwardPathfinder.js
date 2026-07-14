import { exec } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOMAIN_STRING, buildProblem, actionToDirection } from './pddlModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// pddl planner (local fast downward)
export class FastDownwardPathfinder {

    constructor(map, opts = {}) {
        this.map = map;
        this.timeoutMs = opts.timeoutMs || 10000;
        this.python   = process.env.PYTHON_CMD   || 'python';
        this.downward = process.env.DOWNWARD_PATH || join(ROOT, 'lib', 'downward', 'fast-downward.py');
        this.search   = process.env.FD_SEARCH    || 'astar(blind())';

        const instance  = process.env.AGENT_INSTANCE || `pid_${process.pid}`;
        this.pddlDir    = join(ROOT, 'pddl');
        this.instDir    = join(this.pddlDir, `tmp_${instance}`);
        this.domainFile = join(this.pddlDir, 'deliveroo-domain.pddl');
        this.problemFile = join(this.instDir, 'problem.pddl');
        this.planFile   = join(this.instDir, 'plan');

        this._available = null;
        this._busy = false;
    }

    _ensureSetup() {
        if (this._available !== null) return this._available;
        const built = existsSync(join(dirname(this.downward), 'builds', 'release', 'bin'));
        this._available = existsSync(this.downward) && built;
        if (!this._available) {
            console.log(`[fd] Fast Downward not built — PDDL disabled, using A*.`);
            console.log('[fd] Build it once with: npm run setup:pddl');
            return false;
        }
        mkdirSync(this.instDir, { recursive: true });
        writeFileSync(this.domainFile, DOMAIN_STRING, 'utf8');
        console.log(`[fd] Fast Downward ready (${this.downward}).`);
        return true;
    }

    // solve
    async findPath(start, target, opts = {}) {
        if (!start || !target || start.x === undefined) return null;
        const sx = Math.round(start.x), sy = Math.round(start.y);
        const tx = Math.round(target.x), ty = Math.round(target.y);
        if (sx === tx && sy === ty) return [];

        const targetType = this.map.get(`${tx},${ty}`);
        if (targetType === undefined || String(targetType) === '0') return null;

        if (!this._ensureSetup()) return null;
        if (this._busy) return null;
        this._busy = true;
        const t0 = Date.now();

        try {
            const problem = buildProblem(this.map, sx, sy, tx, ty, opts);
            writeFileSync(this.problemFile, problem, 'utf8');
            if (existsSync(this.planFile)) { try { unlinkSync(this.planFile); } catch {} }

            const cmd = `"${this.python}" "${this.downward}" --plan-file "${this.planFile}" `
                      + `"${this.domainFile}" "${this.problemFile}" --search "${this.search}"`;

            const { err } = await new Promise(resolve => {
                exec(cmd, { timeout: this.timeoutMs, cwd: this.instDir }, (err) => resolve({ err }));
            });

            if (!existsSync(this.planFile)) {
                // fallback to A*
                const why = err?.killed ? `timed out (${this.timeoutMs}ms)`
                          : err ? `no path to target (exit ${err.code})`
                          : 'no plan';
                console.log(`[fd] ${why} — A* covers it`);
                return null;
            }
            const path = this._parsePlan(readFileSync(this.planFile, 'utf8'));
            if (path) console.log(`[fd] solved (${sx},${sy})->(${tx},${ty}): ${path.length} moves in ${Date.now() - t0}ms`);
            return path;
        } catch (err) {
            console.log(`[fd] solve error: ${err.message}`);
            return null;
        } finally {
            this._busy = false;
        }
    }

    // plan parsing
    _parsePlan(text) {
        const out = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('(')) continue;
            const action = t.slice(1).split(/\s+/)[0];
            const dir = actionToDirection(action);
            if (dir) out.push(dir);
        }
        return out.length ? out : null;
    }
}
