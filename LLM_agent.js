// LLM agent entry point. All logic lives under agents/.

import 'dotenv/config';
import readline from 'node:readline';
import OpenAI from 'openai';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { GameClient } from './agents/common/GameClient.js';
import { AsaProtocol } from './agents/common/AsaProtocol.js';
import { LlmAgent } from './agents/llm/LlmAgent.js';
import { ensureOllama } from './agents/llm/runtime.js';

// ---------------------------------------------------------------------------
// LLM endpoint selection.
//   LLM_LOCAL = true  -> Ollama at 127.0.0.1:11434 (auto-bootstrapped here)
//   LLM_LOCAL = false -> https://llm.bears.disi.unitn.it/v1 (requires VPN)
// ---------------------------------------------------------------------------
const LLM_LOCAL = true;

const LOCAL_PROFILE = {
    ollamaHost: 'http://127.0.0.1:11434',
    apiKey:     'ollama',           // Ollama ignores the key but the SDK requires non-empty
    model:      'qwen2.5:7b'        // override with $env:OLLAMA_MODEL
};
const REMOTE_PROFILE = {
    baseURL: 'https://llm.bears.disi.unitn.it/v1',
    apiKey:  process.env.LITELLM_API_KEY || '',
    model:   'llama-3.3-70b-lmstudio'
};

if (!LLM_LOCAL && !REMOTE_PROFILE.apiKey) {
    console.error('FATAL: LITELLM_API_KEY missing for remote profile.');
    process.exit(1);
}

async function makeLlmClient() {
    if (LLM_LOCAL) {
        const wantedModel = process.env.OLLAMA_MODEL || LOCAL_PROFILE.model;
        const ollamaHost  = process.env.OLLAMA_HOST  || LOCAL_PROFILE.ollamaHost;
        const { openaiBaseURL, model } = await ensureOllama({ host: ollamaHost, model: wantedModel });
        console.log(`[llm-entry] LLM ready (LOCAL/Ollama) | endpoint: ${openaiBaseURL} | model: ${model}`);
        return { llmClient: new OpenAI({ baseURL: openaiBaseURL, apiKey: LOCAL_PROFILE.apiKey }), model };
    }
    const baseURL = process.env.LITELLM_BASE_URL || REMOTE_PROFILE.baseURL;
    const model   = process.env.LLM_MODEL || REMOTE_PROFILE.model;
    try {
        const u = new URL(baseURL);
        const resp = await fetch(`${u.origin}${u.pathname.replace(/\/$/, '')}/models`, {
            method: 'GET', headers: { Authorization: `Bearer ${REMOTE_PROFILE.apiKey}` }
        });
        console.log(`[llm-entry] LLM ready (REMOTE-unitn) | endpoint: ${baseURL} | model: ${model} | HTTP ${resp.status}`);
    } catch (err) {
        const code = err.cause?.code || err.code || err.message;
        console.error(`[llm-entry] FATAL: cannot reach remote LLM (${code}).`);
        console.error('[llm-entry] Connect the unitn VPN or set LLM_LOCAL=true.');
        process.exit(1);
    }
    return { llmClient: new OpenAI({ baseURL, apiKey: REMOTE_PROFILE.apiKey }), model };
}

// ---------------------------------------------------------------------------
// Connect socket + bootstrap LLM in parallel.
// ---------------------------------------------------------------------------
const socket = DjsConnect();
const client = new GameClient(socket);
const asa    = new AsaProtocol(client);

const cliObjective = process.argv.slice(2).join(' ').trim();
let pendingObjective = cliObjective || null;
let agent = null;

(async () => {
    const { llmClient, model } = await makeLlmClient();
    agent = new LlmAgent({ client, asa, llmClient, model });
    await agent.ready();
    console.log('[llm-entry] game state ready.');

    if (pendingObjective) {
        const o = pendingObjective; pendingObjective = null;
        agent.dispatchObjective(o);
    } else {
        console.log('[llm-entry] type an objective and press enter (or pass one as CLI arg, or shout from the game).');
    }
})();

// Interactive stdin objectives.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === 'quit' || text === 'exit') { rl.close(); process.exit(0); }
    if (text === 'status') {
        if (agent) console.log(JSON.stringify(agent.snapshot(), null, 2));
        else console.log('[llm-entry] agent not ready yet');
        return;
    }
    if (!agent) { pendingObjective = text; console.log('[llm-entry] queued'); return; }
    agent.dispatchObjective(text);
});
