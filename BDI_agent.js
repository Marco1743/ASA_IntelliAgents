// Agent A — the BDI agent. Plays normally and obeys L3 coordination directives /
// L1-L2 shares forwarded by the LLM agent (B) over the team layer.

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { GameClient } from './agents/common/GameClient.js';
import { Pathfinder } from './agents/common/Pathfinder.js';
import { FastDownwardPathfinder } from './agents/common/FastDownwardPathfinder.js';
import { PddlPathfinder } from './agents/common/PddlPathfinder.js';
import { Teamwork } from './agents/common/Teamwork.js';
import { BdiAgent } from './agents/bdi/BdiAgent.js';

const USE_PDDL = process.env.BDI_USE_PDDL === 'true';
const TEAM_SECRET = process.env.TEAM_SECRET || 'asa-team';

const socket = DjsConnect();
const client = new GameClient(socket);

client.on('connect',    () => console.log('[bdi] connected to server'));
client.on('disconnect', () => console.log('[bdi] disconnected, waiting for reconnect...'));

// PDDL_SOLVER: fd (local Fast Downward) | online (HTTP solver)
// PDDL_MODE:   background (A* drives, PDDL refines async) | primary (PDDL plans, A* fallback)
const astar = new Pathfinder(client.state.map);
const SOLVER = (process.env.PDDL_SOLVER || 'fd').toLowerCase();
const PDDL_MODE = (process.env.PDDL_MODE || 'background').toLowerCase();

let planner = astar, fallbackPlanner = null, pddlPlanner = null;
let pddlLabel = '';
if (USE_PDDL) {
    const pddl = SOLVER === 'online' ? new PddlPathfinder(client.state.map)
                                     : new FastDownwardPathfinder(client.state.map);
    const name = SOLVER === 'online' ? 'online API' : 'Fast Downward';
    if (PDDL_MODE === 'primary') { planner = pddl; fallbackPlanner = astar; pddlLabel = `PDDL ${name} (A* fallback)`; }
    else                         { pddlPlanner = pddl;                       pddlLabel = `A* (local) + PDDL background refine (${name})`; }
}
console.log(`[bdi] planner: ${USE_PDDL ? pddlLabel : 'A* (local)'}`);

const team = new Teamwork(client, { role: 'A', secret: TEAM_SECRET });
const notify = (state) => team.sendStatus(state);

const agent = new BdiAgent({ client, planner, fallbackPlanner, pddlPlanner,
                             shouldYieldGoal: (g) => team.shouldYieldGoal(g) });

client.on('msg', ({ fromId, fromName, msg, replyAck }) => { team.ingest(fromId, fromName, msg, replyAck); });

team.on('coord', ({ cmd, x, y, dist, role, handoff, parity }) => {
    if (cmd === 'rendezvous' || cmd === 'goto_wait') {
        const d = Number(dist);
        agent.setCoordination({ type: 'goto_wait', x: Number(x), y: Number(y), dist: Number.isFinite(d) ? d : 0 }, notify);
    } else if (cmd === 'hold') {
        agent.setCoordination({ type: 'hold' }, notify);
    } else if (cmd === 'red_light') {
        agent.setCoordination({ type: 'red_light', parity: parity || 'odd' }, notify);
    } else if (cmd === 'relay' && handoff) {
        agent.setCoordination({ type: 'relay', role: role || 'collector',
                                handoff: { x: Number(handoff.x), y: Number(handoff.y) } }, notify);
    } else if (cmd === 'release') {
        agent.clearCoordination();
    } else {
        console.log(`[bdi] unknown coordination cmd from teammate: ${cmd}`);
    }
});
team.on('signal', ({ name }) => { if (name === 'go' || name === 'release') agent.clearCoordination(); });

team.on('rule', ({ rule }) => { if (rule) agent.applyRule(rule); }); // adopt B's L2 rules
team.on('goal', ({ goal }) => { if (goal) agent.addMissionGoal(goal); }); // weigh B's L1 goals

agent.start();
team.start();
