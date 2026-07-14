import * as tools from './tools.js';

// llm memory
export class LlmMemory {

    constructor(client, bdi) {
        this.client = client;
        this.bdi = bdi;
        this.history = [];
    }

    // observations
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

    // context
    context() {
        return {
            observations: this.observations(),
            recentMissions: this.history.slice(-3)
        };
    }

    // history
    remember(mission, decision) {
        this.history.push({ mission, decision: { kind: decision.kind, summary: decision.summary } });
        if (this.history.length > 10) this.history.shift();
    }
}
