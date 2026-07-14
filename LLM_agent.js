// agent B (llm)

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { GameClient } from './agents/common/GameClient.js';
import { Pathfinder } from './agents/common/Pathfinder.js';
import { Teamwork } from './agents/common/Teamwork.js';
import { BdiAgent } from './agents/bdi/BdiAgent.js';
import { LlmClient } from './agents/llm/LlmClient.js';
import { LlmAgent } from './agents/llm/LlmAgent.js';
import { Coordinator } from './agents/llm/Coordinator.js';

const token = process.env.LLM_TOKEN;
if (!token) { console.error('Missing LLM_TOKEN in .env (Agent B needs its own player token).'); process.exit(1); }
if (!process.env.LITELLM_API_KEY) { console.error('Missing LITELLM_API_KEY in .env.'); process.exit(1); }
const TEAM_SECRET = process.env.TEAM_SECRET || 'asa-team';

const socket = DjsConnect(process.env.HOST, token);
const client = new GameClient(socket);
const pathfinder = new Pathfinder(client.state.map);

const team = new Teamwork(client, { role: 'B', secret: TEAM_SECRET });
const bdi = new BdiAgent({ client, planner: pathfinder,
                           shouldYieldGoal: (g) => team.shouldYieldGoal(g) });
const llm = new LlmClient();
const coordinator = new Coordinator({ client, bdi, team });
const agent = new LlmAgent({ client, bdi, llm, coordinator, team });

client.on('connect',    () => console.log('[llm] connected to game'));
client.on('disconnect', () => console.log('[llm] disconnected, waiting for reconnect...'));

// team filter + missions
client.on('msg', ({ fromId, fromName, msg, replyAck }) => {
    if (team.ingest(fromId, fromName, msg, replyAck)) return;
    agent.handleMessage(msg, fromId).catch(err => console.log(`[llm] mission error: ${err.message}`));
});

bdi.start();
team.start();

// manual mission console
const rl = readline.createInterface({ input, output });
await client.ready();
console.log('[llm] ready. Agent B is playing; type a mission (or "exit"). Missions also arrive from the game.');

while (true) {
    const line = (await rl.question('mission> ')).trim();
    if (line.toLowerCase() === 'exit') break;
    if (line) await agent.handleMessage(line, null).catch(err => console.log(`[llm] mission error: ${err.message}`));
}
rl.close();
