import { EVENT_TYPES } from "@proofbook/schema";

/**
 * The assertion expression grammar, validated at load time.
 *
 * This is deliberately a closed, tiny language: no eval, no I/O, no
 * user-defined functions, bounded in one pass. The crosswalk package
 * owns the grammar and the AST; the engine (stage 4) owns evaluation.
 * A crosswalk file with an unparseable expression is rejected at load,
 * never at evaluation time in someone's CI at 2am.
 *
 *   expression := call comparator?
 *   call       := fn '(' args ')'
 *   comparator := ('>=' | '<=' | '==' | '>' | '<') number
 *   selector   := EventType ('[' filter ']')?
 *   filter     := 'linked(' EventType ')' | raw
 */

export class ExpressionError extends Error {}

export type Arg =
  | { kind: "selector"; eventType: string; filter?: SelectorFilter }
  | { kind: "fields"; fields: string[] }
  | { kind: "ident"; name: string }
  | { kind: "number"; value: number };

export type SelectorFilter =
  | { kind: "linked"; eventType: string }
  | { kind: "raw"; text: string };

export interface ParsedExpression {
  source: string;
  fn: string;
  args: Arg[];
  comparator?: { op: ">=" | "<=" | "==" | ">" | "<"; value: number };
}

type ArgShape = "selector" | "fields" | "ident" | "number";

/** fn name → argument shapes, and whether a comparator is required. */
const SIGNATURES: Record<string, { args: ArgShape[]; comparator: "required" | "forbidden" }> = {
  coverage: { args: ["selector", "fields"], comparator: "required" },
  count: { args: ["selector"], comparator: "required" },
  ratio: { args: ["selector", "selector"], comparator: "required" },
  distinct: { args: ["selector", "ident"], comparator: "required" },
  percentile: { args: ["selector", "ident", "number"], comparator: "required" },
  within: { args: ["selector", "ident", "number"], comparator: "required" },
  exists: { args: ["selector"], comparator: "forbidden" },
  always: { args: ["selector", "fields"], comparator: "forbidden" },
  never: { args: ["selector"], comparator: "forbidden" },
  sequence: { args: ["selector", "selector"], comparator: "forbidden" },
  declared: { args: ["ident"], comparator: "forbidden" },
  config: { args: ["ident"], comparator: "forbidden" },
};

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

/** Split on top-level commas, respecting () and []. */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function parseSelector(text: string, source: string): Arg {
  const m = text.match(/^([A-Z]\w*)(?:\[(.*)\])?$/);
  if (!m) throw new ExpressionError(`invalid selector "${text}" in "${source}"`);
  const eventType = m[1]!;
  if (!EVENT_TYPE_SET.has(eventType)) {
    throw new ExpressionError(`unknown event type "${eventType}" in "${source}"`);
  }
  if (m[2] === undefined) return { kind: "selector", eventType };

  const filterText = m[2].trim();
  const linked = filterText.match(/^linked\((\w+)\)$/);
  if (linked) {
    const target = linked[1]!;
    if (!EVENT_TYPE_SET.has(target)) {
      throw new ExpressionError(`unknown event type "${target}" in linked() filter of "${source}"`);
    }
    return { kind: "selector", eventType, filter: { kind: "linked", eventType: target } };
  }
  return { kind: "selector", eventType, filter: { kind: "raw", text: filterText } };
}

function parseArg(text: string, shape: ArgShape, source: string): Arg {
  switch (shape) {
    case "fields": {
      const m = text.match(/^\[(.*)\]$/s);
      if (!m) throw new ExpressionError(`expected a [field, ...] list, got "${text}" in "${source}"`);
      const fields = splitArgs(m[1]!).map((f) => f.trim());
      if (fields.length === 0 || fields.some((f) => !/^[a-z_][\w.]*$/.test(f))) {
        throw new ExpressionError(`invalid field list "${text}" in "${source}"`);
      }
      return { kind: "fields", fields };
    }
    case "selector":
      return parseSelector(text, source);
    case "ident": {
      if (!/^[a-z_][\w.]*$/.test(text)) {
        throw new ExpressionError(`invalid identifier "${text}" in "${source}"`);
      }
      return { kind: "ident", name: text };
    }
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(`invalid number "${text}" in "${source}"`);
      }
      return { kind: "number", value };
    }
  }
}

export function parseExpression(source: string): ParsedExpression {
  const m = source
    .trim()
    .match(/^(\w+)\s*\((.*)\)\s*(?:(>=|<=|==|>|<)\s*([\d.]+))?$/s);
  if (!m) throw new ExpressionError(`unparseable expression "${source}"`);

  const [, fn, argText, op, threshold] = m;
  const signature = SIGNATURES[fn!];
  if (!signature) throw new ExpressionError(`unknown function "${fn}" in "${source}"`);

  if (op && signature.comparator === "forbidden") {
    throw new ExpressionError(`"${fn}" is boolean; a comparator is not allowed in "${source}"`);
  }
  if (!op && signature.comparator === "required") {
    throw new ExpressionError(`"${fn}" needs a comparator and threshold in "${source}"`);
  }

  const rawArgs = splitArgs(argText!);
  if (rawArgs.length !== signature.args.length) {
    throw new ExpressionError(
      `"${fn}" takes ${signature.args.length} argument(s), got ${rawArgs.length} in "${source}"`,
    );
  }
  const args = rawArgs.map((raw, i) => parseArg(raw, signature.args[i]!, source));

  const parsed: ParsedExpression = { source: source.trim(), fn: fn!, args };
  if (op) {
    const value = Number(threshold);
    if (!Number.isFinite(value)) {
      throw new ExpressionError(`invalid threshold "${threshold}" in "${source}"`);
    }
    parsed.comparator = { op: op as NonNullable<ParsedExpression["comparator"]>["op"], value };
  }
  return parsed;
}
