import { manhattan, getClosest } from '../common/geometry.js';
import { BdiBeliefs, BLACKLIST_TTL_MS } from './BdiBeliefs.js';
import { PlanExecutor } from './PlanExecutor.js';
import { selectPlan } from './plans.js';
import { getBestParcel, getBestSpawnZone, getRandomExploreTarget, shouldDeliverNow, getBestDeliveryZone } from './Intentions.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// bdi loop: sense -> deliberate -> plan -> act
export class BdiAgent {

    constructor({ client, planner, pathfinder, fallbackPlanner = null, pddlPlanner = null, shouldYieldGoal = null }) {
        this.client     = client;
        this.beliefs    = new BdiBeliefs(client);
        this.planner    = planner || pathfinder;
        this.fallbackPlanner = fallbackPlanner;
        this.pddlPlanner = pddlPlanner;
        this._pddlBusy  = false;
        this.shouldYieldGoal = shouldYieldGoal;
        this.executor   = new PlanExecutor(client, this.beliefs);
        this._missionSeq = 0;
    }

    // L1 mission goal
    addMissionGoal(goal) {
        const id = `g${++this._missionSeq}`;
        this.beliefs.missionGoals.push({ id, ...goal });
        console.log(`[bdi] mission goal queued: ${id} ${goal.kind}(${goal.x},${goal.y}) reward=${goal.reward}`);
        return id;
    }

    // L2 rule
    applyRule(rule) {
        const c = this.beliefs.constraints;
        const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
        const ruleTiles = () => {
            const toTile = t => Array.isArray(t) ? { x: num(t[0]), y: num(t[1]) } : { x: num(t.x), y: num(t.y) };
            const list = Array.isArray(rule.tiles) ? rule.tiles.map(toTile) : [{ x: num(rule.x), y: num(rule.y) }];
            return list.filter(t => t.x !== null && t.y !== null);
        };
        const upsertTile = (list, x, y, fields) => {
            const e = list.find(t => t.x === x && t.y === y);
            if (e) Object.assign(e, fields); else list.push({ x, y, ...fields });
        };
        switch (rule.rule) {
            case 'avoid_tile': {
                const penalty = num(rule.penalty) ?? 50;
                for (const t of ruleTiles()) upsertTile(c.avoidTiles, t.x, t.y, { penalty });
                break;
            }
            case 'reward_filter': {
                const m = num(rule.maxReward);
                if (m != null) c.parcelRewardMax = (c.parcelRewardMax == null) ? m : Math.min(c.parcelRewardMax, m);
                break;
            }
            case 'delivery_zone_reward': {
                const multiplier = num(rule.multiplier) ?? 1;
                for (const t of ruleTiles()) upsertTile(c.deliveryZoneRewards, t.x, t.y, { multiplier });
                break;
            }
            case 'delivery_stack': {
                const n = num(rule.n);
                if (n && n > 0) {
                    const multiplier = num(rule.multiplier) ?? 1;
                    const existing = c.deliveryStacks.find(s => s.n === n);
                    if (existing) existing.multiplier = multiplier;
                    else c.deliveryStacks.push({ n, multiplier });
                }
                break;
            }
            default:
                console.log(`[bdi] unknown L2 rule: ${rule.rule}`);
                return false;
        }
        this.beliefs.currentPlan = null;
        console.log(`[bdi] L2 rule applied: ${JSON.stringify(this.beliefs.constraints)}`);
        return true;
    }

    // L3 coordination
    setCoordination(task, notify = null) {
        this.beliefs.coordination = { state: 'going', ...task };
        this._coordNotify = notify;
        this.beliefs.currentPlan = null;
        const where = task.x !== undefined ? ` near (${task.x},${task.y}) dist<=${task.dist}` : '';
        console.log(`[bdi] coordination set: ${task.type}${where}`);
    }

    clearCoordination() {
        if (!this.beliefs.coordination) return;
        console.log('[bdi] coordination cleared — resuming normal play');
        this.beliefs.coordination = null;
        this._coordNotify = null;
        this.beliefs.currentPlan = null;
    }

    async start() {
        console.log('[bdi] waiting for initial game state...');
        await this.client.ready();
        console.log('[bdi] initial data OK, starting agent loop');
        this._startMetricsTimer();
        this._loop();
    }

    _startMetricsTimer() {
        const timer = setInterval(() => {
            const m = this.beliefs.metrics;
            const score = this.client.state.me.score || 0;
            const uptime = ((Date.now() - m.startedAt) / 1000).toFixed(0);
            console.log(`[bdi-metrics] score=${score} pickups=${m.pickups} deliveries=${m.deliveries}`
                      + ` plans=${m.plansBuilt} racesLost=${m.racesLost} uptime=${uptime}s`);
        }, 30000);
        if (timer.unref) timer.unref();
    }

    async _loop() {
        let silentWait = 0;

        while (true) {
            try {
                const now = Date.now();
                this._markCheckedZones(now);
                this.beliefs.pruneStale(now);
                this.beliefs.pruneExpiredParcels(this.client.state, now);

                await this._opportunisticPickup();
                await this._opportunisticDelivery();

                const { target, intention } = this._deliberate();

                if (!target) {
                    if (silentWait++ % 20 === 0) console.log('[bdi] no target, waiting...');
                    await sleep(50);
                    continue;
                }

                const targetId = this._targetId(target, intention);
                const plan = this.beliefs.currentPlan;

                if (!plan || plan.targetId !== targetId || plan.steps.length === 0) {
                    const steps = await this._buildPlan(target, intention);

                    if (steps === null) {
                        this.beliefs.currentPlan = null;
                        const key = target.id || `${Math.round(target.x)},${Math.round(target.y)}`;
                        console.log(`[bdi] no path to ${intention} (${key}), blacklisting 15s`);
                        this.beliefs.blacklistedTargets.set(key, Date.now());
                        await sleep(500);
                        continue;
                    }

                    if (steps.length === 0) {
                        if (intention === 'mission') {
                            this._completeMission(target._mission);
                            continue;
                        }
                        if (intention === 'patrol' || intention === 'explore') {
                            console.log(`[bdi] reached ${intention} location, recalculating...`);
                            this.beliefs.currentPlan = null;
                            await sleep(100);
                            continue;
                        }
                        await sleep(500);
                        continue;
                    }

                    console.log(`[bdi] new plan for ${intention} (${steps.length} steps)`);
                    this.beliefs.currentPlan = { targetId, target, steps };
                    if (intention === 'mission') this.beliefs.currentPlan.mission = target._mission;
                    this.beliefs.metrics.plansBuilt++;
                    silentWait = 0;

                    this._refineWithPddl(target, intention, targetId);
                }

                const step = this.beliefs.currentPlan.steps[0];
                await this.executor.executeStep(step, target);

                const cp = this.beliefs.currentPlan;
                if (cp && cp.mission && cp.steps.length === 0) {
                    this._completeMission(cp.mission);
                }

            } catch (err) {
                console.log(`[bdi] loop error: ${err.message}, retrying...`);
                await sleep(1000);
            }
        }
    }

    // deliberation + intention revision
    _deliberate() {
        const st = this.client.state;
        const carrying = st.carrying;

        if (this.beliefs.coordination) return this._coordinationDeliberate();

        let target = null;
        let intention = null;

        const plan = this.beliefs.currentPlan;
        if (plan && plan.steps.length > 0) {
            const tId = plan.targetId;
            if (tId === 'delivery') {
                target = getBestDeliveryZone(st, this.beliefs);
                intention = 'deliver';
            } else if (tId === 'patrol' || tId === 'explore') {
                target = plan.target;
                intention = tId;
            } else if (tId.startsWith('mission_')) {
                const g = this.beliefs.missionGoals.find(m => `mission_${m.id}` === tId);
                if (g) { target = { x: g.x, y: g.y, _mission: g }; intention = 'mission'; }
                else   { this.beliefs.currentPlan = null; }
            } else if (tId.startsWith('p')) {
                const p = st.parcels.get(tId);
                if (p && !p.carriedBy) {
                    target = p;
                    intention = 'pickup';
                } else {
                    this.beliefs.currentPlan = null;
                }
            }
        }

        const best = getBestParcel(st, this.beliefs);
        let invalidate = false;

        if (best) {
            if (intention === 'explore' || intention === 'patrol' || intention === null) {
                invalidate = true;
            } else if (this.beliefs.currentPlan && intention === 'pickup' && target) {
                const planned = st.parcels.get(target.id);
                if (!planned || (planned.carriedBy && planned.carriedBy !== st.me.id)) {
                    invalidate = true;
                } else if (best.id !== target.id && this._betterParcel(planned, best)) {
                    invalidate = true;
                } else if (best.id !== target.id && this.beliefs.isRaceLost(st, planned)) {
                    // race lost
                    this.beliefs.blacklistedTargets.set(planned.id, Date.now());
                    this.beliefs.metrics.racesLost++;
                    invalidate = true;
                }
            } else if (this.beliefs.currentPlan && intention === 'deliver'
                       && carrying.length < st.config.capacity
                       && this._worthDivertingForPickup(best)
                       && !shouldDeliverNow(st, this.beliefs, best)) {
                // detour pickup
                invalidate = true;
            }
        } else if (intention === 'pickup' && (!target || st.parcels.get(target.id)?.carriedBy)) {
            invalidate = true;
        }

        if (invalidate) {
            this.beliefs.currentPlan = null;
            target = null;
            intention = null;
        }

        if (!target) {
            const closestDelivery = getBestDeliveryZone(st, this.beliefs);

            const mg = this._bestMissionGoal();
            const missionWins = mg && mg.rate >= (best ? this._parcelRate(best) : 0);

            if (carrying.length > 0 && !missionWins && shouldDeliverNow(st, this.beliefs, best)) {
                target = closestDelivery;
                intention = 'deliver';
            } else if (missionWins) {
                target = { x: mg.goal.x, y: mg.goal.y, _mission: mg.goal };
                intention = 'mission';
            } else if (best) {
                target = best;
                intention = 'pickup';
            } else {
                target = getBestSpawnZone(st, this.beliefs);
                intention = 'patrol';
                if (!target) {
                    target = getRandomExploreTarget(st);
                    intention = 'explore';
                }
                if (!target && st.spawnZones.length > 0) {
                    target = getClosest(st.me, st.spawnZones);
                    intention = 'patrol';
                }
            }
        }

        return { target, intention };
    }

    // L3 deliberation
    _coordinationDeliberate() {
        const st = this.client.state;
        const c = this.beliefs.coordination;

        if (c.type === 'hold') {
            this._coordReach('holding');
            return { target: null, intention: 'coord-hold' };
        }

        if (c.type === 'relay') return this._relayDeliberate();

        if (c.type === 'red_light' && c.x === undefined) {
            const t = this._nearestRowTile(c.parity);
            if (!t) { this._coordReach('holding'); return { target: null, intention: 'coord-hold' }; }
            c.x = t.x; c.y = t.y; c.dist = 0;
        }

        const d = manhattan(st.me, { x: c.x, y: c.y });
        const within = Number.isFinite(c.dist) ? c.dist : 0;
        if (d <= within) {
            this._coordReach('ready');
            return { target: null, intention: 'coord-wait' };
        }
        c.state = 'going';
        return { target: { x: c.x, y: c.y }, intention: 'coord' };
    }

    // relay roles
    _relayDeliberate() {
        const st = this.client.state;
        const c = this.beliefs.coordination;
        const handoff = c.handoff;
        const cap = st.config.capacity || Infinity;

        if (c.role === 'collector') {
            const carrying = st.carrying.length;
            const best = getBestParcel(st, this.beliefs, { excludeTile: handoff });
            if (carrying > 0 && (carrying >= cap || !best)) {
                return { target: { x: handoff.x, y: handoff.y }, intention: 'relay_drop' };
            }
            if (best) return { target: best, intention: 'pickup' };
            const zone = getBestSpawnZone(st, this.beliefs);
            if (zone) return { target: zone, intention: 'patrol' };
            const ex = getRandomExploreTarget(st);
            if (ex) return { target: ex, intention: 'explore' };
            return { target: null, intention: 'coord-wait' };
        }

        // deliverer
        if (st.carrying.length > 0) {
            return { target: getBestDeliveryZone(st, this.beliefs), intention: 'deliver' };
        }
        const here = st.freeParcels
            .filter(p => Math.round(p.x) === handoff.x && Math.round(p.y) === handoff.y);
        if (here.length) return { target: getClosest(st.me, here), intention: 'pickup' };
        const wait = this._relayWaitTile(handoff);
        if (manhattan(st.me, wait) > 0) return { target: wait, intention: 'coord' };
        return { target: null, intention: 'coord-wait' };
    }

    _nearestRowTile(parity) {
        const st = this.client.state;
        const want = parity === 'even' ? 0 : 1;
        let best = null, bestD = Infinity;
        for (const [key, type] of st.map.entries()) {
            if (String(type) === '0') continue;
            const [x, y] = key.split(',').map(Number);
            if (((y % 2) + 2) % 2 !== want) continue;
            const d = manhattan(st.me, { x, y });
            if (d < bestD) { bestD = d; best = { x, y }; }
        }
        return best;
    }

    _relayWaitTile(handoff) {
        const st = this.client.state;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const x = handoff.x + dx, y = handoff.y + dy;
            const t = st.map.get(`${x},${y}`);
            if (t !== undefined && String(t) !== '0') return { x, y };
        }
        return { x: handoff.x, y: handoff.y };
    }

    _coordReach(state) {
        const c = this.beliefs.coordination;
        if (!c || c.state === state) return;
        c.state = state;
        this.beliefs.currentPlan = null;
        console.log(`[bdi] coordination: ${state} (${c.type})`);
        if (this._coordNotify) { try { this._coordNotify(state, c); } catch {} }
    }

    // soft commitment
    _betterParcel(planned, candidate) {
        const st = this.client.state;
        const closeRange = Math.max(2, Math.floor(st.config.vision * 0.4));
        const midRange = st.config.vision;

        let dCur = manhattan(st.me, planned);
        if (dCur === 0) dCur = 0.1;
        const delCur = getClosest(planned, st.deliveryZones);
        const sCur = planned.reward / (dCur + manhattan(planned, delCur));

        let dCan = manhattan(st.me, candidate);
        if (dCan === 0) dCan = 0.1;
        const delCan = getClosest(candidate, st.deliveryZones);
        const sCan = candidate.reward / (dCan + manhattan(candidate, delCan));

        let multiplier = 1.3;
        if (dCur <= closeRange) multiplier = 2.5;
        else if (dCur <= midRange) multiplier = 1.6;

        return sCan > sCur * multiplier;
    }

    // detour evaluation
    _worthDivertingForPickup(parcel) {
        if (!parcel || (parcel.reward || 0) <= 0) return false;
        const st = this.client.state;
        const del = getClosest(st.me, st.deliveryZones);
        if (!del) return false;

        const direct    = manhattan(st.me, del);
        const viaParcel = manhattan(st.me, parcel)
                        + manhattan(parcel, getClosest(parcel, st.deliveryZones));
        const detour = viaParcel - direct;

        if (detour <= 0) return true;
        const tolerance = Math.max(2, Math.floor(st.config.vision * 0.6));
        return detour <= tolerance && (parcel.reward || 0) >= detour;
    }

    _targetId(target, intention) {
        if (intention === 'pickup')  return target.id;
        if (intention === 'deliver') return 'delivery';
        if (intention === 'mission') return `mission_${target._mission.id}`;
        if (intention === 'coord')   return 'coord';
        if (intention === 'relay_drop') return 'relay_drop';
        return intention;
    }

    _parcelRate(parcel) {
        const st = this.client.state;
        const d = Math.max(manhattan(st.me, parcel), 1);
        const del = getClosest(parcel, st.deliveryZones);
        const reward = this.beliefs.expectedRewardAt
            ? this.beliefs.expectedRewardAt(parcel, d, st)
            : (parcel.reward || 0);
        return reward / (d + (del ? manhattan(parcel, del) : 0) || 1);
    }

    // mission goal vs parcels
    _bestMissionGoal() {
        const st = this.client.state;
        const now = Date.now();
        let best = null, bestRate = -Infinity;
        for (const g of this.beliefs.missionGoals) {
            if ((g.reward || 0) <= 0) continue;                             // trap
            if (g.kind === 'drop_at' && st.carrying.length === 0) continue;
            if (this.shouldYieldGoal && this.shouldYieldGoal(g)) continue;  // closest commits
            const bl = this.beliefs.blacklistedTargets.get(`${g.x},${g.y}`);
            if (bl && now - bl < BLACKLIST_TTL_MS) continue;                // blacklisted
            const rate = (g.reward || 0) / Math.max(manhattan(st.me, g), 1);
            if (rate > bestRate) { bestRate = rate; best = g; }
        }
        return best ? { goal: best, rate: bestRate } : null;
    }

    _completeMission(goal) {
        this.beliefs.missionGoals = this.beliefs.missionGoals.filter(g => g.id !== goal.id);
        this.beliefs.currentPlan = null;
        console.log(`[bdi] mission goal done: ${goal.summary || goal.kind} at (${goal.x},${goal.y})`);
        if (goal.fromId) {
            this.client.say(goal.fromId, `done: ${goal.summary || goal.kind}`).catch(() => {});
        }
    }

    // means-end
    async _buildPlan(target, intention) {
        if (intention === 'mission') {
            const steps = await this._navigate(this.client.state.me, target);
            if (steps === null) return null;
            const kind = target._mission.kind;
            if (kind === 'drop_at')   steps.push('put_down');
            if (kind === 'pickup_at') steps.push('pick_up');
            return steps;
        }
        if (intention === 'coord') {
            return await this._navigate(this.client.state.me, target);
        }
        if (intention === 'relay_drop') {
            const steps = await this._navigate(this.client.state.me, target);
            if (steps === null) return null;
            steps.push('relay_drop');
            return steps;
        }
        const plan = selectPlan(intention);
        if (!plan) return null;
        return plan.build((from, to) => this._navigate(from, to), this.client.state.me, target);
    }

    // navigation
    async _navigate(from, target) {
        const opts = this._plannerOpts();
        let steps = await this.planner.findPath(from, target, opts);
        if (steps === null && this.fallbackPlanner) {
            steps = await this.fallbackPlanner.findPath(from, target, opts);
            if (steps !== null) console.log('[bdi] primary planner failed, used fallback (A*)');
        }
        return steps;
    }

    _plannerOpts() {
        return {
            obstacles: this.beliefs.obstacles,
            agents:    this.client.state.agents,
            crates:    this.client.state.crates,
            softCosts: this.beliefs.buildEnemyCostMap(this.client.state)
        };
    }

    // pddl background refine
    _refineWithPddl(target, intention, targetId) {
        if (!this.pddlPlanner || this._pddlBusy) return;
        const st = this.client.state;
        const start = { x: Math.round(st.me.x), y: Math.round(st.me.y) };
        if (start.x === Math.round(target.x) && start.y === Math.round(target.y)) return;

        this._pddlBusy = true;
        Promise.resolve(this.pddlPlanner.findPath(start, target, this._plannerOpts()))
            .then(pddlSteps => {
                if (!pddlSteps || pddlSteps.length === 0) return;
                const cp = this.beliefs.currentPlan;
                if (!cp || cp.targetId !== targetId) return;
                if (Math.round(this.client.state.me.x) !== start.x
                 || Math.round(this.client.state.me.y) !== start.y) return;
                const last = cp.steps[cp.steps.length - 1];
                const terminal = (last === 'pick_up' || last === 'put_down' || last === 'relay_drop') ? [last] : [];
                cp.steps = [...pddlSteps, ...terminal];
                console.log(`[bdi] PDDL refined ${intention} plan (${pddlSteps.length} moves)`);
            })
            .catch(() => {})
            .finally(() => { this._pddlBusy = false; });
    }

    // opportunistic pickup
    async _opportunisticPickup() {
        const st = this.client.state;
        if (st.me.x === undefined) return false;
        if (st.carrying.length >= (st.config.capacity || Infinity)) return false;

        const mx = Math.round(st.me.x);
        const my = Math.round(st.me.y);
        const co = this.beliefs.coordination;
        if (co && co.type === 'relay' && co.role === 'collector'
            && co.handoff && co.handoff.x === mx && co.handoff.y === my) return false;
        const maxR = this.beliefs.constraints.parcelRewardMax;
        const canDecay = (this.beliefs.decayPerMs || 0) > 0;
        const here = st.freeParcels.filter(p =>
            Math.round(p.x) === mx && Math.round(p.y) === my &&
            !(maxR != null && (p.reward || 0) > maxR && !canDecay));
        if (here.length === 0) return false;

        const picked = await this.client.pickup();
        if (!picked || !picked.length) return false;

        for (const p of here) p.carriedBy = st.me.id;
        this.beliefs.metrics.pickups += here.length;
        this.beliefs.lastPickupAt = Date.now();
        console.log(`[bdi] opportunistic pickup at (${mx},${my}): ${here.map(p => p.id).join(', ')}`);

        if (st.carrying.length >= (st.config.capacity || Infinity)) {
            this.beliefs.currentPlan = null;
        }
        return true;
    }

    _opportunisticDeliveryOk(mx, my) {
        const zr = this.beliefs.constraints.deliveryZoneRewards.find(e => e.x === mx && e.y === my);
        return !(zr && zr.multiplier <= 0);
    }

    // opportunistic delivery
    async _opportunisticDelivery() {
        const st = this.client.state;
        if (st.me.x === undefined) return false;
        if (st.carrying.length === 0) return false;
        const co = this.beliefs.coordination;
        if (co && co.type === 'relay' && co.role === 'collector') return false;

        const mx = Math.round(st.me.x);
        const my = Math.round(st.me.y);
        const onDelivery = st.deliveryZones.some(z => z.x === mx && z.y === my);
        if (!onDelivery) return false;
        if (!this._opportunisticDeliveryOk(mx, my)) return false;

        let deliveredAny = false;
        for (let guard = 0; guard < 12 && st.carrying.length > 0; guard++) {
            const ids = this.beliefs.deliverySet(st);
            if (ids && ids.length === 0) break;
            const dropped = await this.client.putdown(ids || undefined);
            const n = this._applyDropped(ids, dropped, mx, my);
            if (n === 0) break;
            deliveredAny = true;
            if (ids === null) break;
        }

        if (deliveredAny && this.beliefs.currentPlan && this.beliefs.currentPlan.targetId === 'delivery') {
            this.beliefs.currentPlan = null;
        }
        return deliveredAny;
    }

    _applyDropped(requestedIds, dropped, mx, my) {
        const st = this.client.state;
        const droppedIds = (Array.isArray(dropped) && dropped.length && dropped[0] && dropped[0].id !== undefined)
            ? new Set(dropped.map(p => p.id))
            : (requestedIds ? new Set(requestedIds) : null);

        let count = 0;
        for (const [id, p] of st.parcels) {
            if (p.carriedBy !== st.me.id) continue;
            if (droppedIds && !droppedIds.has(id)) continue;
            st.parcels.delete(id);
            count++;
        }
        this.beliefs.metrics.deliveries += count;
        const req = requestedIds ? requestedIds.length : 'all';
        console.log(`[bdi] delivery at (${mx},${my}): requested ${req}, server dropped ${count}`);
        return count;
    }

    // spawn zone freshness
    _markCheckedZones(now) {
        const st = this.client.state;
        for (const z of st.spawnZones) {
            if (manhattan(st.me, z) <= st.config.vision) {
                this.beliefs.lastChecked.set(`${z.x},${z.y}`, now);
            }
        }
    }
}
