
import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { GameClient } from './agents/common/GameClient.js';
import { AsaProtocol } from './agents/common/AsaProtocol.js';
import { Pathfinder } from './agents/common/Pathfinder.js';
import { PddlPathfinder } from './agents/common/PddlPathfinder.js';
import { PddlDeliveryPlanner } from './agents/common/PddlDeliveryPlanner.js';
import { BdiAgent } from './agents/bdi/BdiAgent.js';

const USE_PDDL       = process.env.BDI_USE_PDDL === 'true';
const USE_PDDL_TASKS = process.env.BDI_USE_PDDL_TASKS === 'true';

const socket = DjsConnect();
const client = new GameClient(socket);
const asa    = new AsaProtocol(client);

let agent = null;
client.on('map', () => {
    if (agent) return;
    const planner = USE_PDDL
        ? new PddlPathfinder(client.state.map, { timeoutMs: 8000 })
        : new Pathfinder(client.state.map);
    const taskPlanner = USE_PDDL_TASKS
        ? new PddlDeliveryPlanner({ timeoutMs: 8000, maxParcels: 5 })
        : null;
    console.log(`[bdi-entry] motion planner: ${USE_PDDL ? 'PDDL (solver.planning.domains)' : 'A* (local)'}`
              + ` | task planner: ${USE_PDDL_TASKS ? 'PDDL logistics (pickup ordering)' : 'greedy'}`);
    agent = new BdiAgent({ client, asa, planner, taskPlanner });
    agent.start();
});

client.on('connect',    () => console.log('[bdi-entry] connected to game server'));
client.on('disconnect', () => console.log('[bdi-entry] disconnected, waiting for reconnect'));
