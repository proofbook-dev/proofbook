import type {
  AssertionResult,
  ControlResult,
  FrameworkEvaluation,
  NormalizedBatch,
  Verdict,
} from "@proofbook/schema";
import { LANGS, t, type Catalog, type ControlTranslations, type Lang } from "./i18n/index.js";
import enCatalog from "./i18n/en.js";

/**
 * The Agent Trust Report renderer.
 *
 * One self-contained HTML file: embedded CSS, no external assets, no
 * scripts, system fonts, printable.
 *
 * Structure is progressive depth for three readers at once:
 *   1. The checklist - can each box be ticked, in plain language.
 *   2. What to do next - every gap becomes a concrete action.
 *   3. The evidence - per-control derivations for the auditor's hour.
 *   4. Data quality appendix - what the telemetry could and could not see.
 * Honesty stays up front: the at-a-glance block states the gaps and any
 * data-quality limits before a single box is shown.
 */

export interface ReportMeta {
  subject: string;
  tool_version: string;
  /** ISO timestamp. Optional so rendering stays deterministic in tests. */
  generated_at?: string;
}

export interface ReportInput {
  batch: NormalizedBatch;
  evaluations: FrameworkEvaluation[];
  meta: ReportMeta;
  /**
   * Presentation language. The sealed bundle stays canonical English;
   * rendering the same data in another language changes nothing an
   * auditor verifies, which is the entire design.
   */
  lang?: Lang;
  /** Reviewed translations for control titles and requirement summaries. */
  controlTranslations?: ControlTranslations;
}

// Set per render call; the renderer is synchronous, so module-level
// current-language state is safe and keeps twelve signatures readable.
let L: Catalog = enCatalog;
let CT: ControlTranslations = {};
const ctitle = (c: ControlResult): string => CT[c.control_id]?.title ?? c.title;
const csummary = (c: ControlResult): string => CT[c.control_id]?.requirement_summary ?? c.requirement_summary;

const esc = (s: unknown): string =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const FLAG: Record<Verdict, string> = {
  evidenced: "✓",
  partially_evidenced: "◐",
  not_evidenced: "✕",
  contradicted: "⊗",
  unevaluable: "─",
};

/** Checklist voice: what the verdict means to the person ticking boxes. */
const plain = (v: Verdict): string => L[`plain_${v}`] as string;
/** Formal label, used in the evidence detail. */
const verdictLabel = (v: Verdict): string => L[`verdict_${v}`] as string;
const sourceLabel = (sc: string): string => (L[`source_${sc}` as keyof Catalog] as string) ?? sc;

const FRAMEWORK_NAMES: Record<string, string> = {
  "eu-ai-act": "EU AI Act",
  "iso-42001": "ISO/IEC 42001",
  "nist-ai-rmf": "NIST AI RMF",
};

function fmtDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${L.months[Number(m) - 1]} ${y}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(n === 1 ? 0 : 1)}%`;
}

function period(batch: NormalizedBatch): { from?: string | undefined; to?: string | undefined } {
  const times: string[] = [];
  for (const list of Object.values(batch.events)) {
    for (const e of list as Array<Record<string, unknown>>) {
      for (const key of ["started_at", "ended_at", "at"]) {
        if (typeof e[key] === "string") times.push(e[key] as string);
      }
    }
  }
  times.sort();
  return times.length > 0 ? { from: times[0], to: times.at(-1) } : {};
}

function inventory(batch: NormalizedBatch) {
  const agents = [...new Set(batch.events.agent_runs.map((r) => r.agent_id))].sort();
  const models = [
    ...new Set(batch.events.model_calls.map((c) => `${c.provider} / ${c.model}`)),
  ].sort();
  const tools = [...new Set(batch.events.tool_calls.map((t) => t.tool_name))].sort();
  return { agents, models, tools };
}

/* ------------------------------------------------------------------ */
/* Plain-language interpretation of results                            */
/* ------------------------------------------------------------------ */

interface Gap {
  control: ControlResult;
  assertion: AssertionResult;
  action: string;
  kind: string;
}

function coverageNumbers(a: AssertionResult): string | undefined {
  const i = a.derivation.intermediates;
  if (typeof i.populated === "number" && typeof i.total === "number") {
    return `${i.populated} ${L.of} ${i.total}`;
  }
  if (typeof i.numerator === "number" && typeof i.denominator === "number") {
    return `${i.numerator} ${L.of} ${i.denominator}`;
  }
  return undefined;
}

/** One sentence per checklist row: the current state, in human terms. */
function statusSentence(c: ControlResult): string {
  const worst = c.assertions.reduce((w, a) =>
    SEVERITY[a.verdict] > SEVERITY[w.verdict] ? a : w,
  );
  const nums = coverageNumbers(worst);
  const value = worst.derivation.intermediates.value;
  switch (c.verdict) {
    case "evidenced":
      return L.status_evidenced;
    case "partially_evidenced":
      return t(L, "status_partial", {
        nums: nums ? ` (${nums}${typeof value === "number" ? `, ${pct(value)}` : ""})` : "",
      });
    case "not_evidenced":
      return t(L, "status_not_evidenced", { nums: nums ? t(L, "nums_present", { nums }) : "" });
    case "contradicted":
      return t(L, "status_contradicted", { nums: nums ? t(L, "nums_only_hold", { nums }) : "" });
    case "unevaluable":
      return worst.source_class === "declared"
        ? L.status_unevaluable_declared
        : worst.source_class === "configured"
          ? L.status_unevaluable_configured
          : L.status_unevaluable;
  }
}

/** Every non-evidenced assertion becomes one concrete action. */
function gapActions(controls: ControlResult[]): Gap[] {
  const gaps: Gap[] = [];
  for (const control of controls) {
    if (control.verdict === "evidenced") continue;
    for (const a of control.assertions) {
      if (a.verdict === "evidenced") continue;
      let action: string;
      let kind: string;
      const nums = coverageNumbers(a);
      if (a.verdict === "unevaluable" && a.source_class === "declared") {
        kind = "signoff";
        action = t(L, "action_signoff", { title: ctitle(control).toLowerCase() });
      } else if (a.verdict === "unevaluable" && a.source_class === "configured") {
        kind = "configuration";
        action = t(L, "action_configured", { title: ctitle(control).toLowerCase() });
      } else if (a.verdict === "unevaluable") {
        kind = "instrumentation";
        action = a.unevaluable_reason ?? L.action_unevaluable_fallback;
      } else if (a.capability === "content_integrity") {
        kind = "instrumentation";
        action = t(L, "action_content", { today: nums ? t(L, "action_content_today", { nums }) : "" });
      } else if (a.capability === "token_accounting") {
        kind = "instrumentation";
        action = t(L, "action_tokens", { today: nums ? t(L, "action_tokens_today", { nums }) : "" });
      } else if (a.derivation.expression.includes("linked(AgentRun)")) {
        kind = "instrumentation";
        action = t(L, "action_unattributed", { nums: nums ? t(L, "action_unattributed_nums", { nums }) : "" });
      } else {
        kind = "instrumentation";
        action = t(L, "action_generic", { description: a.description, nums: nums ? t(L, "action_generic_nums", { nums }) : "" });
      }
      gaps.push({ control, assertion: a, action, kind });
    }
  }
  const order: Record<Verdict, number> = {
    contradicted: 0,
    not_evidenced: 1,
    partially_evidenced: 2,
    unevaluable: 3,
    evidenced: 4,
  };
  return gaps.sort(
    (x, y) =>
      order[x.assertion.verdict] - order[y.assertion.verdict] ||
      x.control.control_id.localeCompare(y.control.control_id),
  );
}

const SEVERITY: Record<Verdict, number> = {
  evidenced: 0,
  partially_evidenced: 1,
  unevaluable: 2,
  not_evidenced: 3,
  contradicted: 4,
};

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function glanceSection(batch: NormalizedBatch, evaluations: FrameworkEvaluation[]): string {
  const total = evaluations.reduce((n, e) => n + e.controls.length, 0);
  const sum = (v: Verdict) => evaluations.reduce((n, e) => n + e.summary[v], 0);
  const ready = sum("evidenced");
  const partial = sum("partially_evidenced");
  const missing = sum("not_evidenced") + sum("contradicted");
  const input = sum("unevaluable");
  const frameworks = evaluations
    .map((e) => FRAMEWORK_NAMES[e.framework] ?? e.framework)
    .join(", ");

  const limits = batch.completeness.capabilities.filter((c) => c.status !== "available");
  const dq =
    limits.length > 0 || batch.counts.spans_unmapped > 0
      ? `<p class="dq-note">${esc(t(L, "dq_note_start", { pct: pct(batch.completeness.mapped_ratio) }))}${
          limits.length > 0
            ? esc(t(L, limits.length === 1 ? "dq_note_limited_one" : "dq_note_limited_other", { n: limits.length }))
            : ""
        }${esc(L.dq_note_end)} <a href="#data-quality">${esc(L.dq_note_link)}</a>.</p>`
      : "";

  return `<section class="glance">
    <h2>${esc(L.glance_title)}</h2>
    <p class="big">${esc(t(L, "glance_main", { frameworks, ready: String(ready), total: String(total) }))
      .replace(`${ready}`, `<b class="v-evidenced">${ready}</b>`)}
      ${partial > 0 ? `<span>${esc(t(L, partial === 1 ? "glance_partial_one" : "glance_partial_other", { n: partial })).replace(String(partial), `<b class="v-partially_evidenced">${partial}</b>`)}</span>` : ""}
      ${missing > 0 ? `<span>${esc(t(L, missing === 1 ? "glance_missing_one" : "glance_missing_other", { n: missing })).replace(String(missing), `<b class="v-not_evidenced">${missing}</b>`)}</span>` : ""}
      ${input > 0 ? `<span>${esc(t(L, input === 1 ? "glance_input_one" : "glance_input_other", { n: input })).replace(String(input), `<b class="v-unevaluable">${input}</b>`)}</span>` : ""}
    </p>
    ${dq}
  </section>`;
}

function checklistSection(evaluations: FrameworkEvaluation[]): string {
  const rows = (ev: FrameworkEvaluation) =>
    ev.controls
      .map(
        (c) => `<a class="row" href="#${esc(c.control_id)}">
          <span class="flag v-${c.verdict}">${FLAG[c.verdict]}</span>
          <span class="row-body">
            <span class="row-title">${esc(ctitle(c))}${c.article ? ` <span class="row-article">${esc(c.article)}</span>` : ""}</span>
            <span class="row-status">${esc(statusSentence(c))}</span>
          </span>
          <span class="row-verdict v-${c.verdict}">${esc(plain(c.verdict))}</span>
        </a>`,
      )
      .join("");

  return evaluations
    .map(
      (ev) => `<section>
        <h2>${esc(L.checklist_title)} <span class="dim">· ${esc(FRAMEWORK_NAMES[ev.framework] ?? ev.framework)}</span></h2>
        <div class="checklist">${rows(ev)}</div>
      </section>`,
    )
    .join("");
}

function actionsSection(evaluations: FrameworkEvaluation[]): string {
  const gaps = gapActions(evaluations.flatMap((e) => e.controls));
  if (gaps.length === 0) {
    return `<section><h2>${esc(L.actions_title)}</h2><p class="lede">${esc(L.actions_none)}</p></section>`;
  }
  const KIND_LABEL: Record<string, string> = {
    instrumentation: L.kind_instrumentation,
    configuration: L.kind_configuration,
    signoff: L.kind_signoff,
  };
  const KIND_NOTE: Record<string, string> = {
    instrumentation: L.kind_note_instrumentation,
    configuration: L.kind_note_configuration,
    signoff: L.kind_note_signoff,
  };
  const order = ["instrumentation", "configuration", "signoff"];
  const groups = order
    .map((kind) => ({ kind, items: gaps.filter((g) => g.kind === kind) }))
    .filter((g) => g.items.length > 0);
  const blocks = groups
    .map(
      (group) => `<div class="action-group">
        <div class="action-head">
          <span>${esc(KIND_LABEL[group.kind] ?? group.kind)}</span>
          <span class="dim">${esc(KIND_NOTE[group.kind] ?? "")} · ${group.items.length}</span>
        </div>
        ${group.items
          .map(
            (g) => `<div class="action">
          <div class="action-title">${esc(ctitle(g.control))}</div>
          <div class="action-id">${esc(g.control.control_id)}</div>
          <p class="action-step">${esc(g.action)}</p>
        </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");
  return `<section>
    <h2>${esc(L.actions_title)}</h2>
    <p class="lede">${esc(L.actions_lede)}</p>
    ${blocks}
  </section>`;
}

function assertionBlock(a: AssertionResult): string {
  const d = a.derivation;
  const intermediates = Object.entries(d.intermediates)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`)
    .join("");
  const consulted = d.events_consulted
    .map(
      (c) =>
        `<tr><td class="mono">${esc(c.event_type)}</td><td class="mono">${c.total}</td>` +
        `<td class="mono dim">${c.sample.map((r) => esc(r.span_id)).join(" ")}</td></tr>`,
    )
    .join("");

  const evidence = a.evidence
    ? `<div class="ev mono">
        evidence: ${esc(a.evidence.selector)} · ${a.evidence.count} event(s)
        ${a.evidence.date_range ? ` · ${esc(a.evidence.date_range[0])} → ${esc(a.evidence.date_range[1])}` : ""}
        ${a.evidence.distinct_agents ? ` · agents: ${a.evidence.distinct_agents.map(esc).join(", ")}` : ""}
        ${a.evidence.distinct_models ? ` · models: ${a.evidence.distinct_models.map(esc).join(", ")}` : ""}
        ${a.evidence.distinct_tools ? ` · tools: ${a.evidence.distinct_tools.map(esc).join(", ")}` : ""}
      </div>`
    : "";

  return `<div class="assertion">
    <div class="a-head">
      <span class="verdict v-${a.verdict}">${FLAG[a.verdict]} ${esc(verdictLabel(a.verdict))} <span class="canon">${esc(a.verdict)}</span></span>
      <span class="sc sc-${a.source_class}">${esc(sourceLabel(a.source_class))}</span>
      <span class="mono dim">${esc(a.assertion_id)}</span>
    </div>
    <p>${esc(a.description)}</p>
    ${a.unevaluable_reason ? `<p class="reason">${esc(L.why_unevaluable)} ${esc(a.unevaluable_reason)}</p>` : ""}
    <details>
      <summary>${esc(L.how_derived)}</summary>
      <div class="derivation">
        <div class="mono expr">${esc(d.expression)}</div>
        <table>
          <tbody>
            <tr><td>${esc(L.th_outcome)}</td><td class="mono">${esc(d.outcome)}</td></tr>
            ${d.comparator ? `<tr><td>${esc(L.th_threshold)}</td><td class="mono">${esc(d.comparator.op)} ${esc(d.comparator.value)}</td></tr>` : ""}
            ${intermediates}
          </tbody>
        </table>
        ${
          consulted !== ""
            ? `<table>
                <thead><tr><th>${esc(L.th_events_consulted)}</th><th>${esc(L.th_total)}</th><th>${esc(L.th_sample)}</th></tr></thead>
                <tbody>${consulted}</tbody>
              </table>`
            : `<p class="dim">${esc(L.no_events_consulted)}</p>`
        }
        ${evidence}
      </div>
    </details>
  </div>`;
}

function controlCard(c: ControlResult): string {
  return `<article class="control" id="${esc(c.control_id)}">
    <div class="c-head">
      <div>
        <span class="mono dim">${esc(c.control_id)}${c.article ? ` · ${esc(c.article)}` : ""}</span>
        <h3>${esc(ctitle(c))}</h3>
      </div>
      <span class="verdict v-${c.verdict}">${FLAG[c.verdict]} ${esc(verdictLabel(c.verdict))} <span class="canon">${esc(c.verdict)}</span></span>
    </div>
    <p class="dim">${esc(csummary(c))}</p>
    ${c.assertions.map(assertionBlock).join("")}
  </article>`;
}

function detailSection(evaluations: FrameworkEvaluation[]): string {
  return evaluations
    .map(
      (ev) => `<section>
        <h2>${esc(L.detail_title)} <span class="dim">· ${esc(FRAMEWORK_NAMES[ev.framework] ?? ev.framework)} (${esc(ev.framework_version)})</span></h2>
        <p class="lede">${esc(L.detail_lede)}</p>
        <p class="mono dim pin">crosswalk ${esc(ev.crosswalk_version)} · pinned ${esc(ev.crosswalk_pin)} · event schema ${esc(ev.event_schema_version)}</p>
        ${ev.controls.map(controlCard).join("")}
      </section>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ */
/* Activity log: what each run actually did, inspectable per event.    */
/* ------------------------------------------------------------------ */

const RUN_CAP = 40;

interface RunEvent {
  at: string;
  span_id: string;
  text: string;
}

interface RunView {
  run_id: string;
  agents: string[];
  start: string;
  events: RunEvent[];
  counts: { model: number; tool: number; checkpoint: number; error: number };
  tokens: { input: number; output: number };
}

function ms(n: number | undefined): string {
  return n === undefined ? "" : n >= 1000 ? ` · ${(n / 1000).toFixed(1)}s` : ` · ${n}ms`;
}

function buildRuns(batch: NormalizedBatch): RunView[] {
  const runs = new Map<string, RunView>();
  const runOf = (run_id: string): RunView => {
    let run = runs.get(run_id);
    if (!run) {
      run = {
        run_id,
        agents: [],
        start: "9999",
        events: [],
        counts: { model: 0, tool: 0, checkpoint: 0, error: 0 },
        tokens: { input: 0, output: 0 },
      };
      runs.set(run_id, run);
    }
    return run;
  };
  const add = (run_id: string, at: string, span_id: string, text: string) => {
    const run = runOf(run_id);
    run.events.push({ at, span_id, text });
    if (at < run.start) run.start = at;
  };

  for (const r of batch.events.agent_runs) {
    const run = runOf(r.run_id);
    if (!run.agents.includes(r.agent_id)) run.agents.push(r.agent_id);
    const duration =
      r.ended_at !== undefined
        ? ms(new Date(r.ended_at).getTime() - new Date(r.started_at).getTime())
        : "";
    add(r.run_id, r.started_at, r.span_id, `agent ${r.agent_id}${r.session_id ? ` · session ${r.session_id}` : ""}${duration}`);
  }
  for (const c of batch.events.model_calls) {
    const run = runOf(c.run_id);
    run.counts.model += 1;
    run.tokens.input += c.token_usage?.input ?? 0;
    run.tokens.output += c.token_usage?.output ?? 0;
    const tokens =
      c.token_usage?.input !== undefined || c.token_usage?.output !== undefined
        ? ` · ${c.token_usage?.input ?? "?"}→${c.token_usage?.output ?? "?"} tok`
        : " · token usage not emitted";
    add(c.run_id, c.started_at, c.span_id, `model ${c.provider} / ${c.model}${tokens}${ms(c.latency_ms)}${c.finish_reason ? ` · ${c.finish_reason}` : ""}`);
  }
  for (const t of batch.events.tool_calls) {
    runOf(t.run_id).counts.tool += 1;
    add(t.run_id, t.started_at, t.span_id, `tool ${t.tool_name}${t.server ? ` @ ${t.server}` : ""} · ${t.outcome}${ms(t.latency_ms)}`);
  }
  for (const h of batch.events.human_checkpoints) {
    runOf(h.run_id).counts.checkpoint += 1;
    add(h.run_id, h.at, h.span_id, `human ${h.type} · ${h.decision ?? "recorded"}${h.actor_ref ? ` · actor ${h.actor_ref.sha256.slice(0, 12)}…` : ""}`);
  }
  for (const d of batch.events.delegations) {
    add(d.run_id, d.at, d.span_id, `delegates ${d.parent_agent} → ${d.child_agent}`);
  }
  for (const e of batch.events.errors) {
    runOf(e.run_id).counts.error += 1;
    add(e.run_id, e.at, e.span_id, `error · ${e.error_type}`);
  }

  for (const run of runs.values()) {
    run.events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.span_id < b.span_id ? -1 : 1));
  }
  return [...runs.values()].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.run_id < b.run_id ? -1 : 1,
  );
}

function activitySection(batch: NormalizedBatch): string {
  const runs = buildRuns(batch);
  if (runs.length === 0) return "";

  const rows = runs.slice(0, RUN_CAP).map((run) => {
    const chips = [
      run.counts.model > 0 ? `${run.counts.model} model` : "",
      run.tokens.input + run.tokens.output > 0
        ? `${(run.tokens.input + run.tokens.output).toLocaleString("en-US")} tok`
        : "",
      run.counts.tool > 0 ? `${run.counts.tool} tool` : "",
      run.counts.checkpoint > 0 ? `${run.counts.checkpoint} human` : "",
      run.counts.error > 0 ? `<span class="v-not_evidenced">${run.counts.error} error</span>` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const events = run.events
      .map(
        (e) =>
          `<tr><td class="mono dim">${esc(e.at.slice(11, 19))}</td><td>${esc(e.text)}</td><td class="mono dim">${esc(e.span_id)}</td></tr>`,
      )
      .join("");
    return `<details class="run">
      <summary>
        <span class="mono dim">${esc(fmtDay(run.start))} ${esc(run.start.slice(11, 19))}</span>
        <b>${run.agents.length > 0 ? run.agents.map(esc).join(", ") : `<span class="dim">${esc(L.no_agent_span)}</span>`}</b>
        <span class="dim">${chips}</span>
        <span class="mono dim">run ${esc(run.run_id.slice(0, 12))}…</span>
      </summary>
      <table><tbody>${events}</tbody></table>
    </details>`;
  });

  return `<section id="activity">
    <h2>${esc(L.activity_title)}</h2>
    <p class="lede">${esc(L.activity_lede)}</p>
    <div class="runlog">${rows.join("")}</div>
    ${
      runs.length > RUN_CAP
        ? `<p class="dim">${esc(t(L, "showing_runs", { shown: RUN_CAP, total: runs.length }))}</p>`
        : ""
    }
  </section>`;
}

function dataQualitySection(batch: NormalizedBatch): string {
  const { completeness, counts, unmapped, conflicts, detections } = batch;

  const capRows = completeness.capabilities
    .map(
      (c) => `<tr>
        <td class="mono">${esc(c.id)}</td>
        <td><span class="cap cap-${c.status}">${esc(c.status)}</span></td>
        <td>${esc(c.reason ?? "")}</td>
      </tr>`,
    )
    .join("");

  const unmappedRows = unmapped
    .slice(0, 20)
    .map(
      (u) =>
        `<tr><td class="mono">${esc(u.span_id)}</td><td>${esc(u.name)}</td><td>${esc(u.reason)}</td></tr>`,
    )
    .join("");

  return `<section id="data-quality">
    <h2>${esc(L.dq_title)}</h2>
    <p class="lede">${esc(L.dq_lede)}</p>
    <div class="statline mono">
      <span>${esc(t(L, "dq_spans_seen", { n: counts.spans_seen.toLocaleString("en-US") }))}</span>
      <span>${esc(t(L, "dq_spans_mapped", { n: counts.spans_mapped.toLocaleString("en-US"), pct: pct(completeness.mapped_ratio) }))}</span>
      <span>${esc(t(L, "dq_spans_unmapped", { n: counts.spans_unmapped.toLocaleString("en-US") }))}</span>
      <span>${esc(t(L, "dq_generations", { list: detections.map((d) => `${d.generation} (${d.confidence})`).join(", ") || "-" }))}</span>
      ${conflicts.length > 0 ? `<span>${esc(t(L, "dq_conflicts", { n: conflicts.length }))}</span>` : ""}
    </div>
    <table>
      <thead><tr><th>${esc(L.th_category)}</th><th>${esc(L.th_status)}</th><th>${esc(L.th_notes)}</th></tr></thead>
      <tbody>${capRows}</tbody>
    </table>
    ${
      unmapped.length > 0
        ? `<h3>${esc(L.dq_unusable_title)}</h3>
           <table>
             <thead><tr><th>${esc(L.th_span)}</th><th>${esc(L.th_name)}</th><th>${esc(L.th_reason)}</th></tr></thead>
             <tbody>${unmappedRows}</tbody>
           </table>
           ${counts.spans_unmapped > 20 ? `<p class="dim">${esc(t(L, "dq_more", { n: counts.spans_unmapped - Math.min(unmapped.length, 20) }))}</p>` : ""}`
        : ""
    }
  </section>`;
}

/* ------------------------------------------------------------------ */

export function renderReport(input: ReportInput): string {
  const { batch, evaluations, meta } = input;
  const lang: Lang = input.lang ?? "en";
  L = LANGS[lang].catalog;
  CT = input.controlTranslations ?? {};
  const { from, to } = period(batch);
  const inv = inventory(batch);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Trust Report · ${esc(meta.subject)}</title>
<style>
  :root {
    --ink: #1a1c1b; --dim: #5f645f; --rule: rgba(95,100,95,.28); --rule-faint: rgba(95,100,95,.13);
    --paper: #f8f8f5; --doc: #fff;
    --green: #2e6b4c; --ochre: #8a6000; --red: #942f1d; --gray: #5f645f;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 15px/1.6 Georgia, "Times New Roman", serif; color: var(--ink); background: var(--paper); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85em; }
  main { max-width: 880px; margin: 0 auto; padding: 40px 24px 80px; }
  header.doc { background: var(--doc); border: 1px solid var(--rule); padding: 26px 30px; }
  h1 { font-size: 21px; letter-spacing: .1em; }
  h2 { font-size: 22px; margin: 0 0 12px; }
  h3 { font-size: 16.5px; margin: 4px 0 6px; }
  section { margin-top: 48px; }
  .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 32px; margin-top: 14px; font-size: 13px; }
  .meta div { display: flex; gap: 10px; }
  .meta dt { color: var(--dim); text-transform: uppercase; font-size: 10.5px; letter-spacing: .1em; flex: 0 0 88px; padding-top: 3px; font-family: ui-monospace, Menlo, monospace; }
  .meta dd { overflow-wrap: anywhere; }
  .lede { max-width: 64ch; margin-bottom: 8px; }
  .dim { color: var(--dim); }
  .big { font-size: 19px; line-height: 1.55; max-width: 60ch; }
  .dq-note { margin-top: 12px; font-size: 14px; color: var(--dim); max-width: 64ch; }
  .dq-note a { color: var(--dim); }

  /* checklist */
  .checklist { background: var(--doc); border: 1px solid var(--rule); }
  .row-article {
    font-family: var(--mono); font-size: 11px; color: var(--graphite);
    border: 1px solid var(--rule); border-radius: 4px; padding: 1px 6px;
    margin-left: 8px; white-space: nowrap; vertical-align: 1px;
  }
  .row { display: flex; gap: 16px; align-items: baseline; padding: 13px 18px; border-bottom: 1px solid var(--rule-faint); text-decoration: none; color: var(--ink); }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--paper); }
  .flag { font-size: 17px; flex: 0 0 20px; text-align: center; }
  .row-body { flex: 1; }
  .row-title { display: block; font-weight: bold; font-size: 15px; }
  .row-status { display: block; font-size: 13.5px; color: var(--dim); }
  .row-verdict { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }

  /* actions */
  .action-group { margin: 30px 0 0; }
  .action-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
  .action-head .dim { letter-spacing: .02em; text-transform: none; }
  .action { padding: 16px 0 18px; border-bottom: 1px solid var(--rule-faint); }
  .action:last-child { border-bottom: 0; }
  .action-title { font-weight: 600; }
  .action-id { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--graphite); margin: 2px 0 6px; }
  .action-step { margin: 0; max-width: 72ch; }

  table { border-collapse: collapse; width: 100%; margin: 10px 0 6px; font-size: 13px; }
  th { text-align: left; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); font-weight: 500; padding: 6px 16px 6px 0; border-bottom: 1px solid var(--rule); }
  td { padding: 7px 16px 7px 0; border-bottom: 1px solid var(--rule-faint); vertical-align: top; }
  .cap { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .cap-available { color: var(--green); } .cap-degraded { color: var(--ochre); } .cap-unavailable { color: var(--red); }
  .statline { display: flex; flex-wrap: wrap; gap: 4px 22px; margin: 12px 0 16px; font-size: 12.5px; color: var(--dim); }
  .v-evidenced { color: var(--green); } .v-partially_evidenced { color: var(--ochre); }
  .v-not_evidenced, .v-contradicted { color: var(--red); } .v-unevaluable { color: var(--gray); }
  .pin { font-size: 11px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .control { background: var(--doc); border: 1px solid var(--rule); padding: 20px 24px; margin-top: 14px; page-break-inside: avoid; }
  .c-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
  .verdict { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
  .canon { font-weight: 400; opacity: .55; text-transform: none; letter-spacing: 0; }
  .lang-note { font-size: 12px; margin-top: 10px; }
  .assertion { border-top: 1px solid var(--rule-faint); margin-top: 14px; padding-top: 12px; }
  .a-head { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; margin-bottom: 4px; }
  .sc { font-family: ui-monospace, Menlo, monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--rule); padding: 2px 8px; }
  .sc-observed { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .sc-declared { border-style: dashed; color: var(--dim); }
  .sc-configured { color: var(--ink); }
  .reason { color: var(--red); font-size: 13.5px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--dim); }
  .derivation { background: var(--paper); border: 1px solid var(--rule-faint); padding: 12px 16px; margin-top: 8px; }
  .expr { font-size: 12.5px; margin-bottom: 6px; }
  .ev { font-size: 11.5px; color: var(--dim); margin-top: 8px; overflow-wrap: anywhere; }
  ul.inv { list-style: none; font-size: 13.5px; }
  ul.inv li { padding: 5px 0; border-bottom: 1px solid var(--rule-faint); }
  .runlog { background: var(--doc); border: 1px solid var(--rule); }
  details.run { border-bottom: 1px solid var(--rule-faint); }
  details.run:last-child { border-bottom: none; }
  details.run summary { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; padding: 10px 16px; cursor: pointer; font-family: inherit; font-size: 13.5px; color: var(--ink); }
  details.run summary:hover { background: var(--paper); }
  details.run table { margin: 0 16px 12px; width: calc(100% - 32px); }
  details.run td:first-child { width: 76px; }
  details.run td:last-child { width: 150px; }
  footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--rule); font-size: 12.5px; color: var(--dim); }
  @media print { body { background: #fff; } .control { border-color: #999; } }
</style>
</head>
<body>
<main>
  <header class="doc">
    <h1>AGENT TRUST REPORT</h1>
    <dl class="meta">
      <div><dt>${esc(L.meta_subject)}</dt><dd>${esc(meta.subject)}</dd></div>
      <div><dt>${esc(L.meta_period)}</dt><dd>${from && to ? `${esc(fmtDay(from))} → ${esc(fmtDay(to))}` : esc(L.no_events_in_period)}</dd></div>
      <div><dt>${esc(L.meta_source)}</dt><dd class="mono">${batch.source.files.map(esc).join(", ") || " - "} (${esc(batch.source.format)})</dd></div>
      <div><dt>${esc(L.meta_versions)}</dt><dd class="mono">proofbook ${esc(meta.tool_version)} · event schema ${esc(batch.schema_version)}</dd></div>
      ${meta.generated_at ? `<div><dt>${esc(L.meta_generated)}</dt><dd class="mono">${esc(meta.generated_at)}</dd></div>` : ""}
      <div><dt>${esc(L.meta_standing)}</dt><dd>${esc(L.standing_text)}</dd></div>
    </dl>
    ${lang !== "en" ? `<p class="lang-note dim">${esc(t(L, "language_note", { language: LANGS[lang].name }))}</p>` : ""}
  </header>

  ${glanceSection(batch, evaluations)}
  ${checklistSection(evaluations)}
  ${actionsSection(evaluations)}
  ${detailSection(evaluations)}
  ${activitySection(batch)}
  ${dataQualitySection(batch)}

  <section>
    <h2>${esc(L.scope_title)}</h2>
    <p class="lede">${esc(L.scope_lede)}</p>
    <ul class="inv">
      <li><b>${esc(L.inv_agents)}</b> - ${inv.agents.length > 0 ? inv.agents.map(esc).join(", ") : esc(L.none_observed)}</li>
      <li><b>${esc(L.inv_models)}</b> - ${inv.models.length > 0 ? inv.models.map(esc).join(", ") : esc(L.none_observed)}</li>
      <li><b>${esc(L.inv_tools)}</b> - ${inv.tools.length > 0 ? inv.tools.map(esc).join(", ") : esc(L.none_observed)}</li>
      <li><b>${esc(L.inv_runs)}</b> - ${esc(t(L, "traces_evaluated", { n: new Set(
        Object.values(batch.events).flatMap((l) => (l as Array<{ run_id: string }>).map((e) => e.run_id)),
      ).size }))}</li>
    </ul>
  </section>

  <section>
    <h2>${esc(L.verification_title)}</h2>
    <p class="lede">${esc(L.verification_lede)}</p>
    <p class="mono">proof seal --period &lt;period&gt; &nbsp;·&nbsp; proofbook verify &lt;bundle&gt;</p>
    <p class="dim">${esc(L.verification_note)}</p>
  </section>

  <footer>
    ${esc(L.footer_text)}
  </footer>
</main>
</body>
</html>
`;
}
