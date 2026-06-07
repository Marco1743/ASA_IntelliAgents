
import { selectDeliverySet } from './Intentions.js';

export class PlanExecutor {

    constructor(client, beliefs) {
        this.client = client;
        this.beliefs = beliefs;
    }

    async resilientMove(direction, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            const r = await this.client.move(direction);
            if (r) return r;
            await sleep(500);
        }

        return false;
    }

    async executeStep(nextAction, target) {
        const plan = this.beliefs.currentPlan;
        if (!plan) return 'failed';

        if (nextAction === 'pick_up') {
            const picked = await this.client.pickup();
            const p = this.client.state.parcels.get(target.id);
            if (p) p.carriedBy = this.client.state.me.id;
            if (picked && picked.length) this.beliefs.metrics.pickups += picked.length;
            plan.steps.shift();
            return 'done';
        }
        if (nextAction === 'put_down') {
            const me = this.client.state.me;

            const onDelivery = this.client.state.deliveryZones.some(z =>
                Math.round(z.x) === Math.round(me.x) && Math.round(z.y) === Math.round(me.y));

            const selectedIds = onDelivery ? selectDeliverySet(this.client.state, this.beliefs) : null;
            await this.client.putdown(selectedIds || undefined);

            const droppedSet = selectedIds ? new Set(selectedIds) : null;
            let countedDeliveries = 0;
            for (const [id, p] of this.client.state.parcels) {
                if (p.carriedBy !== me.id) continue;
                if (droppedSet && !droppedSet.has(id)) continue;
                this.client.state.parcels.delete(id);
                if (onDelivery) countedDeliveries++;
            }
            if (onDelivery) this.beliefs.metrics.deliveries += countedDeliveries;
            plan.steps.shift();
            return 'done';
        }

        const me = this.client.state.me;
        let tx = Math.round(me.x), ty = Math.round(me.y);
        if (nextAction === 'up')    ty += 1;
        if (nextAction === 'down')  ty -= 1;
        if (nextAction === 'left')  tx -= 1;
        if (nextAction === 'right') tx += 1;

        for (const a of this.client.state.agents.values()) {
            if (Math.round(a.x) === tx && Math.round(a.y) === ty) {
                plan.stuckCount = (plan.stuckCount || 0) + 1;
                if (plan.stuckCount >= 3) {
                    const key = `${tx},${ty}`;
                    this.beliefs.blockedTiles.set(key, Date.now());
                    this.beliefs.currentPlan = null;
                    return 'stuck';
                }
                await sleep(200);
                return 'stuck';
            }
        }

        plan.stuckCount = 0;
        const ok = await this.resilientMove(nextAction);
        if (!ok) {
            this.beliefs.currentPlan = null;
            this.beliefs.obstacles.set(`${tx},${ty}`, Date.now());
            return 'failed';
        }
        plan.steps.shift();
        return 'done';
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
