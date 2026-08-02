/**
 * Period semantics. A bundle covers a named, closed period; the month
 * is the unit of continuity. All boundaries are UTC, half-open
 * [from, to): an event at exactly midnight on the 1st belongs to the
 * new month, never to both.
 */

export interface Period {
  /** "2026-07" for months; ad-hoc ranges carry an "adhoc-" label. */
  label: string;
  from: string;
  to: string;
}

export class PeriodError extends Error {}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthLabel(label: string): boolean {
  return MONTH_RE.test(label);
}

export function monthPeriod(label: string): Period {
  if (!isMonthLabel(label)) {
    throw new PeriodError(`"${label}" is not a month period (expected YYYY-MM)`);
  }
  const [y, m] = label.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const to = new Date(Date.UTC(y, m, 1)).toISOString();
  return { label, from, to };
}

/** "last-month" and friends resolve against an injected clock. */
export function resolvePeriod(spec: string, now: Date): Period {
  if (spec === "last-month") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-based; this month
    const prev = new Date(Date.UTC(y, m - 1, 1));
    return monthPeriod(
      `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  if (spec === "this-month") {
    return monthPeriod(
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  return monthPeriod(spec);
}

export function nextMonthLabel(label: string): string {
  const [y, m] = label.split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Months strictly between two labels, in order. */
export function monthsBetween(afterLabel: string, beforeLabel: string): string[] {
  const out: string[] = [];
  let cursor = nextMonthLabel(afterLabel);
  while (cursor < beforeLabel) {
    out.push(cursor);
    cursor = nextMonthLabel(cursor);
  }
  return out;
}

export function isoToNano(iso: string): bigint {
  return BigInt(Date.parse(iso)) * 1_000_000n;
}
