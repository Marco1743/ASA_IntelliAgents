# `agents/` — project structure

The autonomous agents are split into a shared layer plus one folder per agent,
so Agent A (BDI) and Agent B (LLM) reuse the same world model and helpers
instead of duplicating them.

```
agents/
├── common/            shared by every agent (no BDI- or LLM-specific logic)
│   ├── geometry.js    DIRECTIONS, manhattan, getClosest, one-way tiles, MinHeap
│   ├── WorldState.js  sensed game state: me, map, parcels, agents, zones, config
│   ├── GameClient.js  SDK socket wrapper: keeps WorldState fresh, exposes actions,
│   │                  re-emits events (incl. inbound 'msg') so any agent subscribes
│   ├── Pathfinder.js     A* motion planner (the findPath contract)
│   ├── pddlModel.js      shared PDDL model: domain + problem builder
│   ├── FastDownwardPathfinder.js  PDDL via a LOCAL Fast Downward binary (default)
│   ├── PddlPathfinder.js PDDL via the online solver (kept for comparison)
│   └── Teamwork.js    L3 team layer: A↔B discovery, belief-share, directives
│
├── bdi/               Agent A — the BDI agent
│   ├── BdiAgent.js    control loop: sense → deliberate → select plan → act
│   ├── BdiBeliefs.js  agent-private memory: obstacles, blacklist, decay, congestion, metrics
│   ├── Intentions.js  option scoring: getBestParcel / getBestSpawnZone / shouldDeliverNow
│   ├── plans.js       plan library: PickupPlan / DeliverPlan / PatrolPlan / ExplorePlan
│   └── PlanExecutor.js executes one plan step (move/pickup/putdown) with retries
│
└── llm/               Agent B — the LLM agent (Challenge-2; Levels 1, 2 & 3)
    ├── LlmClient.js   OpenAI SDK → hosted LiteLLM endpoint (not local)
    ├── LlmMemory.js   LLM-memory: objective + live observations + active rules + history
    ├── LlmPlanner.js  LLM-Planner/Replanner: a ReAct loop (Thought/Action/Observation
    │                  /Decision) that reasons with tools and outputs a structured intent
    ├── LlmAgent.js    runs memory → planner → routes the decision (answer/goal/rule/coord)
    ├── Coordinator.js L3 orchestration: drives B's body + commands A, tracks readiness
    ├── tools.js       tools over the shared GameClient + Pathfinder (+ read-only catalog)
    ├── ruleParser.js  deterministic parser for canonical L2/L3 phrasings — SAFETY NET
    └── util.js        safeJsonParse
```

## How the BDI cycle maps to the code

| BDI stage            | Where it lives                                             |
|----------------------|------------------------------------------------------------|
| Sensing              | `common/GameClient.js` (socket → `WorldState`)             |
| Belief revision      | `GameClient._handleParcels/_handleAgents`; `BdiBeliefs.pruneStale`, parcel decay/expiry (`learnDecay`/`pruneExpiredParcels`), enemy congestion |
| Deliberation         | `BdiAgent._deliberate` (+ `Intentions.js`)                 |
| Intention revision   | `BdiAgent._deliberate` soft commitment (`_betterParcel`, race-loss, decay timing) |
| Select plan (library)| `bdi/plans.js` `selectPlan(intention)` → the applicable `Plan` |
| Means-end (planner)  | `Plan.build` → `BdiAgent._navigate` → `Pathfinder` / `PddlPathfinder` |
| Execution            | `bdi/PlanExecutor.js`                                      |

A run-time metrics line (`[bdi-metrics] score/pickups/deliveries/plans/racesLost`)
is printed every 30s (`BdiAgent._startMetricsTimer`) for validation and the report.

## PDDL planning (optional extension)

A* is **always** the primary planner so the agent never blocks. When
`BDI_USE_PDDL=true` a PDDL solver is wired as a **non-blocking background
refiner**:

- A* plans the route and the agent starts moving immediately.
- `BdiAgent._refineWithPddl` fires the PDDL solve for the same start→target in the
  background (one at a time, `_pddlBusy`). If it returns *before the agent has
  moved* and the agent is *still pursuing the same target*, its movement steps
  swap into the current plan (keeping the terminal `pick_up`/`put_down`/
  `relay_drop`). Otherwise the result is discarded. So the solver can never stall
  the loop (the freeze we hit calling the course solver synchronously).

**The solver is a LOCAL Fast Downward binary** (`PDDL_SOLVER=fd`, default),
exactly like the reference project — not the slow online API. Files:

- `common/pddlModel.js` — the shared model: `DOMAIN_STRING` + `buildProblem()`
  (one tile = one object, position `(at ?t)`, walkability/one-way tiles →
  directed `(adj-* ?from ?to)` facts, four move actions, goal `(at <target>)`,
  bounded to a box around start→target).
- `common/FastDownwardPathfinder.js` — writes the domain + problem to disk and
  shells out to `python fast-downward.py … --search "astar(blind())"`, then
  parses the plan file into directions. If the binary isn't built it returns
  `null` and the agent just uses A* — so the project always runs.
- `common/PddlPathfinder.js` — the original online (`onlineSolver`) solver, kept
  for comparison behind `PDDL_SOLVER=online`.

**Setup (one-time, local):** `npm run setup:pddl` clones Fast Downward into
`lib/downward/` and builds it (needs git, Python 3, and a C++ toolchain + CMake).
On **Windows**: install with `winget install Kitware.CMake` and
`winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait
--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`, then run
`npm run setup:pddl` **from a "Developer PowerShell for VS 2022"** so `cl`/`nmake`
are on PATH. (Running the agent afterwards only needs Python + the built binary —
no Developer shell.) Then run the BDI agent with `BDI_USE_PDDL=true`. Env knobs:
`PYTHON_CMD`, `DOWNWARD_PATH`, `FD_SEARCH`, `AGENT_INSTANCE` (see `.env.example`).

## Agent B — the LLM agent (`agents/llm/`)

Agent B is a separate player (its own `LLM_TOKEN`). It **plays the game normally
via the BDI core** (`BdiAgent`) — collect & deliver — which is the *sole*
controller of movement. On top of that, an LLM layer interprets special missions
and feeds them to the BDI. The LLM is **hosted**, reached with the `openai` SDK
pointed at LiteLLM (`LITELLM_BASE_URL` / `LITELLM_API_KEY` / `LLM_MODEL`) — not a
local model.

Key idea: a special mission is **not always a command**, and the LLM does **not**
drive the agent directly. For each mission the LLM runs the full loop —
**LlmMemory** (objective + live observations + active rules) → **LlmPlanner**, a
**ReAct loop** (`Thought / Action / Observation / Decision`) that reasons and may
call read-only tools (`calculate`, `get_map_info`, …) to gather facts — and
commits to a structured **decision** that `LlmAgent` routes:

- **answer** — reply to the sender (no movement); the LLM may have used the
  `calculate` tool to get the value.
- **goal** (Level 1, one-shot) — injected via `BdiAgent.addMissionGoal()`. The
  BDI deliberation weighs it as **one option among the parcels** (reward per
  step) and pursues it only if it wins — so *"is it worth it"* lives entirely in
  the BDI cost/benefit. Negative-payoff traps are dropped before injection.
  Removed once completed (`_completeMission`, which also replies to the sender).
- **rule** (Level 2, persistent) — applied via `BdiAgent.applyRule()` into
  `BdiBeliefs.constraints` and kept for the whole match (not consumed).
  **Rules accumulate**: a same-key rule (same stack size N, or same tile) updates
  in place while different ones coexist; `reward_filter` keeps the strictest cap.
  The rules:
  - `avoid_tile` → soft cost in `buildEnemyCostMap` (detour around it),
  - `reward_filter` → over-cap parcels score 0, so the agent **picks them up but
    holds them** (valuing them at the cap) and delivers them only once they've
    **decayed below the cap**. Delivery is **selective** (`deliverySet` +
    `putdown(ids)`): parcels already ≤ cap are dropped immediately so they can't
    expire, while still-over-cap ones are kept; `shouldDeliverNow` times the trip
    so the agent reaches the zone just as an over-cap parcel crosses the cap. (If
    rewards can't decay, over-cap parcels are simply never picked up.)
  - `delivery_zone_reward` (one or more bonus tiles) → `getBestDeliveryZone`
    picks the zone maximising net value `carriedValue × multiplier − distance`
    (the multiplier scales the whole payload, so a 5× zone is worth travelling
    for; 0× zones are avoided),
  - `delivery_stack` → collect up to full capacity, then `deliverySet` /
    `stackDeliveryCount` drop the right batch at the zone (bonus mult>1: a group
    of exactly N, the most valuable first, each in its own `putdown(ids)`;
    penalty mult<1: any size except N). **Several stack sizes coexist** — a 3→2×
    and a 5→0.3× rule are both active; only a *same-N* rule overwrites.

Selective put-down is the shared mechanism for reward_filter and delivery_stack:
`BdiBeliefs.deliverySet(state)` returns the exact parcel ids to drop in one
action (`null` = all, `[]` = none yet), and both the planned `put_down` and the
opportunistic reflex deliver successive groups while the agent stays on the zone.
- **coordination** (Level 3) — handed to the `Coordinator` (see below).

Both `missionGoals` and `constraints` are empty/no-op for Agent A, so the BDI
agent's behaviour is unchanged. Missions arrive from the game (`GameClient`
'msg' event, from the mission-agent) or from the terminal for manual testing.

**Team-sharing of L1/L2 (not just L3).** Only Agent B has an LLM, so it is the
sole interpreter. After it applies a goal/rule to its own BDI, it forwards the
result to Agent A over the team channel (`Teamwork.sendGoal` / `sendRule`), and A
adopts it (`addMissionGoal` / `applyRule`) — so the whole team plays by the same
strategy instead of only B reacting (mirrors the master→slave `LLM_UPDATE`
forwarding in the reference project). For a one-shot **goal**, both agents weigh
it but only the **closer one commits**: `BdiAgent._bestMissionGoal` consults
`Teamwork.shouldYieldGoal` (using the team-mate's broadcast position) and yields a
goal the team-mate is better placed for — ties broken by id, so exactly one agent
goes (no double-trip to the same tile). Agent A **still runs standalone**: with no
team-mate it never yields and never receives a share, playing as a normal BDI
agent (raw mission text from the chat is not team-tagged, so `ingest()` drops it).

## Level 3 — coordination between Agent A and Agent B

The PDF defines L3 as missions needing *"a communication mechanism between the
BDI agent and the LLM agent / the LLM agent and the game chat"*, with the LLM
agent coordinating with A *"based on requests from the mission-agent"*. So the
flow is: **mission-agent → B's LLM interprets → B commands A; A executes.**

- **`common/Teamwork.js`** is the shared channel over the game bus (`say`/`shout`
  /`onMsg`). Both players run one. They **discover** each other at runtime with a
  handshake tagged by a shared `TEAM_SECRET` (their server ids are only known
  once connected), then **exchange beliefs** (position / load / score) on a
  heartbeat. Every team message carries `_team:<secret>`, so `ingest()` consumes
  team traffic and lets real missions through to the LLM.
- **Team division is implicit.** Each agent senses the other and, via the normal
  competition heuristics (`raceMul` / `isRaceLost`), commits to the parcels it is
  closest to and yields the rest — i.e. *"the closest agent commits to the
  pickup"* — so the two naturally split the map without extra messaging.
- **L2 rules are team-wide.** When B's LLM applies a persistent rule, it forwards
  it to A over Teamwork (`sendRule` → A's `applyRule`), so the *whole* team adopts
  the same strategy. Without this, A would keep incurring the mission's penalties
  unaware of them (e.g. delivering 0-reward over-cap parcels, or crossing a
  forbidden tile and costing the team points).
- **Agent A** (`BDI_agent.js`) is a pure executor: it obeys coordination
  directives (`BdiAgent.setCoordination` → a `coord` intention that *overrides*
  normal deliberation: go-to-and-wait, or hold/freeze) and reports `ready`/
  `holding` back. `clearCoordination` resumes normal play.
- **Agent B** (`llm/Coordinator.js`) orchestrates: the LLM classifies the mission
  as `coordination` with a task (`rendezvous` / `red_light` / `relay`); the
  Coordinator drives B's *own* body **and** commands A, tracks both agents'
  readiness, and reports completion to the mission-agent.
- **Implemented (all three archetypes):**
  - `rendezvous` — both agents travel to within a distance of (x,y) and wait for
    each other (Coordinator detects both-ready, reports, then releases).
  - `red_light` — both agents go to their nearest odd/even row and freeze; a
    green-light cue from the mission-agent releases them. The cue is recognised
    by the LLM as a `resume` task (with a deterministic fallback), not just a
    fixed keyword, so varied phrasings ("green light", "you may move now") work.
  - `relay` — Agent A collects parcels and ferries them to a handoff tile (never
    delivering to a zone itself), Agent B waits there, picks them up and delivers,
    so every relayed parcel is picked up by one agent and delivered by the other.

**Scope:** Challenge-2 **Levels 1, 2 & 3** implemented.

## Entry points

- `BDI_agent.js` — Agent A (BDI). `npm start` / `npm run bdi`.
- `LLM_agent.js` — Agent B (LLM). `npm run llm` (needs `LLM_TOKEN` + `LITELLM_*`).
