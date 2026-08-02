import { loadBundledGenerations, type GenerationRules, type MatchSpec } from "@proofbook/normalize";

/**
 * Emission signals: string literals whose presence in source code
 * indicates that code emits telemetry mapping to a given event type.
 *
 * Two sources, in order of authority:
 *
 * 1. The generation rule files. They are already the ground truth for
 *    "which telemetry becomes which event", so the attribute keys and
 *    operation names they match on are, symmetrically, the strings a
 *    hand-instrumented code site must contain to emit that event.
 *
 * 2. A small curated table of auto-instrumentation packages. Code that
 *    registers OpenAIInstrumentor never writes gen_ai.* attributes by
 *    hand; the SDK does. The package name in source is the call site.
 *
 * Precision beats recall throughout. Only distinctive literals (dotted
 * attribute keys, snake_case operation names, package names) become
 * signals; a generic word would record phantom call sites, and a
 * phantom site that later disappears is exactly the false alarm the
 * gate must never raise. A missed signal merely leaves a control
 * unenforced, which is the quiet failure mode we chose.
 */

export interface SignalTable {
  /** literal → event types it evidences. */
  literals: Map<string, Set<string>>;
}

/** Auto-instrumentation packages and the event types their spans map to. */
const CURATED: Record<string, string[]> = {
  OpenAIInstrumentor: ["ModelCall"],
  AnthropicInstrumentor: ["ModelCall"],
  BedrockInstrumentor: ["ModelCall"],
  MistralAiInstrumentor: ["ModelCall"],
  OpenAIInstrumentation: ["ModelCall"],
  AnthropicInstrumentation: ["ModelCall"],
  LangChainInstrumentor: ["ModelCall", "ToolCall"],
  LangGraphInstrumentor: ["AgentRun", "ToolCall"],
  CrewAIInstrumentor: ["AgentRun", "ToolCall"],
  "@traceloop/node-server-sdk": ["ModelCall"],
  "traceloop-sdk": ["ModelCall"],
  "@arizeai/openinference-instrumentation-openai": ["ModelCall"],
  "@arizeai/openinference-instrumentation-langchain": ["ModelCall", "ToolCall"],
};

/** Distinctive enough to be a signal: dotted keys and snake_case names. */
function distinctive(literal: string): boolean {
  return literal.includes(".") || literal.includes("_");
}

function add(table: SignalTable, literal: string, eventType: string): void {
  if (!distinctive(literal)) return;
  let types = table.literals.get(literal);
  if (!types) {
    types = new Set();
    table.literals.set(literal, types);
  }
  types.add(eventType);
}

/** Leading literal of an anchored regex, e.g. "^execute_tool\\s+(.+)$" → "execute_tool". */
function regexPrefix(source: string): string | undefined {
  const m = source.match(/^\^([A-Za-z0-9_.]+)/);
  return m?.[1];
}

function addMatchSignals(table: SignalTable, m: MatchSpec, eventType: string): void {
  for (const sub of m.any ?? []) addMatchSignals(table, sub, eventType);
  for (const [key, values] of Object.entries(m.attr_in ?? {})) {
    add(table, key, eventType);
    for (const value of values) add(table, value, eventType);
  }
  for (const key of m.attr_present ?? []) add(table, key, eventType);
  if (m.name_regex) {
    const prefix = regexPrefix(m.name_regex);
    if (prefix) add(table, prefix, eventType);
  }
}

export function buildSignalTable(rulesets: GenerationRules[]): SignalTable {
  const table: SignalTable = { literals: new Map() };

  for (const rules of rulesets) {
    for (const mapping of rules.mappings) {
      addMatchSignals(table, mapping.match, mapping.event);
      for (const ex of [
        ...Object.values(mapping.fields),
        ...Object.values(mapping.content_refs),
      ]) {
        if (ex.attr) add(table, ex.attr, mapping.event);
        for (const key of ex.attr_first ?? []) add(table, key, mapping.event);
        if (ex.attr_indexed) add(table, ex.attr_indexed.split(".{i}")[0]!, mapping.event);
        if (ex.from_span_name) {
          const prefix = regexPrefix(ex.from_span_name);
          if (prefix) add(table, prefix, mapping.event);
        }
      }
    }
  }

  for (const [literal, types] of Object.entries(CURATED)) {
    for (const t of types) add(table, literal, t);
  }

  return table;
}

/** The default table: every bundled telemetry generation plus the curated set. */
export async function loadSignalTable(): Promise<SignalTable> {
  return buildSignalTable(await loadBundledGenerations());
}
