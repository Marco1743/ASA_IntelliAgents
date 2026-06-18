// Extra memory state for the LLM agent — sits alongside the base WorldState
// owned by GameClient. Holds objective, ReAct history, BDI inbox, free-form
// notes, and the replan flag the planner reads between turns.

export class LlmMemory {

    constructor(client) {
        this.client    = client;
        this.objective = null;
        this.objectiveSetAt = 0;

        this.history  = [];   // [{ iter, tool, args, observation }]
        this.inbox    = [];   // structured BDI messages
        this.notes    = [];   // free-form scratchpad
        this.iteration = 0;

        this.shouldReplan = false;
        this.replanReason = null;

        // Replan automatically when a parcel I was tracking disappears.
        client.on('parcel-lost', ({ id }) => {
            this.shouldReplan = true;
            this.replanReason = `parcel_${id}_lost`;
        });
    }

    setObjective(text) {
        this.objective = text;
        this.objectiveSetAt = Date.now();
        this.history = [];
        this.iteration = 0;
        this.shouldReplan = true;
        this.replanReason = 'new_objective';
    }

    recordToolCall(tool, args, observation) {
        this.iteration++;
        this.history.push({
            iter: this.iteration,
            tool,
            args,
            observation: this._truncate(observation, 600)
        });
        if (this.history.length > 20) this.history = this.history.slice(-20);
    }

    pushInbox(msg) {
        this.inbox.push({ ...msg, receivedAt: Date.now() });
        if (this.inbox.length > 30) this.inbox = this.inbox.slice(-30);
        if (msg.type === 'CLAIM' || msg.type === 'BELIEF' || msg.type === 'REQUEST') {
            this.shouldReplan = true;
            this.replanReason = `bdi_${msg.type.toLowerCase()}`;
        }
    }

    drainInbox() {
        const out = this.inbox.slice();
        this.inbox = [];
        return out;
    }

    addNote(note) {
        this.notes.push({ at: Date.now(), note: String(note).slice(0, 200) });
        if (this.notes.length > 15) this.notes = this.notes.slice(-15);
    }

    /** Compact view shipped to the LLM each turn. */
    snapshot() {
        const st = this.client.state;
        const carriedSet = new Set(st.carrying.map(p => p.id));
        const visibleParcels = [...st.parcels.values()].map(p => ({
            id: p.id, x: p.x, y: p.y, reward: p.reward,
            carriedByMe: carriedSet.has(p.id),
            carriedByOther: !!p.carriedBy && !carriedSet.has(p.id)
        }));
        const visibleAgents = [...st.agents.values()].map(a => ({
            id: a.id, name: a.name,
            x: Math.round(a.x), y: Math.round(a.y),
            score: a.score
        }));
        return {
            objective: this.objective,
            me: {
                id: st.me.id, name: st.me.name,
                x: st.me.x !== undefined ? Math.round(st.me.x) : null,
                y: st.me.y !== undefined ? Math.round(st.me.y) : null,
                score: st.me.score,
                carrying: st.carrying.length,
                capacity: st.config.capacity
            },
            map: {
                width: st.mapWidth, height: st.mapHeight,
                deliveryZones: st.deliveryZones.length,
                spawnZones: st.spawnZones.length
            },
            visibleParcels,
            visibleAgents,
            recentHistory: this.history.slice(-8),
            inbox: this.inbox.slice(-5),
            notes: this.notes.slice(-5)
        };
    }

    _truncate(s, n) {
        const str = typeof s === 'string' ? s : JSON.stringify(s);
        return str.length > n ? str.slice(0, n) + '…' : str;
    }
}
