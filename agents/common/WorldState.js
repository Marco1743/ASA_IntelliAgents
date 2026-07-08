// Sensed game state from the server (self, map, parcels, agents, zones, config),
// shared by both agents. Agent-private memory lives in bdi/BdiBeliefs.js.
export class WorldState {
    constructor() {
        this.me = { id: null, name: null, x: undefined, y: undefined, score: 0 };

        this.map = new Map();   // "x,y" -> tile type
        this.mapWidth = 0;
        this.mapHeight = 0;

        this.parcels = new Map(); // id -> { id, x, y, reward, carriedBy }
        this.agents  = new Map(); // id -> sensed agent

        this.deliveryZones = [];
        this.spawnZones    = [];

        this.config = {
            capacity: 5,
            vision: 5,
            clock: 50,
            movementDuration: 0 // ms per move step (0 = unknown; callers default to 500)
        };
    }

    get carrying() {
        return [...this.parcels.values()].filter(p => p.carriedBy === this.me.id);
    }

    get freeParcels() {
        return [...this.parcels.values()].filter(p => !p.carriedBy);
    }
}
