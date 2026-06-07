
import { onlineSolver, PddlProblem } from '@unitn-asa/pddl-client';

const DELIVERY_DOMAIN = `(define (domain default)
    (:requirements :strips)
    (:predicates
        (at ?l)
        (parcel-at ?p ?l)
        (carrying ?p)
        (delivered ?p)
        (is-delivery ?l)
        (connected ?from ?to)
    )
    (:action move
        :parameters (?from ?to)
        :precondition (and (at ?from) (connected ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action pickup
        :parameters (?p ?l)
        :precondition (and (at ?l) (parcel-at ?p ?l))
        :effect (carrying ?p)
    )
    (:action deliver
        :parameters (?p ?l)
        :precondition (and (at ?l) (is-delivery ?l) (carrying ?p))
        :effect (and (delivered ?p) (not (carrying ?p)))
    )
)`;

export class PddlDeliveryPlanner {

    constructor(opts = {}) {
        this.timeoutMs  = opts.timeoutMs  || 8000;
        this.maxParcels = opts.maxParcels || 5;
        this._solver    = opts.solver     || onlineSolver;
        this._domain    = DELIVERY_DOMAIN;
    }

    _loc(x, y) { return `l_${Math.round(x)}_${Math.round(y)}`; }
    _pid(id)   { return `p_${String(id).replace(/[^a-z0-9]/gi, '')}`; }

    buildProblem(agent, parcels, deliveryZones) {
        const locs = new Map();
        const addLoc = (x, y) => { const n = this._loc(x, y); if (!locs.has(n)) locs.set(n, { x: Math.round(x), y: Math.round(y) }); return n; };

        const startLoc = addLoc(agent.x, agent.y);
        const pidToParcel = new Map();
        const init = [`(at ${startLoc})`];

        for (const p of parcels) {
            const l = addLoc(p.x, p.y);
            const pid = this._pid(p.id);
            pidToParcel.set(pid, p);
            init.push(`(parcel-at ${pid} ${l})`);
        }
        const deliveryLocs = [];
        for (const z of deliveryZones) {
            const l = addLoc(z.x, z.y);
            deliveryLocs.push(l);
            init.push(`(is-delivery ${l})`);
        }

        const locNames = [...locs.keys()];
        for (const a of locNames) for (const b of locNames) {
            if (a !== b) init.push(`(connected ${a} ${b})`);
        }

        const objects = [...locNames, ...pidToParcel.keys()].join(' ');
        const goal = 'and ' + [...pidToParcel.keys()].map(pid => `(delivered ${pid})`).join(' ');

        const problem = new PddlProblem('delivery', objects, init.join(' '), goal).toPddlString();
        return { problem, locs, pidToParcel, deliveryLocs };
    }

    async plan(agent, parcels, deliveryZones) {
        if (!agent || agent.x === undefined) return null;
        if (!parcels || parcels.length === 0) return null;
        if (!deliveryZones || deliveryZones.length === 0) return null;

        const selected = [...parcels]
            .sort((a, b) => (b.reward || 0) - (a.reward || 0))
            .slice(0, this.maxParcels);

        const { problem, locs, pidToParcel } = this.buildProblem(agent, selected, deliveryZones);

        let raw;
        try {
            raw = await Promise.race([
                this._solver(this._domain, problem),
                new Promise((_, rej) => setTimeout(
                    () => rej(new Error(`pddl task solver timeout (${this.timeoutMs}ms)`)), this.timeoutMs))
            ]);
        } catch (err) {
            console.log(`[pddl-task] ${err.message}`);
            return null;
        }
        if (!raw || raw.length === 0) return null;

        return this._toWaypoints(raw, locs, pidToParcel);
    }

    _toWaypoints(plan, locs, pidToParcel) {
        const out = [];
        for (const step of plan) {
            const action = String(step.action || '').toLowerCase();
            const args = step.args || step.parameters || [];
            if (action === 'pickup') {
                const pid = String(args[0] || '').toLowerCase();
                const p = pidToParcel.get(pid);
                if (p) out.push({ kind: 'pickup', parcelId: p.id, x: Math.round(p.x), y: Math.round(p.y) });
            } else if (action === 'deliver') {
                const loc = locs.get(String(args[1] || '').toLowerCase());
                if (loc) out.push({ kind: 'deliver', x: loc.x, y: loc.y });
            }
        }
        return out.length ? out : null;
    }
}
