// Aggrega i log dei benchmark in experiments/raw/bench_summary.json
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = join(dirname(fileURLToPath(import.meta.url)), 'raw');
const runs = [];

for (const f of readdirSync(RAW).filter(f => /^agent_.+_(astar|pddlbg|pddlpri)\.log$/.test(f))) {
  const [, map, mode] = f.match(/^agent_(.+)_(astar|pddlbg|pddlpri)\.log$/);
  const log = readFileSync(join(RAW, f), 'utf8');
  const metrics = [...log.matchAll(/\[bdi-metrics\] score=(\d+) pickups=(\d+) deliveries=(\d+) plans=(\d+) racesLost=(\d+) uptime=(\d+)s/g)];
  const last = metrics.at(-1);
  const run = { map, mode, file: f };
  if (last) Object.assign(run, { score: +last[1], pickups: +last[2], deliveries: +last[3], plans: +last[4], racesLost: +last[5], uptime: +last[6] });
  if (mode !== 'astar') {
    const solves = [...log.matchAll(/\[fd\] solved .*?: (\d+) moves in (\d+)ms/g)];
    const times = solves.map(m => +m[2]);
    run.fd = {
      solves: solves.length,
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      minMs: times.length ? Math.min(...times) : null,
      maxMs: times.length ? Math.max(...times) : null,
      refinedApplied: (log.match(/PDDL refined/g) || []).length,
      noPath: (log.match(/\[fd\] no path|timed out/g) || []).length,
      fallbackToAstar: (log.match(/used fallback \(A\*\)/g) || []).length
    };
  }
  runs.push(run);
}

runs.sort((a, b) => a.map.localeCompare(b.map) || a.mode.localeCompare(b.mode));
writeFileSync(join(RAW, 'bench_summary.json'), JSON.stringify(runs, null, 2));

// tabella leggibile
const pad = (s, n) => String(s ?? '-').padEnd(n);
console.log(pad('map', 9), pad('mode', 8), pad('score', 7), pad('pick', 6), pad('deliv', 6), pad('plans', 6), pad('fd#', 5), pad('fdAvg', 7), pad('refined', 8), pad('fdFail', 6));
for (const r of runs)
  console.log(pad(r.map, 9), pad(r.mode, 8), pad(r.score, 7), pad(r.pickups, 6), pad(r.deliveries, 6), pad(r.plans, 6),
    pad(r.fd?.solves, 5), pad(r.fd ? r.fd.avgMs + 'ms' : '-', 7), pad(r.fd?.refinedApplied, 8), pad(r.fd?.noPath, 6));
