// LlmAgent — wires together GameClient, AsaProtocol, LlmMemory, tool catalog
// and Planner. Owns the objective dispatch logic so an external entry point
// can stay as small as 30 lines.

import { LlmMemory } from './LlmMemory.js';
import { getOpenAITools, makeToolImpls } from './tools.js';
import { Planner } from './Planner.js';

export class LlmAgent {

    constructor({ client, asa, llmClient, model }) {
        this.client    = client;
        this.asa       = asa;
        this.llmClient = llmClient;
        this.model     = model;

        this.memory      = new LlmMemory(client);
        this.toolImpls   = makeToolImpls({ client, memory: this.memory, asa });
        this.openAITools = getOpenAITools();

        this._runningPlanner = null;

        // Forward structured BDI messages into the memory inbox.
        asa.on('message', (parsed) => this.memory.pushInbox(parsed));

        // Plain-text shouts from the game chat become natural-language objectives.
        asa.on('plain-text', ({ text, fromId, fromName }) => {
            console.log(`\n[llm-agent] new objective via game chat from ${fromName} (${fromId}): "${text}"`);
            this.dispatchObjective(text);
        });
    }

    /** Wait until both the game state and the runtime are ready. */
    async ready() {
        await this.client.ready();
    }

    /** Set a new natural-language objective and start (or replan) the planner. */
    async dispatchObjective(text) {
        if (!text) return;
        console.log(`\n=== NEW OBJECTIVE: ${text} ===`);
        this.memory.setObjective(text);

        if (this._runningPlanner) {
            // The running loop will pick up the new objective via shouldReplan.
            return;
        }
        const planner = new Planner({
            llmClient: this.llmClient,
            model: this.model,
            memory: this.memory,
            toolImpls: this.toolImpls,
            openAITools: this.openAITools,
            maxIterations: 30
        });
        this._runningPlanner = planner.run().finally(() => { this._runningPlanner = null; });
    }

    /** Snapshot of memory for debug/observability. */
    snapshot() { return this.memory.snapshot(); }
}
