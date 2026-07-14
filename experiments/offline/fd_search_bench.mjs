// Confronto configurazioni di ricerca Fast Downward su mappa piena 29x29:
// astar(blind()) vs astar(lmcut()). Entrambe ottime; misura tempo e lunghezza.
// Run: node experiments/offline/fd_search_bench.mjs

import { FastDownwardPathfinder } from '../../agents/common/FastDownwardPathfinder.js';

const map = new Map();
for (let x = 0; x < 29; x++) for (let y = 0; y < 29; y++) map.set(`${x},${y}`, '3');

const RUNS = 3;
for (const cfg of ['astar(blind())', 'astar(lmcut())']) {
  process.env.FD_SEARCH = cfg;
  process.env.AGENT_INSTANCE = 'fdbench';
  const fd = new FastDownwardPathfinder(map);
  await fd.findPath({ x: 0, y: 0 }, { x: 28, y: 28 }, {}); // warm-up
  let total = 0, len = 0;
  for (let i = 0; i < RUNS; i++) {
    const t = Date.now();
    const p = await fd.findPath({ x: 0, y: 0 }, { x: 28, y: 28 }, {});
    total += Date.now() - t; len = p.length;
  }
  console.log(`${cfg}: avg ${Math.round(total / RUNS)}ms su ${RUNS} run, piano ${len} mosse`);
}
