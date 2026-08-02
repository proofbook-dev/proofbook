import type { LockFile } from "./lock.js";
import type { Site, SiteIndex } from "./scan.js";

/**
 * The comparison. One rule, applied per control per event type:
 *
 *   regression := the lock records at least one emitting site for an
 *   event type this control needs, and the current tree has zero.
 *
 * Zero, not fewer. Partial reduction never fires: a team that removes
 * three of four model-call sites still emits model calls, and a gate
 * that complains anyway gets `--skip`ed within a week and protects
 * nothing thereafter. Under-reporting is the designed failure mode.
 */

export interface Regression {
  control_id: string;
  framework: string;
  title: string;
  event_type: string;
  /** The sites the lock knew about; every one is gone from the tree. */
  lost_sites: Site[];
}

export interface Unenforced {
  control_id: string;
  reason: string;
}

export interface GateReport {
  regressions: Regression[];
  /** Controls actually held to the zero-site rule. */
  enforced: string[];
  unenforced: Unenforced[];
}

export function compareToLock(lock: LockFile, current: SiteIndex): GateReport {
  const regressions: Regression[] = [];
  const enforced: string[] = [];
  const unenforced: Unenforced[] = [];

  for (const control_id of Object.keys(lock.controls).sort()) {
    const control = lock.controls[control_id]!;

    if (control.event_types.length === 0) {
      unenforced.push({ control_id, reason: "no observed telemetry backs this control" });
      continue;
    }
    if (control.evidenced === false) {
      unenforced.push({
        control_id,
        reason: "not evidenced in the last sealed period; nothing to protect yet",
      });
      continue;
    }

    const lockedTypes = control.event_types.filter(
      (t) => (lock.sites[t] ?? []).length > 0,
    );
    if (lockedTypes.length === 0) {
      unenforced.push({
        control_id,
        reason: "no known emitting site at lock time; the gate protects what exists",
      });
      continue;
    }

    let regressed = false;
    for (const type of lockedTypes) {
      if ((current[type] ?? []).length > 0) continue;
      regressed = true;
      regressions.push({
        control_id,
        framework: control.framework,
        title: control.title,
        event_type: type,
        lost_sites: lock.sites[type]!,
      });
    }
    if (!regressed) enforced.push(control_id);
  }

  return { regressions, enforced, unenforced };
}
