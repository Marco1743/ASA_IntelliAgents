// BDI plan library: one plan per intention. A plan navigates to the target (via
// the injected navigate callback, which runs A*/PDDL) then appends its terminal
// action. Deliberation selects the applicable plan with selectPlan.

class Plan {
    // terminalAction: 'pick_up' | 'put_down' | null
    constructor(intention, terminalAction = null) {
        this.intention = intention;
        this.terminalAction = terminalAction;
    }

    isApplicableTo(intention) {
        return intention === this.intention;
    }

    // navigate: (from, target) => Promise<directions[] | null>
    async build(navigate, from, target) {
        const path = await navigate(from, target);
        if (path === null) return null;
        if (this.terminalAction) path.push(this.terminalAction);
        return path;
    }
}

export const PickupPlan  = new Plan('pickup',  'pick_up');
export const DeliverPlan = new Plan('deliver', 'put_down');
export const PatrolPlan  = new Plan('patrol');
export const ExplorePlan = new Plan('explore');

const planLibrary = [PickupPlan, DeliverPlan, PatrolPlan, ExplorePlan];

export function selectPlan(intention) {
    return planLibrary.find(p => p.isApplicableTo(intention)) || null;
}
