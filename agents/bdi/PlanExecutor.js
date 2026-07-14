const sleep = ms => new Promise(r => setTimeout(r, ms));

const MOVE_RETRIES  = 2;
const MOVE_RETRY_MS = 120;
const STUCK_WAIT_MS = 150;
const STUCK_LIMIT   = 3;

// plan execution, one step per call
export class PlanExecutor {

    constructor(client, beliefs) {
        this.client = client;
        this.beliefs = beliefs;
    }

    // move retry
    async resilientMove(direction, maxRetries = MOVE_RETRIES) {
        for (let i = 0; i < maxRetries; i++) {
            const result = await this.client.move(direction);
            if (result) return result;
            if (i < maxRetries - 1) await sleep(MOVE_RETRY_MS);
        }
        return false;
    }

    async executeStep(step, target) {
        const st = this.client.state;
        const plan = this.beliefs.currentPlan;
        if (!plan) return 'failed';

        // pick up
        if (step === 'pick_up') {
            const picked = await this.client.pickup();
            const p = st.parcels.get(target.id);
            if (p) p.carriedBy = st.me.id;
            this.beliefs.metrics.pickups += (Array.isArray(picked) && picked.length) ? picked.length : 1;
            this.beliefs.lastPickupAt = Date.now();
            plan.steps.shift();
            return 'done';
        }

        // put down
        if (step === 'put_down') {
            const ids = this.beliefs.deliverySet(st);
            if (ids && ids.length === 0) {
                await sleep(200);
                return 'wait';
            }
            const dropped = await this.client.putdown(ids || undefined);
            const droppedIds = (Array.isArray(dropped) && dropped.length && dropped[0] && dropped[0].id !== undefined)
                ? new Set(dropped.map(p => p.id))
                : (ids ? new Set(ids) : null);
            let delivered = 0;
            for (const [id, p] of st.parcels) {
                if (p.carriedBy !== st.me.id) continue;
                if (droppedIds && !droppedIds.has(id)) continue;
                st.parcels.delete(id);
                delivered++;
            }
            this.beliefs.metrics.deliveries += delivered;
            plan.steps.shift();
            return 'done';
        }

        // relay drop
        if (step === 'relay_drop') {
            const dropped = await this.client.putdown();
            const droppedIds = (Array.isArray(dropped) && dropped.length && dropped[0] && dropped[0].id !== undefined)
                ? new Set(dropped.map(p => p.id)) : null;
            let n = 0;
            for (const [id, p] of st.parcels) {
                if (p.carriedBy !== st.me.id) continue;
                if (droppedIds && !droppedIds.has(id)) continue;
                st.parcels.delete(id);
                n++;
            }
            console.log(`[bdi] relay hand-off at (${Math.round(st.me.x)},${Math.round(st.me.y)}): dropped ${n} for teammate`);
            plan.steps.shift();
            return 'done';
        }

        // move
        let tx = Math.round(st.me.x);
        let ty = Math.round(st.me.y);
        if (step === 'up')    ty += 1;
        if (step === 'down')  ty -= 1;
        if (step === 'left')  tx -= 1;
        if (step === 'right') tx += 1;

        // blocked by agent
        for (const a of st.agents.values()) {
            if (Math.round(a.x) === tx && Math.round(a.y) === ty) {
                plan.stuckCount = (plan.stuckCount || 0) + 1;
                if (plan.stuckCount >= STUCK_LIMIT) {
                    console.log('[bdi] blocked by another agent, rerouting...');
                    this.beliefs.currentPlan = null;
                } else {
                    await sleep(STUCK_WAIT_MS);
                }
                return 'stuck';
            }
        }

        plan.stuckCount = 0;

        const ok = await this.resilientMove(step);
        if (!ok) {
            // failed move -> obstacle
            console.log(`[bdi] move failed: ${step}, recalculating...`);
            this.beliefs.currentPlan = null;
            this.beliefs.obstacles.set(`${tx},${ty}`, Date.now());
            return 'failed';
        }

        plan.steps.shift();
        return 'done';
    }
}
