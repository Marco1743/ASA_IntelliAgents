// fallback parser (L2/L3)

const coordsIn = text => [...text.matchAll(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g)]
    .map(m => [Number(m[1]), Number(m[2])]);

const ZERO_REWARD = /(no reward|\b0\s*(?:pts|points)\b|\bzero\b)/;

// L2 rules
export function detectRule(text) {
    const t = String(text).toLowerCase();

    let m = t.match(/stacks?\s+of\s+(?:exactly\s+)?(\d+)/);
    if (m) {
        const n = Number(m[1]);
        let multiplier = 1;
        if (/\bdouble\b/.test(t)) multiplier = 2;
        else if (/\btriple\b/.test(t)) multiplier = 3;
        else if (/\bhalve?\b/.test(t)) multiplier = 0.5;
        else {
            const mm = t.match(/([0-9]*\.?[0-9]+)\s*(?:x\b|times|of\s+(?:the\s+)?standard)/);
            if (mm) multiplier = Number(mm[1]);
        }
        return { rule: 'delivery_stack', n, multiplier };
    }

    m = t.match(/(?:score|reward|value)\s+(?:higher|greater|more)\s+than\s+(\d+)/);
    if (m && ZERO_REWARD.test(t)) {
        return { rule: 'reward_filter', maxReward: Number(m[1]) };
    }

    if (/(do not|don't|avoid)/.test(t) && /(through|cross|enter|step on|go to)/.test(t)) {
        const tiles = coordsIn(t);
        if (tiles.length) {
            const pen = t.match(/lose\s+(\d+)/);
            return { rule: 'avoid_tile', tiles, penalty: pen ? Number(pen[1]) : 50 };
        }
    }

    if (/deliver(?:ing|y)?\s+(?:in|at|to)/.test(t)) {
        const tiles = coordsIn(t);
        if (tiles.length) {
            let multiplier = null;
            if (ZERO_REWARD.test(t)) multiplier = 0;
            else {
                const mm = t.match(/(\d+(?:\.\d+)?)\s*x\b/);
                if (mm) multiplier = Number(mm[1]);
            }
            if (multiplier !== null) return { rule: 'delivery_zone_reward', tiles, multiplier };
        }
    }

    return null;
}

// L3 coordination
export function detectCoordination(text) {
    const t = String(text).toLowerCase();
    const tiles = coordsIn(t);
    const reward = () => { const m = t.match(/(\d+)\s*(?:pts|points)/); return m ? Number(m[1]) : 0; };

    if (/(both agents|each other|together)/.test(t) && tiles.length) {
        const dm = t.match(/(?:distance of|within)\s+(\d+)/);
        return { task: 'rendezvous', x: tiles[0][0], y: tiles[0][1], dist: dm ? Number(dm[1]) : 3, reward: reward() };
    }

    if (/(red light|wait for (?:our|the|my) (?:message|signal|go))/.test(t)) {
        const parity = /\beven\b/.test(t) ? 'even' : 'odd';
        return { task: 'red_light', parity, reward: reward() };
    }

    if (/(green ?light|\bresume\b|\bproceed\b|go now|you (?:can|may)\b[^.!?]*\b(?:go|move|continue)|lights? (?:are )?green|carry on)/.test(t)) {
        return { task: 'resume' };
    }

    if (/(picked up by one|delivered by the other|hand[- ]?off|relay)/.test(t)) {
        return { task: 'relay', reward: reward() };
    }

    return null;
}
