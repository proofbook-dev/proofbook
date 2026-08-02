import { parseExpression, type Arg, type LoadedCrosswalk } from "@proofbook/crosswalk";

/**
 * Control → event types. Derived from the same parsed expressions the
 * engine evaluates, so the gate and the evaluator can never disagree
 * about what telemetry a control consumes.
 *
 * Only `observed` assertions contribute: declared and configured
 * assertions are satisfied by documents and settings, and no code
 * change can regress them. A control with no observed event types is
 * simply outside the gate's jurisdiction.
 */

export interface ControlRequirement {
  control_id: string;
  framework: string;
  title: string;
  event_types: string[];
}

function selectorTypes(args: Arg[], into: Set<string>): void {
  for (const arg of args) {
    if (arg.kind !== "selector") continue;
    into.add(arg.eventType);
    if (arg.filter?.kind === "linked") into.add(arg.filter.eventType);
  }
}

export function controlRequirements(crosswalks: LoadedCrosswalk[]): ControlRequirement[] {
  const requirements: ControlRequirement[] = [];
  for (const cw of crosswalks) {
    for (const control of cw.doc.controls) {
      const types = new Set<string>();
      for (const assertion of control.assertions) {
        if (assertion.source_class !== "observed") continue;
        selectorTypes(parseExpression(assertion.expression).args, types);
        if (assertion.partial_expression !== undefined) {
          selectorTypes(parseExpression(assertion.partial_expression).args, types);
        }
      }
      requirements.push({
        control_id: control.id,
        framework: cw.doc.framework,
        title: control.title,
        event_types: [...types].sort(),
      });
    }
  }
  return requirements.sort((a, b) => (a.control_id < b.control_id ? -1 : 1));
}
