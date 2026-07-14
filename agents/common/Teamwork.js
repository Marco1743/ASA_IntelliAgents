import { EventEmitter } from 'node:events';

const HELLO_INTERVAL_MS  = 1000;
const HELLO_TIMEOUT_MS   = 30000;
const STATE_INTERVAL_MS  = 1000;

// team layer
export class Teamwork extends EventEmitter {

    constructor(client, { role, secret }) {
        super();
        this.client = client;
        this.role   = role;
        this.secret = secret;
        this.myStatus = 'playing';
        this.teammate = null;
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

    // inbound filter
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

    // handshake
    _onHello(msg) {
        const known = this.teammate && this.teammate.id === msg.id;
        this._updateTeammate(msg, { role: msg.role });
        if (!known) {
            console.log(`[team:${this.role}] teammate found: ${msg.role} (${msg.id})`);
            this.emit('teammate', this.teammate);
            this._announce();
        }
    }

    _updateTeammate(msg, fields) {
        if (!msg.id) return;
        if (!this.teammate || this.teammate.id !== msg.id) {
            this.teammate = { id: msg.id, role: null, x: undefined, y: undefined, carrying: 0, score: 0, status: null };
        }
        Object.assign(this.teammate, fields, { lastSeen: Date.now() });
    }

    // outbound
    _send(obj) {
        const me = this.client.state.me;
        if (me.id === undefined || me.id === null) return;
        const envelope = { _team: this.secret, id: me.id, ...obj };
        if (this.teammate && this.teammate.id) this.client.say(this.teammate.id, envelope);
        else this.client.shout(envelope);
    }

    _announce() { this._send({ _t: 'hello', role: this.role }); }

    // state exchange
    broadcastState() {
        const st = this.client.state;
        this._send({ _t: 'state', x: Math.round(st.me.x), y: Math.round(st.me.y),
                     carrying: st.carrying.length, score: st.me.score, status: this.myStatus });
    }

    sendCoord(cmd, payload = {}) { this._send({ _t: 'coord', cmd, ...payload }); }
    sendRule(rule) { this._send({ _t: 'rule', rule }); }
    sendGoal(goal) { this._send({ _t: 'goal', goal }); }

    sendStatus(state) {
        const st = this.client.state;
        this._send({ _t: 'status', state, x: Math.round(st.me.x), y: Math.round(st.me.y), carrying: st.carrying.length });
    }

    sendSignal(name) { this._send({ _t: 'signal', name }); }

    // closest commits
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
