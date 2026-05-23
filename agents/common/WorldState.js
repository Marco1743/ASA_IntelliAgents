// Plain data container for everything an agent needs to know about the world
// at any given tick. Both BDI and LLM agents own one of these; they EXTEND it
// by composition with their own state objects (beliefs / memory) rather than
// inheriting, so the base never has to know the specifics.

export class WorldState {
    constructor() {
        /** @type {{id:string,name:string,x:number,y:number,score:number,penalty?:number}} */
        this.me = { id: null, name: null, x: undefined, y: undefined, score: 0 };

        /** Tile map keyed by "x,y" -> tile type ('0','1','2','3', or arrows). */
        this.map = new Map();
        this.mapWidth = 0;
        this.mapHeight = 0;

        /** Currently-known parcels keyed by id. */
        this.parcels = new Map();

        /** Currently-sensed other agents keyed by id. */
        this.agents = new Map();

        /** Delivery zone tiles (type '2'). */
        this.deliveryZones = [];

        /** Parcel-spawning tiles (type '1'). */
        this.spawnZones = [];

        /** Game configuration values reported by the server. */
        this.config = {
            capacity: 5,
            vision: 5,
            clock: 50,
            movementDuration: 0
        };
    }

    /** Parcels I am currently carrying. */
    get carrying() {
        return [...this.parcels.values()].filter(p => p.carriedBy === this.me.id);
    }

    /** Parcels visible and free for the taking. */
    get freeParcels() {
        return [...this.parcels.values()].filter(p => !p.carriedBy);
    }
}
