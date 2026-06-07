
import { EventEmitter } from 'node:events';
import { WorldState } from './WorldState.js';
import { manhattan } from './geometry.js';

export class GameClient extends EventEmitter {

    constructor(socket) {
        super();
        this.socket = socket;
        this.state = new WorldState();
        this._wireSocket();
    }

    ready() {
        return new Promise(resolve => {
            const check = () => {
                if (this.state.deliveryZones.length > 0 && this.state.me.x !== undefined) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    move(direction)   { return this.socket.emitMove(direction); }
    pickup()          { return this.socket.emitPickup(); }
    putdown(selected) { return this.socket.emitPutdown(selected); }
    shout(msg)        { return this.socket.emitShout(msg); }
    say(toId, msg)    { return this.socket.emitSay(toId, msg); }
    ask(toId, msg)    { return this.socket.emitAsk(toId, msg); }

    _wireSocket() {
        const s = this.socket;
        const st = this.state;

        s.on('connect',    () => this.emit('connect'));
        s.on('disconnect', () => this.emit('disconnect'));

        s.on('config', (config) => {
            if (config.CLOCK) st.config.clock = config.CLOCK;
            const playerCfg = (config.GAME && config.GAME.player) || config.PLAYER || {};
            if (playerCfg.capacity) st.config.capacity = playerCfg.capacity;
            if (playerCfg.vision)   st.config.vision   = playerCfg.vision;
            if (playerCfg.observation_distance) st.config.vision = playerCfg.observation_distance;
            if (playerCfg.movement_duration) st.config.movementDuration = playerCfg.movement_duration;
            this.emit('config', st.config);
        });

        s.on('map', (width, height, tiles) => {
            st.mapWidth = width;
            st.mapHeight = height;
            st.deliveryZones = [];
            st.spawnZones = [];
            for (const t of tiles) {
                st.map.set(`${t.x},${t.y}`, t.type);
                if (String(t.type) === '2' || t.type === 'delivery')
                    st.deliveryZones.push({ x: t.x, y: t.y });
                if (String(t.type) === '1' || t.type === 'parcel-spawning')
                    st.spawnZones.push({ x: t.x, y: t.y });
            }
            this.emit('map', { width, height });
        });

        s.onYou(me => {
            st.me = me;
            this.emit('me', me);
        });

        s.on('sensing', (data) => {
            if (data.parcels) this._handleParcels(data.parcels);
            if (data.agents)  this._handleAgents(data.agents);
            this.emit('sensing', data);
        });

        s.onMsg((id, name, msg, replyAck) => {
            this.emit('msg', { fromId: id, fromName: name, msg, replyAck });
        });
    }

    _handleParcels(sensed) {
        const st = this.state;
        const seenIds = new Set();

        for (const raw of sensed) {
            const p = raw.parcel || raw;
            if (!p.id) continue;
            seenIds.add(p.id);
            st.parcels.set(p.id, {
                id: p.id,
                x: raw.x !== undefined ? raw.x : p.x,
                y: raw.y !== undefined ? raw.y : p.y,
                reward: p.reward,
                carriedBy: p.carriedBy
            });
        }

        if (st.me.x !== undefined) {
            for (const [id, p] of st.parcels.entries()) {
                if (p.carriedBy === st.me.id) continue;
                const d = manhattan(st.me, p);
                if (d < st.config.vision && !seenIds.has(id)) {
                    st.parcels.delete(id);
                    this.emit('parcel-lost', { id, x: p.x, y: p.y });
                }
            }
        }

        this.emit('parcels-update', { sensedIds: seenIds });
    }

    _handleAgents(sensed) {
        const st = this.state;
        const now = Date.now();
        const seenIds = new Set();

        for (const a of sensed) {
            if (a.id === st.me.id) continue;
            seenIds.add(a.id);
            const prev = st.agents.get(a.id);
            st.agents.set(a.id, { ...a, prev, lastSeen: now });
        }

        for (const [id, a] of st.agents.entries()) {
            if (seenIds.has(id)) continue;
            const d = manhattan(st.me, a);
            if (d <= st.config.vision || now - a.lastSeen > 6000) {
                st.agents.delete(id);
                this.emit('agent-lost', { id });
            }
        }

        this.emit('agents-update', { sensedIds: seenIds });
    }
}
