import { EventEmitter } from 'node:events';
import { WorldState } from './WorldState.js';
import { manhattan } from './geometry.js';

const AGENT_FORGET_MS = 5000;

// socket wrapper + sensing
export class GameClient extends EventEmitter {

    constructor(socket) {
        super();
        this.socket = socket;
        this.state  = new WorldState();
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

    // actions
    move(direction)   { return this.socket.emitMove(direction); }
    pickup()          { return this.socket.emitPickup(); }
    putdown(selected) { return this.socket.emitPutdown(selected); }
    shout(msg)        { return this.socket.emitShout(msg); }
    say(toId, msg)    { return this.socket.emitSay(toId, msg); }
    ask(toId, msg)    { return this.socket.emitAsk(toId, msg); }

    // sensing
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
            const moveDur = playerCfg.movement_duration || config.MOVEMENT_DURATION;
            if (moveDur) st.config.movementDuration = moveDur;
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
            if (data.crates)  this._handleCrates(data.crates);
            this.emit('sensing', data);
        });

        if (typeof s.onMsg === 'function') {
            s.onMsg((id, name, msg, replyAck) => {
                this.emit('msg', { fromId: id, fromName: name, msg, replyAck });
            });
        }
    }

    // belief revision: parcels
    _handleParcels(sensed) {
        const st = this.state;
        const seen = new Set();

        for (const raw of sensed) {
            const p = raw.parcel || raw;
            if (!p.id) continue;
            seen.add(p.id);
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
                if (d < st.config.vision && !seen.has(id)) {
                    st.parcels.delete(id);
                }
            }
        }

        this.emit('parcels', { sensedIds: seen });
    }

    // belief revision: crates
    _handleCrates(sensed) {
        const st = this.state;
        const seen = new Set();

        for (const c of sensed) {
            if (!c.id) continue;
            seen.add(c.id);
            st.crates.set(c.id, { id: c.id, x: c.x, y: c.y });
        }

        if (st.me.x !== undefined) {
            for (const [id, c] of st.crates.entries()) {
                const d = manhattan(st.me, c);
                if (d < st.config.vision && !seen.has(id)) {
                    st.crates.delete(id);
                }
            }
        }

        this.emit('crates', { sensedIds: seen });
    }

    // belief revision: agents
    _handleAgents(sensed) {
        const st = this.state;
        const now = Date.now();
        const seenIds = new Set();

        for (const a of sensed) {
            if (a.id === st.me.id) continue;
            seenIds.add(a.id);
            const prev = st.agents.get(a.id);
            st.agents.set(a.id, {
                ...a,
                vx: prev?.vx || 0,
                vy: prev?.vy || 0,
                lastSeen: now,
                stale: false
            });
        }

        for (const [id, a] of st.agents.entries()) {
            if (seenIds.has(id)) continue;
            const withinVision = manhattan(st.me, a) <= st.config.vision;
            if (withinVision || now - a.lastSeen > AGENT_FORGET_MS) {
                st.agents.delete(id);
            } else {
                a.stale = true;
            }
        }

        this.emit('agents', { sensedIds: seenIds });
    }
}
