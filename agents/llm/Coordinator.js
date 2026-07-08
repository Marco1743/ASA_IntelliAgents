const READY_TIMEOUT_MS = 30000;
const HOLD_AFTER_BOTH_MS = 2000;

// Agent B's L3 orchestration: turns a coordination effect into directives for
// Agent A (over the team layer) and Agent B's own BDI, tracks readiness, and
// reports back to the mission-agent.
export class Coordinator {

    constructor({ client, bdi, team }) {
        this.client = client;
        this.bdi    = bdi;
        this.team   = team;
        this.active = null;
        this.team.on('status', (s) => this._onMateStatus(s));
    }

    handle(effect, fromId) {
        if (Number.isFinite(effect.reward) && effect.reward <= 0) {
            console.log(`[coord] reward ${effect.reward} <= 0 — ignoring coordination mission.`);
            return;
        }
        switch (effect.task) {
            case 'rendezvous': return this._rendezvous(effect, fromId);
            case 'relay':      return this._relay(effect, fromId);
            case 'red_light':  return this._redLight(effect, fromId);
            case 'resume':     return this.go(fromId);
            default:
                console.log(`[coord] task '${effect.task}' not implemented yet.`);
        }
    }

    // --- Red light / green light --------------------------------------------

    _redLight(e, fromId) {
        const parity = e.parity === 'even' ? 'even' : 'odd';
        this.active = { task: 'red_light', fromId, parity, waitingForGo: true };
        this.team.sendCoord('red_light', { parity });
        this.bdi.setCoordination({ type: 'red_light', parity });
        console.log(`[coord] red light: both agents to the nearest ${parity} row, then waiting for the 'go' message.`);
    }

    isAwaitingGo() { return !!(this.active && this.active.task === 'red_light' && this.active.waitingForGo); }

    go(fromId) {
        if (!this.isAwaitingGo()) return;
        const a = this.active;
        a.waitingForGo = false;
        a.done = true;
        console.log('[coord] GREEN LIGHT — releasing both agents.');
        this.team.sendSignal('go');
        this.bdi.clearCoordination();
        if (a.fromId) this.client.say(a.fromId, 'green light received: both agents moving again').catch(() => {});
        this.active = null;
    }

    // --- Relay: A collects & hands off, B delivers --------------------------

    _relay(e, fromId) {
        const handoff = this._pickHandoffTile();
        if (!handoff) {
            console.log('[coord] relay: no delivery zone / map not ready yet — resend the mission in a moment.');
            return;
        }
        this.active = { task: 'relay', fromId };
        this.team.sendCoord('relay', { role: 'collector', handoff });
        this.bdi.setCoordination({ type: 'relay', role: 'deliverer', handoff });
        console.log(`[coord] relay active: A = collector, B = deliverer, handoff tile (${handoff.x},${handoff.y}).`);
        if (fromId) this.client.say(fromId, `relay set up: collecting and delivering via handoff (${handoff.x},${handoff.y})`).catch(() => {});
    }

    // a walkable, non-delivery tile next to a central delivery zone
    _pickHandoffTile() {
        const st = this.client.state;
        const zones = st.deliveryZones || [];
        if (!zones.length) return null;
        const walkable = (x, y) => { const t = st.map.get(`${x},${y}`); return t !== undefined && String(t) !== '0'; };
        const isZone = (x, y) => zones.some(z => z.x === x && z.y === y);

        const cx = (st.mapWidth || 0) / 2, cy = (st.mapHeight || 0) / 2;
        const zone = zones.slice().sort((a, b) =>
            (Math.abs(a.x - cx) + Math.abs(a.y - cy)) - (Math.abs(b.x - cx) + Math.abs(b.y - cy)))[0];

        for (let r = 1; r <= 4; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    if (Math.abs(dx) + Math.abs(dy) !== r) continue;
                    const x = zone.x + dx, y = zone.y + dy;
                    if (walkable(x, y) && !isZone(x, y)) return { x, y };
                }
            }
        }
        return null;
    }

    // --- Rendezvous: both agents within `dist` of (x,y), waiting ------------

    _rendezvous(e, fromId) {
        const x = Number(e.x), y = Number(e.y);
        const dist = Number.isFinite(Number(e.dist)) ? Number(e.dist) : 3;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            console.log('[coord] rendezvous: no valid (x,y) — ignoring.');
            return;
        }
        this.active = { task: 'rendezvous', fromId, selfReady: false, mateReady: false, done: false };

        this.team.sendCoord('rendezvous', { x, y, dist });
        this.bdi.setCoordination({ type: 'goto_wait', x, y, dist }, (state) => {
            if (state === 'ready') { this.active.selfReady = true; this._checkBothReady(); }
        });
        console.log(`[coord] rendezvous near (${x},${y}) dist<=${dist}: directed A and self to meet.`);

        setTimeout(() => {
            if (this.active && !this.active.done && !this.active.mateReady) {
                console.log('[coord] still waiting for teammate to reach the rendezvous...');
            }
        }, READY_TIMEOUT_MS);
    }

    _onMateStatus(s) {
        if (!this.active || this.active.done) return;
        if (s.state === 'ready') { this.active.mateReady = true; this._checkBothReady(); }
    }

    _checkBothReady() {
        const a = this.active;
        if (!a || a.done) return;
        if (a.selfReady && a.mateReady) {
            a.done = true;
            console.log('[coord] BOTH agents have arrived — rendezvous achieved.');
            if (a.fromId) this.client.say(a.fromId, 'rendezvous complete: both agents arrived and waited').catch(() => {});
            setTimeout(() => {
                this.team.sendCoord('release');
                this.bdi.clearCoordination();
                this.active = null;
                console.log('[coord] released both agents — back to normal play.');
            }, HOLD_AFTER_BOTH_MS);
        }
    }
}
