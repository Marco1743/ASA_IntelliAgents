import { safeJsonParse } from './util.js';
import { TOOL_CATALOG, execTool } from './tools.js';

export const PLANNER_PROMPT = `
You are the reasoning core of an autonomous agent (Agent B) playing DeliverooJS,
a grid game where points come from picking up parcels and delivering them in
delivery zones. A separate BDI controller does the low-level driving; YOUR job is
to interpret a "special mission" written in natural language and decide what it
means for the agent.

A mission is NOT always a command — it is often an optional incentive or a
persistent scoring RULE. Reason about it using the tools when you need a fact
(e.g. compute coordinates, or find the leftmost delivery zone), then commit to a
single DECISION. You do NOT move the agent.

Tools you may call (read-only):
${TOOL_CATALOG.map(t => '- ' + t).join('\n')}

STRICT OUTPUT FORMAT — exactly one per message:

  Thought: <brief reasoning>
  Action: <tool name>
  Action Input: <argument>

or, when you have enough information:

  Thought: <brief reasoning>
  Decision: <one-line JSON, see below>

Decision JSON — pick one "kind":
- answer  (a question/computation): { "kind":"answer", "summary":"...", "effect": { "text":"<the answer>" } }
- goal    (a ONE-SHOT action with a payoff to weigh; ignore it if the payoff is
          negative): { "kind":"goal", "summary":"...", "effect": { "goal":"goto|drop_at|pickup_at", "x":<int|null>, "y":<int|null>, "where":"leftmost|rightmost|topmost|bottommost|null", "reward":<int, may be negative> } }
- rule    (a PERSISTENT/standing scoring rule — "every time", "stacks of N",
          "do not …"): { "kind":"rule", "summary":"...", "effect": { ...one of:
            {"rule":"delivery_stack","n":<int>,"multiplier":<number>}
            {"rule":"delivery_zone_reward","tiles":[[x,y],...],"multiplier":<number>}
            {"rule":"avoid_tile","tiles":[[x,y],...],"penalty":<int>}
            {"rule":"reward_filter","maxReward":<int>} } }
- coordination (a MULTI-AGENT mission: "both agents", "each other", a relay
          between the two of you, or a "wait for our message" red-light/green-light):
          { "kind":"coordination", "summary":"...", "effect": { ...one of:
            {"task":"rendezvous","x":<int>,"y":<int>,"dist":<int>,"reward":<int>}   // both meet near (x,y) and wait
            {"task":"red_light","parity":"odd|even","reward":<int>}                 // go to an odd/even row, wait for the 'go' signal
            {"task":"relay","reward":<int>}                                         // one picks up, the other delivers
            {"task":"resume"} } }                                                   // a "go"/"green light"/"you may move now" release after a red light
- ignore  (not understandable / worthless): { "kind":"ignore", "summary":"...", "effect": {} }

Rules of thumb:
- Resolve arithmetic in coordinates with the calculate tool (e.g. "x=4*2" -> 8).
- For "the leftmost tile" use get_map_info; a DROP mission means a delivery tile.
- A single imperative action ("move to X for +N", "drop a package in Y for +N")
  is a one-shot goal; "every time / each / stacks of N / do not …" is a rule.
- A mission that talks about BOTH agents, meeting "each other", a hand-off/relay
  between the two of you, or waiting for a "go" message is a coordination task.
- Keep the payoff sign on goals. Output only ONE Action or ONE Decision per turn.
`.trim();

// ReAct loop: the LLM reasons, optionally calls read-only tools, then commits to a
// structured decision { kind, summary, effect }. Returns the decision or null.
export class LlmPlanner {

    constructor(llm, client, { maxIterations = 6 } = {}) {
        this.llm = llm;
        this.client = client;
        this.maxIterations = maxIterations;
    }

    async plan(mission, context = {}) {
        const messages = [
            { role: 'system', content: PLANNER_PROMPT },
            { role: 'user', content:
                `Mission:\n${mission}\n\n` +
                `Current context (observations + recent missions):\n${JSON.stringify(context)}` }
        ];

        for (let i = 0; i < this.maxIterations; i++) {
            let out;
            try {
                out = await this.llm.chat(messages, { temperature: 0 });
            } catch (err) {
                console.log(`[llm-planner] LLM call failed: ${err.message}`);
                return null;
            }
            messages.push({ role: 'assistant', content: out });

            const action = extractAction(out);
            const decisionText = extractDecision(out);

            if (action && !decisionText) {
                const obs = execTool(action.action, action.actionInput, this.client.state);
                console.log(`[llm-planner] ${action.action}(${action.actionInput}) -> ${obs}`);
                messages.push({ role: 'user', content:
                    `Observation: ${obs}\nContinue: another Action if you need more, otherwise output your Decision.` });
                continue;
            }

            const decision = decisionText && safeJsonParse(decisionText);
            if (decision && decision.kind) {
                decision.effect = decision.effect || {};
                return decision;
            }

            messages.push({ role: 'user', content:
                'Invalid format. Output exactly one Action (with Action Input) or one Decision as JSON.' });
        }
        return null;
    }
}

function extractAction(text) {
    const a = text.match(/^Action:\s*(.+)$/im);
    const inp = text.match(/^Action Input:\s*(.+)$/im);
    if (!a || !inp) return null;
    return { action: a[1].trim(), actionInput: inp[1].trim() };
}

function extractDecision(text) {
    const m = text.match(/^Decision:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}
