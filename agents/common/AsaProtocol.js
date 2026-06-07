
import { EventEmitter } from 'node:events';

export const ASA_MARKER = 'asa';

export function pack(type, data = {}, extras = {}) {
    return JSON.stringify({ asa: true, type, data, ts: Date.now(), ...extras });
}

export function tryUnpack(raw) {
    if (raw && typeof raw === 'object' && raw.asa) return raw;
    if (typeof raw !== 'string') return null;
    try {
        const obj = JSON.parse(raw);
        return (obj && obj.asa) ? obj : null;
    } catch (_) { return null; }
}

export class AsaProtocol extends EventEmitter {

    constructor(client) {
        super();
        this.client = client;
        this._questionCounter = 0;
        this._pending = new Map();

        client.on('msg', (m) => this._dispatch(m));
    }

    broadcast(type, data, extras = {}) {
        return this.client.shout(pack(type, data, extras));
    }

    ask(question, timeoutMs = 2500) {
        const qid = `q${++this._questionCounter}_${Date.now()}`;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this._pending.delete(qid);
                resolve(null);
            }, timeoutMs);
            this._pending.set(qid, { resolve, timer });
            this.client.shout(pack('QUERY', { question }, { qid }));
        });
    }

    static answer(qid, data) {
        return JSON.stringify({ asa: true, type: 'ANSWER', qid, data, ts: Date.now() });
    }

    _dispatch({ fromId, fromName, msg, replyAck }) {
        const parsed = tryUnpack(msg);

        if (parsed) {
            parsed.fromId = fromId;
            parsed.fromName = fromName;

            if (parsed.type === 'ANSWER' && parsed.qid && this._pending.has(parsed.qid)) {
                const { resolve, timer } = this._pending.get(parsed.qid);
                clearTimeout(timer);
                this._pending.delete(parsed.qid);
                resolve(parsed.data);
                return;
            }

            this.emit('message', parsed, replyAck);
            return;
        }

        if (typeof msg === 'string' && msg.trim().length > 0) {
            this.emit('plain-text', { text: msg.trim(), fromId, fromName, replyAck });
        }
    }
}
