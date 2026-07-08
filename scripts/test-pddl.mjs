// Standalone PDDL check (no game server): npm run test:pddl
// PDDL_SOLVER=online tests the online solver instead of local Fast Downward.

import 'dotenv/config';
import { FastDownwardPathfinder } from '../agents/common/FastDownwardPathfinder.js';
import { PddlPathfinder } from '../agents/common/PddlPathfinder.js';

// 11x3 grid, all walkable except the delivery tile at (0,1)
const map = new Map();
for (let x = 0; x < 11; x++) for (let y = 0; y < 3; y++) {
    map.set(`${x},${y}`, (x === 0 && y === 1) ? '2' : '3');
}

const solver = (process.env.PDDL_SOLVER || 'fd').toLowerCase();
const pf = solver === 'online' ? new PddlPathfinder(map) : new FastDownwardPathfinder(map);
console.log(`solver: ${solver === 'online' ? 'online (planning.domains)' : 'Fast Downward (local)'}`);

const t = Date.now();
const path = await pf.findPath({ x: 0, y: 1 }, { x: 8, y: 1 }, {});
console.log(`\nPDDL path (0,1) -> (8,1) in ${Date.now() - t}ms:`);
console.log('  ', path
    ? JSON.stringify(path) + '   (expected 8x "right")'
    : 'NO PATH (solver not built/unreachable — in the agent, A* takes over)');
