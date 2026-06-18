// ASA inter-agent communication protocol.
//
// All structured messages are JSON-stringified objects shouted (or said) on
// the game socket with `asa: true` as a marker. Plain-text shouts (no marker)
// are surfaced as a separate event so the LLM agent can treat them as new
// natural-language objectives coming from a human player.

import { EventEmitter } from 'node:events';

export const ASA_MARKER = 'asa';

/** Pack a structured ASA message into the string the socket expects. */
export function pack(type, data = {}, extras = {}) {
    return JSON.stringify({ asa: true, type, data, ts: Date.now(), ...extras });
}

/** Returns the parsed envelope if the raw shout is an ASA message, else null. */
export function tryUnpack(raw) {
    if (raw && typeof raw === 'object' && raw.asa) return raw;
    if (typeof raw !== 'string') return null;
    try {
        const obj = JSON.parse(raw);
        return (obj && obj.asa) ? obj : null;
    } catch (_) { return null; }
}

/**
 * AsaProtocol owns the request/response side of inter-agent talk. It listens
 * on a GameClient's 'msg' event, routes ANSWERs to pending asks, and emits:
 *   'message'       — every parsed ASA envelope (CLAIM/RELEASE/BELIEF/etc.)
 *   'plain-text'    — every non-ASA shout/say (game-chat from a human)
 */
export class AsaProtocol extends EventEmitter {

    constructor(client) {
        super();
        this.client = client;
        this._questionCounter = 0;
        this._pending = new Map();  // qid -> { resolve, timer }

        client.on('msg', (m) => this._dispatch(m));
    }

    /** Broadcast a structured ASA message to all agents. */
    broadcast(type, data, extras = {}) {
        return this.client.shout(pack(type, data, extras));
    }

    /**
     * Send a QUERY and wait up to `timeoutMs` for an ANSWER carrying the same qid.
     * Resolves to the answer's `data` field, or null on timeout.
     */
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

    /** Synchronous reply to an incoming QUERY (used by `replyAck` handlers). */
    static answer(qid, data) {
        return JSON.stringify({ asa: true, type: 'ANSWER', qid, data, ts: Date.now() });
    }

    _dispatch({ fromId, fromName, msg, replyAck }) {
        const parsed = tryUnpack(msg);

        if (parsed) {
            parsed.fromId = fromId;
            parsed.fromName = fromName;

            // Route ANSWERs back to the awaiting ask().
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

        // Plain-text message → likely game chat / human objective.
        if (typeof msg === 'string' && msg.trim().length > 0) {
            this.emit('plain-text', { text: msg.trim(), fromId, fromName, replyAck });
        }
    }
}
