import * as tools from './tools.js';

// LLM-memory: live observations of the environment + active rules + a short
// history of past decisions, rebuilt from the world model on each request.
export class LlmMemory {

    constructor(client, bdi) {
        this.client = client;
        this.bdi = bdi;
        this.history = [];
    }

    observations() {
        const st = this.client.state;
        return {
            position: tools.getMyPosition(st),
            score: st.me.score,
            carrying: st.carrying.length,
            visibleParcels: tools.getParcels(st),
            deliveryZones: st.deliveryZones,
            mapSize: { width: st.mapWidth, height: st.mapHeight },
            activeRules: this.bdi ? this.bdi.beliefs.constraints : undefined
        };
    }

    context() {
        return {
            observations: this.observations(),
            recentMissions: this.history.slice(-3)
        };
    }

    remember(mission, decision) {
        this.history.push({ mission, decision: { kind: decision.kind, summary: decision.summary } });
        if (this.history.length > 10) this.history.shift();
    }
}
