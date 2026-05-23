// Plan-execution helper for BdiAgent. Owns the per-step logic:
// move retries, stuck detection, blocked-tile reaction. Kept separate from
// the agent loop so the loop reads as deliberation + commitment, and this
// class reads as "how to actually push a move through".

export class PlanExecutor {

    constructor(client, beliefs) {
        this.client = client;
        this.beliefs = beliefs;
    }

    /** Move with up to N retries on transient failures. */
    async resilientMove(direction, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            const r = await this.client.move(direction);
            if (r) return r;
            await sleep(500);
        }
        await this.client.shout(`Blocked trying to move ${direction}`);
        return false;
    }

    /**
     * Execute the next step of the current plan.
     * Returns: 'done' (step succeeded), 'stuck' (replan needed), 'failed' (replan + add obstacle).
     */
    async executeStep(nextAction, target) {
        const plan = this.beliefs.currentPlan;
        if (!plan) return 'failed';

        if (nextAction === 'pick_up') {
            await this.client.pickup();
            const p = this.client.state.parcels.get(target.id);
            if (p) p.carriedBy = this.client.state.me.id;
            plan.steps.shift();
            return 'done';
        }
        if (nextAction === 'put_down') {
            await this.client.putdown();
            const me = this.client.state.me;
            for (const [id, p] of this.client.state.parcels) {
                if (p.carriedBy === me.id) this.client.state.parcels.delete(id);
            }
            plan.steps.shift();
            return 'done';
        }

        // Move action — first check if an enemy is sitting on the target tile.
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
