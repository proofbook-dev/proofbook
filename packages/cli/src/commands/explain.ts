import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { CAPABILITY_TOPIC } from "../transcript.js";
import type { Log } from "../log.js";

/**
 * `proof explain <topic>`: the bridge from a coverage gap to the
 * engineering task that closes it. Each topic says what the capability
 * is, exactly how to emit it, and which controls it unlocks, computed
 * from the loaded crosswalk so the list can never drift.
 */

interface Topic {
  capability: string;
  what: string;
  how: string[];
}

const TOPICS: Record<string, Topic> = {
  "human-checkpoints": {
    capability: "human_oversight",
    what:
      "Records of a human approving, reviewing, overriding or aborting an agent's\n" +
      "action. No OTel convention exists for these, so Proofbook defines extension\n" +
      "attributes; any span carrying them counts.",
    how: [
      "Emit a span at each approval gate with these attributes:",
      "",
      '  span.setAttribute("proofbook.human_checkpoint.type", "approval");   // approval | review | override | abort',
      '  span.setAttribute("proofbook.human_checkpoint.decision", decision); // e.g. "approved"',
      '  span.setAttribute("proofbook.human_checkpoint.actor_ref", sha256(actorId)); // digest, never the identity',
      "",
      "One attribute on one span per gate is enough to move a control from",
      "unevaluable to evidenced.",
    ],
  },
  "content-digests": {
    capability: "content_integrity",
    what:
      "Prompts and completions referenced by sha256 digest, proving inputs and\n" +
      "outputs are traceable without ever storing content.",
    how: [
      "Enable content capture on your instrumentation; Proofbook hashes it on",
      "ingest and drops the plaintext:",
      "",
      "  gen_ai.prompt / gen_ai.completion attributes on model-call spans",
      "",
      "Most SDK instrumentations have a capture flag (e.g. traceloop:",
      "TRACELOOP_TRACE_CONTENT=true). Digests only ever leave the machine.",
    ],
  },
  "token-counts": {
    capability: "token_accounting",
    what: "Input and output token counts on model calls; resource accounting evidence.",
    how: [
      "  gen_ai.usage.input_tokens / gen_ai.usage.output_tokens",
      "",
      "Emitted automatically by most GenAI instrumentations at 1.27+.",
    ],
  },
  "model-identity": {
    capability: "model_identity",
    what: "Which provider and model processed each call.",
    how: [
      '  gen_ai.system (e.g. "anthropic") and gen_ai.request.model / gen_ai.response.model',
    ],
  },
  "agent-lifecycle": {
    capability: "agent_lifecycle",
    what: "A complete start/end record per agent execution, with an agent identity.",
    how: [
      '  gen_ai.operation.name = "invoke_agent" with gen_ai.agent.id, on a span with an end time',
    ],
  },
  "tool-calls": {
    capability: "tool_invocation",
    what: "External actions the agent took, with tool identity and outcome.",
    how: [
      '  gen_ai.operation.name = "execute_tool" with gen_ai.tool.name; span status carries the outcome',
    ],
  },
  "span-coverage": {
    capability: "span_coverage",
    what: "The share of your spans that map onto the event model at all.",
    how: [
      "Unmapped spans are listed in the report appendix. If your emitter uses",
      "custom attributes, a ~20-line mapping YAML teaches the normaliser:",
      "",
      "  PROOFBOOK_GENERATIONS=./my-emitter.yaml proof report",
    ],
  },
};

const ALIASES: Record<string, string> = {
  "human-oversight": "human-checkpoints",
  oversight: "human-checkpoints",
  content: "content-digests",
  tokens: "token-counts",
  tools: "tool-calls",
};

export async function explainCommand(topicArg: string | undefined, log: Log): Promise<number> {
  const key = topicArg ? (TOPICS[topicArg] ? topicArg : ALIASES[topicArg]) : undefined;
  if (!key || !TOPICS[key]) {
    log("Usage: proof explain <topic>");
    log("");
    for (const [name, t] of Object.entries(TOPICS)) {
      log(`  ${name.padEnd(18)} ${t.what.split("\n")[0]}`);
    }
    return topicArg ? 1 : 0;
  }
  const topic = TOPICS[key]!;
  log(`${key}`);
  log("");
  log(topic.what);
  log("");
  log("How to emit it:");
  for (const line of topic.how) log(`  ${line}`);

  const crosswalks = [...(await loadCrosswalkDir()).values()];
  const unlocked: { id: string; title: string; framework: string }[] = [];
  for (const cw of crosswalks) {
    for (const control of cw.doc.controls) {
      if (
        control.assertions.some(
          (a) => a.source_class === "observed" && a.capability === topic.capability,
        )
      ) {
        unlocked.push({ id: control.id, title: control.title, framework: cw.doc.framework });
      }
    }
  }
  if (unlocked.length > 0) {
    log("");
    log(`Controls this evidence backs (${unlocked.length}):`);
    for (const c of unlocked) log(`  ${c.id.padEnd(34)} ${c.title}`);
  }
  return 0;
}

export { CAPABILITY_TOPIC };
