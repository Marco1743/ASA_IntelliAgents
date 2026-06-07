
import { Pathfinder } from '../common/Pathfinder.js';
import { manhattan, getClosest } from '../common/geometry.js';
import { BdiBeliefs } from './BdiBeliefs.js';
import { PlanExecutor } from './PlanExecutor.js';
import { getBestParcel, getBestSpawnZone, getRandomExploreTarget, shouldDeliverNow, getBestDeliveryZone, getBestBonusTile } from './Intentions.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class BdiAgent {

    constructor({ client, asa, planner = null, taskPlanner = null }) {
        this.client     = client;
        this.asa        = asa;
        this.beliefs    = new BdiBeliefs(client);
        this.pathfinder = planner || new Pathfinder(client.state.map);
        this.executor   = new PlanExecutor(client, this.beliefs);

        this.taskPlanner = taskPlanner;
        this._taskQueue  = [];

        this._wireAsa();
        this._startMetricsTimer();
    }

    async start() {
        console.log('[bdi] waiting for game state...');
        await this.client.ready();
        console.log('[bdi] starting agent loop');
        this._loop();
    }

    async _loop() {
        let silentWait = 0;

        while (true) {
            try {
                this.beliefs.pruneStale();
                this._markCheckedZones();

                if (this.taskPlanner) await this._refreshTaskPlan();

                const { target, intention } = this._deliberate();

                if (!target) {
                    if (silentWait++ % 20 === 0) console.log('[bdi] idle, no target');
                    await sleep(50);
                    continue;
                }

                const targetId = this._targetId(target, intention);
                if (!this.beliefs.currentPlan
                    || this.beliefs.currentPlan.targetId !== targetId
                    || this.beliefs.currentPlan.steps.length === 0) {

                    const plan = await this._buildPlan(target, intention);
                    if (!plan) {
                        const k = target.id || `${Math.round(target.x)},${Math.round(target.y)}`;
                        const ft = this.beliefs.constraints.forcedTarget;
                        if (ft && Math.round(target.x) === ft.x && Math.round(target.y) === ft.y) {
                            console.log(`[bdi] L3 forced target (${ft.x},${ft.y}) UNREACHABLE — parking`);
                            ft.unreachable = true;
                            this.beliefs.currentPlan = null;
                            await sleep(500);
                            continue;
                        }
                        console.log(`[bdi] no path to ${intention}/${k}, blacklist 15s`);
                        this.beliefs.blacklistedTargets.set(k, Date.now());
                        await sleep(500);
                        continue;
                    }
                    if (plan.length === 0) {
                        if (intention === 'patrol' || intention === 'explore') {
                            this.beliefs.currentPlan = null;
                            await sleep(100);
                            continue;
                        }
                        await sleep(500);
                        continue;
                    }
                    this.beliefs.currentPlan = { targetId, target, steps: plan };
                    this.beliefs.metrics.plansBuilt++;
                    console.log(`[bdi] new plan for ${intention} (${plan.length} steps)`);
                    silentWait = 0;
                }

                const step = this.beliefs.currentPlan.steps[0];
                await this.executor.executeStep(step, target);

            } catch (err) {
                console.log(`[bdi] loop error: ${err.message}`);
                await sleep(1000);
            }
        }
    }

    _deliberate() {
        const st = this.client.state;
        const carrying = st.carrying;
        const cs = this.beliefs.constraints;

        if (cs.pauseUntilResume) {
            this.beliefs.currentPlan = null;
            return { target: null, intention: null };
        }
        if (cs.forcedTarget) {
            const ft = cs.forcedTarget;
            const me = st.me;
            const dist = manhattan(me, ft);
            const reachedOrFailed = ft.reachedAt || ft.unreachable;
            if (dist <= (ft.tolerance || 0) || reachedOrFailed) {
                if (!ft.reachedAt && !ft.unreachable) {
                    ft.reachedAt = Date.now();
                    console.log(`[bdi] L3 forced target (${ft.x},${ft.y}) reached`);
                }
                if (ft.thenPickup && !ft.unreachable) {
                    const here = [...st.freeParcels].find(p =>
                        manhattan(p, ft) <= (ft.tolerance || 0)
                    );
                    if (here) return { target: here, intention: 'pickup' };
                }
                this.beliefs.currentPlan = null;
                return { target: null, intention: null };
            }
            return { target: { x: ft.x, y: ft.y }, intention: 'explore' };
        }

        const bonusTiles = cs.tileBonuses;
        if (bonusTiles && bonusTiles.length) {
            const mx = Math.round(st.me.x), my = Math.round(st.me.y);
            const remaining = bonusTiles.filter(b => !(b.x === mx && b.y === my));
            if (remaining.length !== bonusTiles.length) {
                console.log(`[bdi] L1 bonus tile (${mx},${my}) reached — collected, removing from beliefs`);
                cs.tileBonuses = remaining;
                if (this.beliefs.currentPlan?.targetId === `bonus_${mx}_${my}`) this.beliefs.currentPlan = null;
            }
        }

        let target = null, intention = null;
        const plan = this.beliefs.currentPlan;
        if (plan && plan.steps.length > 0) {
            const tId = plan.targetId;
            if (tId === 'delivery') {
                target = getBestDeliveryZone(st, this.beliefs); intention = 'deliver';
            } else if (tId === 'patrol' || tId === 'explore' || tId.startsWith('bonus')) {
                target = plan.target; intention = tId.startsWith('bonus') ? 'bonus' : tId;
            } else if (tId.startsWith('p')) {
                const p = st.parcels.get(tId);
                if (p && !p.carriedBy) { target = p; intention = 'pickup'; }
                else                   { this.beliefs.currentPlan = null; }
            }
        }

        let best = getBestParcel(st, this.beliefs);

        if (this.taskPlanner && this._taskQueue.length > 0) {
            const head = this._taskQueue[0];
            const p = st.parcels.get(head.parcelId);
            if (p && !p.carriedBy && !this.beliefs.teamClaims.has(p.id)) best = p;
            else this._taskQueue.shift();
        }
        if (best) {
            if (intention === 'explore' || intention === 'patrol' || intention === null) {
                this.beliefs.currentPlan = null;
                target = null; intention = null;
            } else if (intention === 'pickup' && target) {
                const planned = st.parcels.get(target.id);
                if (!planned || (planned.carriedBy && planned.carriedBy !== st.me.id)) {
                    this.beliefs.currentPlan = null;
                    target = null; intention = null;
                } else if (this.beliefs.isRaceLost(planned) && best.id !== planned.id) {
                    this.beliefs.blacklistedTargets.set(planned.id, Date.now());
                    this.beliefs.currentPlan = null;
                    target = null; intention = null;
                } else if (best.id !== target.id) {
                    if (this._betterParcel(planned, best)) {
                        this.beliefs.currentPlan = null;
                        target = null; intention = null;
                    }
                }
            }
        } else if (intention === 'pickup' && (!target || st.parcels.get(target.id)?.carriedBy)) {
            this.beliefs.currentPlan = null;
            target = null; intention = null;
        }

        if (!target) {
            const closestDel = getBestDeliveryZone(st, this.beliefs);
            const bonusOpp = getBestBonusTile(st, this.beliefs);
            const bestRate = best
                ? (best.reward || 0) / Math.max(manhattan(st.me, best)
                    + manhattan(best, getClosest(best, st.deliveryZones)), 0.1)
                : 0;
            if (carrying.length > 0 && shouldDeliverNow(st, this.beliefs, best)) {
                target = closestDel; intention = 'deliver';
            } else if (bonusOpp && bonusOpp.rate >= bestRate) {
                target = bonusOpp.tile; intention = 'bonus';
            } else if (best) {
                target = best; intention = 'pickup';
            } else if (carrying.length > 0) {
                target = closestDel; intention = 'deliver';
            } else if (st.spawnZones.length > 0) {
                target = getBestSpawnZone(st, this.beliefs); intention = 'patrol';
            } else {
                target = getRandomExploreTarget(st); intention = 'explore';
            }
        }
        return { target, intention };
    }

    _betterParcel(current, candidate) {
        const st = this.client.state;
        const closeRange = Math.max(2, Math.floor(st.config.vision * 0.4));
        const midRange = st.config.vision;
        const closestDelCurrent  = getClosest(current, st.deliveryZones);
        const closestDelCandid   = getClosest(candidate, st.deliveryZones);

        const dCur = manhattan(st.me, current) || 0.1;
        const sCur = current.reward / (dCur + manhattan(current, closestDelCurrent));
        const dCan = manhattan(st.me, candidate) || 0.1;
        const sCan = candidate.reward / (dCan + manhattan(candidate, closestDelCandid));

        let mul = 1.3;
        if (dCur <= closeRange) mul = 2.5;
        else if (dCur <= midRange) mul = 1.6;

        return sCan > sCur * mul;
    }

    _targetId(target, intention) {
        if (intention === 'pickup')  return target.id;
        if (intention === 'deliver') return 'delivery';
        if (intention === 'bonus')   return `bonus_${target.x}_${target.y}`;
        return intention;
    }

    async _refreshTaskPlan() {
        const st = this.client.state;

        this._taskQueue = this._taskQueue.filter(w => {
            const p = st.parcels.get(w.parcelId);
            return p && !p.carriedBy;
        });
        if (this._taskQueue.length > 0) return;

        const free = st.freeParcels || [];
        const capacity = st.config.capacity || Infinity;
        if (free.length < 2 || st.carrying.length >= capacity) return;

        const waypoints = await this.taskPlanner.plan(st.me, free, st.deliveryZones);
        if (waypoints && waypoints.length) {
            this._taskQueue = waypoints.filter(w => w.kind === 'pickup');
            if (this._taskQueue.length) {
                console.log(`[bdi] PDDL task order: ${this._taskQueue.map(w => `(${w.x},${w.y})`).join(' → ')}`);
            }
        }
    }

    async _buildPlan(target, intention) {
        const softCosts = this.beliefs.buildEnemyCostMap();
        let path = await this.pathfinder.findPath(this.client.state.me, target, {
            softCosts,
            blocked:   this.beliefs.blockedTiles,
            obstacles: this.beliefs.obstacles
        });
        if (path === null) {
            path = await this.pathfinder.findPath(this.client.state.me, target, {
                blocked:   this.beliefs.blockedTiles,
                obstacles: this.beliefs.obstacles
            });
            if (path !== null) console.log('[bdi] soft-cost search failed, fell back to hard');
        }
        if (path === null) return null;
        if (intention === 'pickup')  path.push('pick_up');
        if (intention === 'deliver') path.push('put_down');
        return path;
    }

    _startMetricsTimer() {
        setInterval(() => {
            const m = this.beliefs.metrics;
            m.scoreSnapshot = this.client.state.me.score || 0;
            const uptimeS = ((Date.now() - m.startedAt) / 1000).toFixed(0);
            console.log(`[bdi-metrics] score=${m.scoreSnapshot} pickups=${m.pickups} deliveries=${m.deliveries} plans=${m.plansBuilt} claims_honored=${m.claimsHonored} blocked=${m.blockedTilesAdded} decay/s=${(this.beliefs.decayPerMs*1000).toFixed(3)} uptime=${uptimeS}s`);
        }, 30000);
    }

    _markCheckedZones() {
        const now = Date.now();
        const st = this.client.state;
        for (const z of st.spawnZones) {
            if (manhattan(st.me, z) <= st.config.vision) {
                this.beliefs.lastChecked.set(`${z.x},${z.y}`, now);
            }
        }
    }

    _wireAsa() {
        this.asa.on('message', (parsed, replyAck) => this._onAsaMessage(parsed, replyAck));
    }

    _onAsaMessage(parsed, replyAck) {
        this.beliefs.teamMessages.push({ at: Date.now(), ...parsed });
        if (this.beliefs.teamMessages.length > 30) this.beliefs.teamMessages.shift();

        switch (parsed.type) {
            case 'CLAIM':
                if (parsed.data?.parcel_id && parsed.fromId !== this.client.state.me.id) {
                    this.beliefs.teamClaims.set(parsed.data.parcel_id,
                        { byId: parsed.fromId, at: Date.now() });
                    this.beliefs.blacklistedTargets.set(parsed.data.parcel_id, Date.now());
                    this.beliefs.metrics.claimsHonored++;
                    if (this.beliefs.currentPlan
                        && this.beliefs.currentPlan.targetId === parsed.data.parcel_id) {
                        console.log(`[bdi] yielding parcel ${parsed.data.parcel_id} to ${parsed.fromName}`);
                        this.beliefs.currentPlan = null;
                    }
                }
                break;
            case 'RELEASE':
                if (parsed.data?.parcel_id) {
                    this.beliefs.teamClaims.delete(parsed.data.parcel_id);
                    this.beliefs.blacklistedTargets.delete(parsed.data.parcel_id);
                }
                break;
            case 'BELIEF':
                if (parsed.data?.kind === 'parcel' && parsed.data.id
                    && !this.client.state.parcels.has(parsed.data.id)) {
                    const d = parsed.data;
                    this.client.state.parcels.set(d.id, {
                        id: d.id, x: d.x, y: d.y, reward: d.reward, carriedBy: d.carriedBy
                    });
                }
                break;
            case 'REQUEST':
                this._handleRequest(parsed);
                break;
            case 'QUERY': {
                const answer = this._answer(parsed);
                const reply = JSON.stringify({ asa: true, type: 'ANSWER',
                    qid: parsed.qid, data: answer });
                if (typeof replyAck === 'function') {
                    replyAck(reply);
                } else if (parsed.qid && parsed.fromId) {
                    this.client.say(parsed.fromId, reply);
                }
                break;
            }
        }
    }
    _handleRequest(parsed) {
        const intent = parsed.data?.intent || parsed.data?.kind;
        const d = parsed.data || {};

        switch (intent) {
            case 'avoid_zone': {
                if (d.x !== undefined && d.y !== undefined) {
                    const r = d.radius || 0;
                    for (let dx = -r; dx <= r; dx++) {
                        for (let dy = -r; dy <= r; dy++) {
                            if (Math.abs(dx) + Math.abs(dy) <= r) {
                                this.beliefs.blockedTiles.set(
                                    `${Math.round(d.x)+dx},${Math.round(d.y)+dy}`,
                                    Date.now()
                                );
                                this.beliefs.metrics.blockedTilesAdded++;
                            }
                        }
                    }
                    console.log(`[bdi] honoring avoid_zone at (${d.x},${d.y})`);
                    this.beliefs.currentPlan = null;
                }
                break;
            }
            case 'focus_parcel':
            case 'pickup': {
                if (d.parcel_id) {
                    this.beliefs.blacklistedTargets.delete(d.parcel_id);
                    console.log(`[bdi] focus request on parcel ${d.parcel_id}`);
                }
                break;
            }
            case 'drop_target': {
                if (d.parcel_id && this.beliefs.currentPlan?.targetId === d.parcel_id) {
                    this.beliefs.currentPlan = null;
                    this.beliefs.blacklistedTargets.set(d.parcel_id, Date.now());
                    console.log(`[bdi] dropping target ${d.parcel_id} on request`);
                }
                break;
            }

            case 'set_delivery_threshold': {
                this.beliefs.constraints.deliveryThreshold = Number.isFinite(d.n) ? d.n : null;
                console.log(`[bdi] L2 constraint: deliveryThreshold = ${this.beliefs.constraints.deliveryThreshold}`);
                this.beliefs.currentPlan = null;
                break;
            }
            case 'set_delivery_bonus': {
                const nn  = Number.isFinite(d.n) ? d.n : null;
                const mul = Number.isFinite(d.multiplier) ? d.multiplier : 2;
                this.beliefs.constraints.deliveryBonus = nn ? { n: nn, multiplier: mul } : null;
                this.beliefs.constraints.deliveryThreshold = null;
                console.log(`[bdi] L2 constraint: deliveryBonus = ${JSON.stringify(this.beliefs.constraints.deliveryBonus)}`);
                this.beliefs.currentPlan = null;
                break;
            }
            case 'set_preferred_delivery': {
                this.beliefs.constraints.preferredDeliveryTiles =
                    mergeTiles(this.beliefs.constraints.preferredDeliveryTiles, d.tiles);
                console.log(`[bdi] L2 constraint: preferredDeliveryTiles = ${JSON.stringify(this.beliefs.constraints.preferredDeliveryTiles)}`);
                this.beliefs.currentPlan = null;
                break;
            }
            case 'set_forbidden_delivery': {
                this.beliefs.constraints.forbiddenDeliveryTiles =
                    mergeTiles(this.beliefs.constraints.forbiddenDeliveryTiles, d.tiles);
                console.log(`[bdi] L2 constraint: forbiddenDeliveryTiles = ${JSON.stringify(this.beliefs.constraints.forbiddenDeliveryTiles)}`);
                this.beliefs.currentPlan = null;
                break;
            }
            case 'add_tile_penalty': {
                if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
                    const list = this.beliefs.constraints.tilePenalties;
                    const i = list.findIndex(t => t.x === d.x && t.y === d.y);
                    const entry = { x: d.x, y: d.y, points: Number.isFinite(d.points) ? d.points : 0 };
                    if (i >= 0) list[i] = entry; else list.push(entry);
                    this.beliefs.constraints.tileBonuses =
                        this.beliefs.constraints.tileBonuses.filter(t => t.x !== d.x || t.y !== d.y);
                    console.log(`[bdi] L1 standing rule: avoid tile (${d.x},${d.y}) -${entry.points}pts`);
                    this.beliefs.currentPlan = null;
                }
                break;
            }
            case 'add_tile_bonus': {
                if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
                    const list = this.beliefs.constraints.tileBonuses;
                    const i = list.findIndex(t => t.x === d.x && t.y === d.y);
                    const entry = { x: d.x, y: d.y, points: Number.isFinite(d.points) ? d.points : 0 };
                    if (i >= 0) list[i] = entry; else list.push(entry);
                    this.beliefs.constraints.tilePenalties =
                        this.beliefs.constraints.tilePenalties.filter(t => t.x !== d.x || t.y !== d.y);
                    console.log(`[bdi] L1 standing rule: bonus tile (${d.x},${d.y}) +${entry.points}pts`);
                    this.beliefs.currentPlan = null;
                }
                break;
            }
            case 'set_parcel_filter': {
                this.beliefs.constraints.parcelRewardMax = Number.isFinite(d.max_reward) ? d.max_reward : null;
                console.log(`[bdi] L2 constraint: parcelRewardMax = ${this.beliefs.constraints.parcelRewardMax}`);
                break;
            }
            case 'clear_constraints': {
                this.beliefs.constraints = {
                    deliveryThreshold: null,
                    deliveryBonus: null,
                    preferredDeliveryTiles: [],
                    forbiddenDeliveryTiles: [],
                    parcelRewardMax: null,
                    tilePenalties: [],
                    tileBonuses: [],
                    forcedTarget: null,
                    pauseUntilResume: false
                };
                console.log('[bdi] all constraints cleared (L2 + L3)');
                this.beliefs.currentPlan = null;
                break;
            }

            case 'goto_and_wait': {
                if (d.x !== undefined && d.y !== undefined) {
                    this.beliefs.constraints.forcedTarget = {
                        x: Math.round(d.x), y: Math.round(d.y),
                        tolerance: Number.isFinite(d.tolerance) ? d.tolerance : 0,
                        reachedAt: null,
                        thenPickup: false
                    };
                    this.beliefs.constraints.pauseUntilResume = false;
                    this.beliefs.currentPlan = null;
                    console.log(`[bdi] L3 goto_and_wait → (${d.x},${d.y}) tol=${d.tolerance||0}`);
                }
                break;
            }
            case 'pickup_at': {
                if (d.x !== undefined && d.y !== undefined) {
                    this.beliefs.constraints.forcedTarget = {
                        x: Math.round(d.x), y: Math.round(d.y),
                        tolerance: Number.isFinite(d.tolerance) ? d.tolerance : 0,
                        reachedAt: null,
                        thenPickup: true
                    };
                    this.beliefs.constraints.pauseUntilResume = false;
                    this.beliefs.currentPlan = null;
                    console.log(`[bdi] L3 pickup_at → (${d.x},${d.y}) tol=${d.tolerance||0}`);
                }
                break;
            }
            case 'goto_parity_row_and_wait':
            case 'goto_parity_col_and_wait': {
                const axis     = intent === 'goto_parity_col_and_wait' ? 'col' : 'row';
                const parity   = d.parity === 'even' ? 0 : 1;
                const me       = this.client.state.me;
                const myX      = Math.round(me.x), myY = Math.round(me.y);
                const current  = axis === 'col' ? myX : myY;
                const matches  = (v) => ((v % 2) + 2) % 2 === parity;
                let pick = current;
                if (!matches(current)) {
                    pick = current + 1;
                }
                const tx = axis === 'col' ? pick : myX;
                const ty = axis === 'col' ? myY  : pick;
                this.beliefs.constraints.forcedTarget = {
                    x: tx, y: ty,
                    tolerance: 0,
                    reachedAt: null,
                    thenPickup: false
                };
                this.beliefs.constraints.pauseUntilResume = false;
                this.beliefs.currentPlan = null;
                console.log(`[bdi] L3 ${intent}: parity=${d.parity} axis=${axis} → target=(${tx},${ty})`);
                break;
            }
            case 'wait_for_signal': {
                this.beliefs.constraints.pauseUntilResume = true;
                this.beliefs.currentPlan = null;
                console.log('[bdi] L3 wait_for_signal: freezing until resume');
                break;
            }
            case 'resume': {
                this.beliefs.constraints.pauseUntilResume = false;
                this.beliefs.constraints.forcedTarget = null;
                this.beliefs.currentPlan = null;
                console.log('[bdi] L3 resume: back to normal deliberation');
                break;
            }
            default:
                console.log(`[bdi] unknown REQUEST intent: ${intent}`);
        }
    }

    _answer(parsed) {
        const st = this.client.state;
        const q = String(parsed.data?.question || '').toLowerCase();
        const carried = st.carrying.map(p => ({ id: p.id, reward: p.reward }));
        const visibleFree = st.freeParcels.map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward }));

        const cs = this.beliefs.constraints;
        const base = {
            position: {
                x: st.me.x !== undefined ? Math.round(st.me.x) : null,
                y: st.me.y !== undefined ? Math.round(st.me.y) : null
            },
            score: st.me.score,
            carrying: carried,
            currentTarget: this.beliefs.currentPlan ? this.beliefs.currentPlan.targetId : null,
            stepsLeft: this.beliefs.currentPlan ? this.beliefs.currentPlan.steps.length : 0,
            visibleFreeParcels: visibleFree,
            coordination: {
                paused: !!cs.pauseUntilResume,
                forcedTarget: cs.forcedTarget
                    ? { x: cs.forcedTarget.x, y: cs.forcedTarget.y,
                        tolerance: cs.forcedTarget.tolerance,
                        reached: !!cs.forcedTarget.reachedAt,
                        thenPickup: !!cs.forcedTarget.thenPickup }
                    : null
            }
        };

        if (q.includes('share') || q.includes('hand over') || q.includes('give')) {
            base.note = 'I cannot transfer parcels in-game (no putdown-on-demand protocol).';
        } else if (q.includes('avoid') || q.includes('stay away')) {
            base.note = 'Send a REQUEST with intent:avoid_zone to ask me to avoid a tile.';
        } else if (q.includes('claim') || q.includes('which parcel')) {
            base.note = 'currentTarget shows the parcel/zone I am committed to.';
        } else if (q.includes('help') || q.includes('strategy')) {
            base.note = 'I honour CLAIMs by blacklisting that parcel for 15s.';
        }
        return base;
    }
}

function mergeTiles(existing, incoming) {
    const out = Array.isArray(existing) ? [...existing] : [];
    for (const t of (Array.isArray(incoming) ? incoming : [])) {
        if (!out.some(e => e.x === t.x && e.y === t.y)) out.push({ x: t.x, y: t.y });
    }
    return out;
}
