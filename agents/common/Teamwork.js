import { EventEmitter } from 'node:events';

const HELLO_INTERVAL_MS  = 1000;  // re-announce until the teammate is found
const HELLO_TIMEOUT_MS   = 30000; // give up actively shouting after this
const STATE_INTERVAL_MS  = 1000;  // belief-exchange heartbeat

// Team layer (L3) shared by both players, on top of the game's say/shout/onMsg:
// discovery via a shared TEAM_SECRET handshake, periodic belief exchange, and
// directives. Every team message carries `_team:<secret>`, so ingest() consumes
// team traffic and returns false for real missions.
export class Teamwork extends EventEmitter {

    // opts: { role: 'A'|'B', secret: shared team password }
    constructor(client, { role, secret }) {
        super();
        this.client = client;
        this.role   = role;
        this.secret = secret;
        this.myStatus = 'playing';
        this.teammate = null; // { id, role, x, y, carrying, score, status, lastSeen }
        this._timers = [];
    }

    start() {
        const helloStart = Date.now();
        const hello = setInterval(() => {
            if (this.teammate) return;
            if (Date.now() - helloStart > HELLO_TIMEOUT_MS) return;
            this._announce();
        }, HELLO_INTERVAL_MS);

        const state = setInterval(() => {
            if (this.teammate) this.broadcastState();
        }, STATE_INTERVAL_MS);

        for (const t of [hello, state]) if (t.unref) t.unref();
        this._timers.push(hello, state);
        this._announce();
    }

    stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

    // --- Inbound -----------------------------------------------------------

    // returns true if the message was team-internal (consumed), false if it is a
    // normal mission the caller should handle
    ingest(fromId, fromName, msg, replyAck) {
        if (!msg || typeof msg !== 'object' || msg._team !== this.secret) return false;

        switch (msg._t) {
            case 'hello':
                this._onHello(msg);
                break;
            case 'state':
                this._updateTeammate(msg, { x: msg.x, y: msg.y, carrying: msg.carrying, score: msg.score, status: msg.status });
                break;
            case 'coord':
                this.emit('coord', { cmd: msg.cmd, ...msg, fromId });
                break;
            case 'rule':
                this.emit('rule', { rule: msg.rule, fromId });
                break;
            case 'goal':
                this.emit('goal', { goal: msg.goal, fromId });
                break;
            case 'status':
                this._updateTeammate(msg, { x: msg.x, y: msg.y, carrying: msg.carrying, status: msg.state });
                this.emit('status', { state: msg.state, x: msg.x, y: msg.y, carrying: msg.carrying, fromId });
                break;
            case 'signal':
                this.emit('signal', { name: msg.name, fromId });
                break;
            default:
                break;
        }
        return true;
    }

    _onHello(msg) {
        const known = this.teammate && this.teammate.id === msg.id;
        this._updateTeammate(msg, { role: msg.role });
        if (!known) {
            console.log(`[team:${this.role}] teammate found: ${msg.role} (${msg.id})`);
            this.emit('teammate', this.teammate);
            this._announce(); // reply so the other side learns us promptly
        }
    }

    _updateTeammate(msg, fields) {
        if (!msg.id) return;
        if (!this.teammate || this.teammate.id !== msg.id) {
            this.teammate = { id: msg.id, role: null, x: undefined, y: undefined, carrying: 0, score: 0, status: null };
        }
        Object.assign(this.teammate, fields, { lastSeen: Date.now() });
    }

    // --- Outbound ----------------------------------------------------------

    // directed if we know the teammate, else broadcast so the handshake can complete
    _send(obj) {
        const me = this.client.state.me;
        if (me.id === undefined || me.id === null) return;
        const envelope = { _team: this.secret, id: me.id, ...obj };
        if (this.teammate && this.teammate.id) this.client.say(this.teammate.id, envelope);
        else this.client.shout(envelope);
    }

    _announce() { this._send({ _t: 'hello', role: this.role }); }

    broadcastState() {
        const st = this.client.state;
        this._send({ _t: 'state', x: Math.round(st.me.x), y: Math.round(st.me.y),
                     carrying: st.carrying.length, score: st.me.score, status: this.myStatus });
    }

    sendCoord(cmd, payload = {}) { this._send({ _t: 'coord', cmd, ...payload }); }   // B -> A: command
    sendRule(rule) { this._send({ _t: 'rule', rule }); }                            // B -> A: L2 rule
    sendGoal(goal) { this._send({ _t: 'goal', goal }); }                            // B -> A: L1 goal

    sendStatus(state) {                                                             // A -> B: progress
        const st = this.client.state;
        this._send({ _t: 'status', state, x: Math.round(st.me.x), y: Math.round(st.me.y), carrying: st.carrying.length });
    }

    sendSignal(name) { this._send({ _t: 'signal', name }); }                        // one-off (e.g. 'go')

    // true if the team-mate is closer to `goal` (ties -> lower id), so this agent
    // yields and lets it commit. False when we have no team-mate (single-agent).
    shouldYieldGoal(goal) {
        const mate = this.teammate;
        const me = this.client.state.me;
        if (!mate || mate.x === undefined || me.x === undefined) return false;
        const myD   = Math.abs(Math.round(me.x) - goal.x) + Math.abs(Math.round(me.y) - goal.y);
        const mateD = Math.abs(mate.x - goal.x) + Math.abs(mate.y - goal.y);
        if (mateD < myD) return true;
        if (mateD === myD) return String(me.id) > String(mate.id);
        return false;
    }
}
