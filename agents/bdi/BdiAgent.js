// BDI agent — sense, deliberate, plan, execute, replan, repeat.

import { Pathfinder } from '../common/Pathfinder.js';
import { manhattan, getClosest } from '../common/geometry.js';
import { BdiBeliefs } from './BdiBeliefs.js';
import { PlanExecutor } from './PlanExecutor.js';
import { getBestParcel, getBestSpawnZone, getRandomExploreTarget } from './Intentions.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class BdiAgent {

    constructor({ client, asa }) {
        this.client     = client;
        this.asa        = asa;
        this.beliefs    = new BdiBeliefs(client);
        this.pathfinder = new Pathfinder(client.state.map);
        this.executor   = new PlanExecutor(client, this.beliefs);

        this._wireAsa();
    }

    async start() {
        console.log('[bdi] waiting for game state...');
        await this.client.ready();
        console.log('[bdi] starting agent loop');
        this._loop();
    }

    // ---------------------------------------------------------- main loop

    async _loop() {
        let silentWait = 0;

        while (true) {
            try {
                this.beliefs.pruneStale();
                this._markCheckedZones();

                const { target, intention } = this._deliberate();

                if (!target) {
                    if (silentWait++ % 20 === 0) console.log('[bdi] idle, no target');
                    await sleep(50);
                    continue;
                }

                // Plan if needed.
                const targetId = this._targetId(target, intention);
                if (!this.beliefs.currentPlan
                    || this.beliefs.currentPlan.targetId !== targetId
                    || this.beliefs.currentPlan.steps.length === 0) {
                    const plan = this._buildPlan(target, intention);
                    if (!plan) {
                        const k = target.id || `${Math.round(target.x)},${Math.round(target.y)}`;
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
                    console.log(`[bdi] new plan for ${intention} (${plan.length} steps)`);
                    silentWait = 0;
                }

                // Execute one step.
                const step = this.beliefs.currentPlan.steps[0];
                await this.executor.executeStep(step, target);

            } catch (err) {
                console.log(`[bdi] loop error: ${err.message}`);
                await sleep(1000);
            }
        }
    }

    // ---------------------------------------------------------- deliberation

    _deliberate() {
        const st = this.client.state;
        const carrying = st.carrying;

        // 1) Honour a running plan if its premise still holds.
        let target = null, intention = null;
        const plan = this.beliefs.currentPlan;
        if (plan && plan.steps.length > 0) {
            const tId = plan.targetId;
            if (tId === 'delivery') {
                target = getClosest(st.me, st.deliveryZones); intention = 'deliver';
            } else if (tId === 'patrol' || tId === 'explore') {
                target = plan.target; intention = tId;
            } else if (tId.startsWith('p')) {
                const p = st.parcels.get(tId);
                if (p && !p.carriedBy) { target = p; intention = 'pickup'; }
                else                   { this.beliefs.currentPlan = null; }
            }
        }

        // 2) Soft commitment: maybe abandon for something better.
        const best = getBestParcel(st, this.beliefs);
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

        // 3) Choose a fresh intention if we don't have one.
        if (!target) {
            const closestDel = getClosest(st.me, st.deliveryZones);
            if (carrying.length >= st.config.capacity
                || (carrying.length > 0 && !best)) {
                target = closestDel; intention = 'deliver';
            } else if (best) {
                target = best; intention = 'pickup';
            } else if (st.spawnZones.length > 0) {
                target = getBestSpawnZone(st, this.beliefs); intention = 'patrol';
            } else {
                target = getRandomExploreTarget(st); intention = 'explore';
            }
        }
        return { target, intention };
    }

    /** Should we abandon `current` parcel because `candidate` is better? */
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
        return intention; // 'patrol' / 'explore'
    }

    // ---------------------------------------------------------- planning

    _buildPlan(target, intention) {
        const softCosts = this.beliefs.buildEnemyCostMap();
        let path = this.pathfinder.findPath(this.client.state.me, target, {
            softCosts,
            blocked:   this.beliefs.blockedTiles,
            obstacles: this.beliefs.obstacles
        });
        if (path === null) {
            // Soft-cost search failed — relax it and try again.
            path = this.pathfinder.findPath(this.client.state.me, target, {
                blocked:   this.beliefs.blockedTiles,
                obstacles: this.beliefs.obstacles
            });
            if (path !== null) console.log('[bdi] soft-cost A* failed, fell back to hard');
        }
        if (path === null) return null;
        if (intention === 'pickup')  path.push('pick_up');
        if (intention === 'deliver') path.push('put_down');
        return path;
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

    // ---------------------------------------------------------- ASA wiring

    _wireAsa() {
        this.asa.on('message', (parsed, replyAck) => this._onAsaMessage(parsed, replyAck));
    }

    _onAsaMessage(parsed, replyAck) {
        this.beliefs.teamMessages.push({ at: Date.now(), ...parsed });
        if (this.beliefs.teamMessages.length > 30) this.beliefs.teamMessages.shift();

        switch (parsed.type) {
            case 'CLAIM':
                if (parsed.data?.parcel_id) {
                    this.beliefs.teamClaims.set(parsed.data.parcel_id,
                        { byId: parsed.fromId, at: Date.now() });
                    this.beliefs.blacklistedTargets.set(parsed.data.parcel_id, Date.now());
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
            case 'QUERY': {
                const answer = this._answer(parsed);
                if (typeof replyAck === 'function') {
                    replyAck(JSON.stringify({ asa: true, type: 'ANSWER',
                        qid: parsed.qid, data: answer }));
                } else if (parsed.qid) {
                    this.client.shout(JSON.stringify({ asa: true, type: 'ANSWER',
                        qid: parsed.qid, data: answer }));
                }
                break;
            }
        }
    }

    _answer(parsed) {
        const st = this.client.state;
        const q = String(parsed.data?.question || '').toLowerCase();
        const carried = st.carrying.map(p => ({ id: p.id, reward: p.reward }));
        const visibleFree = st.freeParcels.map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward }));

        const base = {
            position: {
                x: st.me.x !== undefined ? Math.round(st.me.x) : null,
                y: st.me.y !== undefined ? Math.round(st.me.y) : null
            },
            score: st.me.score,
            carrying: carried,
            currentTarget: this.beliefs.currentPlan ? this.beliefs.currentPlan.targetId : null,
            stepsLeft: this.beliefs.currentPlan ? this.beliefs.currentPlan.steps.length : 0,
            visibleFreeParcels: visibleFree
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
