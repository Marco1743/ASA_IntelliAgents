
export class WorldState {
    constructor() {

        this.me = { id: null, name: null, x: undefined, y: undefined, score: 0 };

        this.map = new Map();
        this.mapWidth = 0;
        this.mapHeight = 0;

        this.parcels = new Map();

        this.agents = new Map();

        this.deliveryZones = [];

        this.spawnZones = [];

        this.config = {
            capacity: 5,
            vision: 5,
            clock: 50,
            movementDuration: 0
        };
    }

    get carrying() {
        return [...this.parcels.values()].filter(p => p.carriedBy === this.me.id);
    }

    get freeParcels() {
        return [...this.parcels.values()].filter(p => !p.carriedBy);
    }
}
