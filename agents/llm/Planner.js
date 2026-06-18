// Planner = LLM-Planner + LLM-Replanner from the slides.
//
// One ReAct loop with native function calling: the model picks a tool, we
// run it, append the result as a `tool` message, repeat. Between turns we
// inspect `memory.shouldReplan` and prepend a fresh snapshot + replan note
// when the world changed — that is the "replanner" half.

const SYSTEM_PROMPT = `You are an autonomous LLM-based agent playing the Deliveroo.js parcel-delivery game.

You share the grid with a separate BDI agent. Tools for cooperation:
broadcast_message, share_belief, claim_parcel, ask_bdi, read_inbox.

GAME FACTS YOU MUST INTERNALISE
- You can ONLY pick up parcels that are NOT already carriedBy another agent.
- The BDI agent CANNOT hand you a parcel mid-game — there is no transfer
  action in the protocol. Don't ask it to "share" or "give" parcels.
- Parcels respawn on spawn-zone tiles. If none are visible, the best move is
  patrol_spawn_zone to scout a new zone, then sense_environment.
- Your vision range is finite (see memory snapshot). Standing still won't
  reveal new parcels.

DECISION POLICY (strict)
1. ALWAYS call exactly one tool per turn — never reply in plain text.
2. Use the memory snapshot first. Do not call sense_environment if the
   snapshot already shows what you need.
3. Pick high-level tools (go_to_nearest_parcel, deliver_carried_parcels,
   patrol_spawn_zone) over manual move sequences.
4. If a tool returns the same error twice (e.g. "no visible parcels"), do
   NOT repeat it — change strategy:
     a) call patrol_spawn_zone to move toward a fresh zone
     b) then sense_environment
     c) if STILL nothing for 3+ rounds, call finish_objective with a
        truthful status ("objective unsatisfiable: BDI holds all parcels").
5. Do not broadcast the same message twice. Coordination = single concise
   message + listen via read_inbox.
6. ask_bdi returns a structured object with: position, score, carrying[],
   currentTarget, visibleFreeParcels[]. Read those fields, don't re-ask.
7. The objective is achieved when its literal condition is met OR no
   further progress is possible. In both cases call finish_objective.
`;

export class Planner {

    constructor({ llmClient, model, memory, toolImpls, openAITools,
                  maxIterations = 30, llmTimeoutMs = 120000 }) {
        this.llmClient    = llmClient;
        this.model        = model;
        this.memory       = memory;
        this.toolImpls    = toolImpls;
        this.openAITools  = openAITools;
        this.maxIterations = maxIterations;
        this.llmTimeoutMs  = llmTimeoutMs;
    }

    async run() {
        const memory = this.memory;
        if (!memory.objective) {
            console.log('[planner] no objective set — idling');
            return;
        }

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: this._composeUserTurn(true, null) }
        ];

        const recentCalls = [];
        let loopNudgeIssued = false;

        for (let iter = 0; iter < this.maxIterations; iter++) {

            // Replanner hook: if the world changed since last turn, inject a
            // fresh snapshot with an explicit replan hint.
            if (iter > 0 && memory.shouldReplan) {
                messages.push({
                    role: 'user',
                    content: this._composeUserTurn(false,
                        `[REPLAN TRIGGER: ${memory.replanReason}] The environment changed. Reconsider whether your current approach is still optimal.`)
                });
                memory.shouldReplan = false;
                memory.replanReason = null;
            }

            const response = await this._callLLM(messages, iter);
            if (!response) return;
            const assistantMsg = response.choices?.[0]?.message;
            if (!assistantMsg) {
                console.log('[planner] empty response from LLM');
                return;
            }
            messages.push(assistantMsg);

            const toolCalls = assistantMsg.tool_calls || [];
            if (toolCalls.length === 0) {
                console.log(`[planner] iter ${iter+1}: model replied with text, nudging`);
                messages.push({
                    role: 'user',
                    content: 'You must call exactly one tool. Either pick a tool or call finish_objective.'
                });
                continue;
            }

            let finished = false;
            for (const tc of toolCalls) {
                const name = tc.function?.name;
                let args = {};
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}

                console.log(`[planner] iter ${iter+1}: → ${name}(${JSON.stringify(args)})`);
                const impl = this.toolImpls[name];
                let result;
                if (!impl) {
                    result = { ok: false, error: `unknown tool ${name}` };
                } else {
                    try { result = await impl(args); }
                    catch (err) { result = { ok: false, error: err.message }; }
                }
                console.log(`[planner]          ← ${truncate(JSON.stringify(result))}`);

                memory.recordToolCall(name, args, result);
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(result)
                });

                const sig = `${name}|${JSON.stringify(args)}|${result.ok ? 'ok' : 'err'}`;
                recentCalls.push({ key: sig, ok: !!result.ok });
                if (recentCalls.length > 6) recentCalls.shift();

                if (name === 'finish_objective' && result.ok) {
                    console.log(`[planner] objective complete: ${result.summary}`);
                    finished = true;
                }
            }
            if (finished) return;

            // Anti-loop guard.
            if (recentCalls.length >= 3) {
                const last3 = recentCalls.slice(-3);
                if (last3.every(c => c.key === last3[0].key)) {
                    if (!loopNudgeIssued) {
                        console.log('[planner] LOOP detected — injecting strategy nudge');
                        messages.push({
                            role: 'user',
                            content: 'You have called the same tool with the same arguments 3 times in a row with the same result. This is a loop. Either change strategy completely (try patrol_spawn_zone, ask_bdi, or move to a different area), or call finish_objective with a truthful summary.'
                        });
                        loopNudgeIssued = true;
                    } else {
                        console.log('[planner] LOOP persists — forcing exit');
                        memory.recordToolCall('_planner', { reason: 'loop_forced_exit' },
                            'Aborted by anti-loop guard.');
                        return;
                    }
                } else {
                    loopNudgeIssued = false;
                }
            }
        }
        console.log('[planner] max iterations reached without finish_objective');
    }

    async _callLLM(messages, iter) {
        const t0 = Date.now();
        console.log(`[planner] iter ${iter+1}: thinking (model=${this.model})...`);
        const hb = setInterval(() => {
            process.stdout.write(`\r[planner] iter ${iter+1}: thinking… ${Math.floor((Date.now()-t0)/1000)}s `);
        }, 1000);
        try {
            const completion = this.llmClient.chat.completions.create({
                model: this.model,
                messages,
                tools: this.openAITools,
                tool_choice: 'auto',
                temperature: 0.1
            });
            const response = await Promise.race([
                completion,
                new Promise((_, rej) => setTimeout(
                    () => rej(new Error(`LLM call exceeded ${this.llmTimeoutMs}ms timeout`)),
                    this.llmTimeoutMs))
            ]);
            clearInterval(hb); process.stdout.write('\n');
            console.log(`[planner] iter ${iter+1}: LLM responded in ${Math.floor((Date.now()-t0)/1000)}s`);
            return response;
        } catch (err) {
            clearInterval(hb); process.stdout.write('\n');
            const detail = [
                err.message,
                err.status ? `status=${err.status}` : null,
                err.code ? `code=${err.code}` : null,
                err.cause?.code ? `cause=${err.cause.code}` : null
            ].filter(Boolean).join(' ');
            console.log(`[planner] LLM call failed: ${detail}`);
            if (err.cause?.code === 'ENOTFOUND' || err.cause?.code === 'ECONNREFUSED') {
                console.log('[planner] hint: cannot reach LLM endpoint. Check Ollama / VPN.');
            }
            return null;
        }
    }

    _composeUserTurn(isFirst, replanNote) {
        const snapshot = this.memory.snapshot();
        const parts = [];
        if (isFirst) {
            parts.push(`OBJECTIVE: ${snapshot.objective}`);
            parts.push('Plan and execute step by step using exactly one tool per turn.');
        }
        if (replanNote) parts.push(replanNote);
        parts.push('MEMORY SNAPSHOT:');
        parts.push('```json');
        parts.push(JSON.stringify(snapshot, null, 2));
        parts.push('```');
        return parts.join('\n');
    }
}

function truncate(s, n = 220) {
    if (typeof s !== 'string') s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
}
