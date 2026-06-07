
import { LlmMemory } from './LlmMemory.js';
import { makeTools } from './tools.js';
import { Planner } from './Planner.js';
import { BdiAgent } from '../bdi/BdiAgent.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class LlmAgent {

    constructor({ client, asa, llmClient, model }) {
        this.client    = client;
        this.asa       = asa;
        this.llmClient = llmClient;
        this.model     = model;

        this.memory = new LlmMemory(client);
        this.tools  = makeTools({ client, memory: this.memory, asa });

        this._runningPlanner = null;
        this.bdi             = null;

        asa.on('message', (parsed) => this.memory.pushInbox(parsed));

        asa.on('plain-text', ({ text, fromId, fromName }) => {
            console.log(`\n[llm-agent] new objective via game chat from ${fromName} (${fromId}): "${text}"`);
            this.dispatchObjective(text, { id: fromId, name: fromName });
        });
    }

    async ready() {
        await this.client.ready();
    }

    startStandardLoop() {
        const build = () => {
            if (this.bdi) return;
            this.bdi = new BdiAgent({ client: this.client, asa: this.asa });
            this.bdi.start();
            console.log('[llm-agent] embedded BDI baseline started (controls the LLM character when idle)');
        };
        if (this.client.state.map && this.client.state.map.size > 0) build();
        else this.client.once('map', build);
    }

    _pauseBdi(reason) {
        if (!this.bdi) return;
        this.bdi.beliefs.constraints.pauseUntilResume = true;
        this.bdi.beliefs.currentPlan = null;
        console.log(`[llm-agent] BDI baseline paused (${reason})`);
    }

    _resumeBdi() {
        if (!this.bdi) return;
        this.bdi.beliefs.constraints.pauseUntilResume = false;
        console.log('[llm-agent] BDI baseline resumed');
    }

    async dispatchObjective(text, sender = null) {
        if (!text) return;
        console.log(`\n=== NEW OBJECTIVE${sender ? ` from ${sender.name || sender.id}` : ''}: ${text} ===`);
        this.memory.setObjective(text, sender);

        if (this._runningPlanner) {

            return;
        }

        this._pauseBdi('special mission incoming');
        await sleep(120);

        const planner = new Planner({
            llmClient:   this.llmClient,
            model:       this.model,
            memory:      this.memory,
            tools:       this.tools,
            asa:         this.asa,
            maxIterations: 12
        });
        this._runningPlanner = planner.run().finally(() => {
            this._runningPlanner = null;
            this._resumeBdi();
        });
    }

    snapshot() { return this.memory.snapshot(); }
}
