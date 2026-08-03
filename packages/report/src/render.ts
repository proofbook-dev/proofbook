import type {
  AssertionResult,
  ControlResult,
  FrameworkEvaluation,
  NormalizedBatch,
  Verdict,
} from "@proofbook/schema";

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
}

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
const PLAIN: Record<Verdict, string> = {
  evidenced: "Ready to cite",
  partially_evidenced: "Nearly there",
  not_evidenced: "Not yet",
  contradicted: "Needs attention first",
  unevaluable: "Needs your input",
};

/** Formal label, used in the evidence detail. */
const VERDICT_LABEL: Record<Verdict, string> = {
  evidenced: "Evidenced",
  partially_evidenced: "Partially evidenced",
  not_evidenced: "Not evidenced",
  contradicted: "Contradicted",
  unevaluable: "Unevaluable",
};

const SOURCE_LABEL: Record<string, string> = {
  observed: "Observed at runtime",
  configured: "Verified in configuration",
  declared: "Declared by a named owner",
};

const FRAMEWORK_NAMES: Record<string, string> = {
  "eu-ai-act": "EU AI Act",
  "iso-42001": "ISO/IEC 42001",
  "nist-ai-rmf": "NIST AI RMF",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
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
    return `${i.populated} of ${i.total}`;
  }
  if (typeof i.numerator === "number" && typeof i.denominator === "number") {
    return `${i.numerator} of ${i.denominator}`;
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
      return "Backed by runtime evidence for the whole period.";
    case "partially_evidenced":
      return `Holds for most of the system${nums ? ` (${nums}${typeof value === "number" ? `, ${pct(value)}` : ""})` : ""}, one gap short of fully counting.`;
    case "not_evidenced":
      return `The records this needs don't exist yet${nums ? ` (${nums} present)` : ""}.`;
    case "contradicted":
      return `The telemetry argues against this claim${nums ? ` (only ${nums} hold)` : ""} - resolve before anyone external sees it.`;
    case "unevaluable":
      return worst.source_class === "declared"
        ? "Telemetry can't see this one; it needs a signed statement from a named owner."
        : worst.source_class === "configured"
          ? "Telemetry can't see this one; it's verified from configuration."
          : "The telemetry can't answer this yet - an instrumentation gap, not necessarily a control gap.";
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
        kind = "Sign-off";
        action = `Have a named owner sign the declaration for “${control.title.toLowerCase()}”. No engineering work involved.`;
      } else if (a.verdict === "unevaluable" && a.source_class === "configured") {
        kind = "Configuration";
        action = `Verify this from configuration for “${control.title.toLowerCase()}”; it is not observable from traces.`;
      } else if (a.verdict === "unevaluable") {
        kind = "Instrumentation";
        action = a.unevaluable_reason ?? "The telemetry cannot answer this; extend instrumentation.";
      } else if (a.capability === "content_integrity") {
        kind = "Instrumentation";
        action = `Enable content capture on the emitter${nums ? ` - ${nums} model calls carry digests today` : ""}. Content is digest-hashed on the way through; nothing is stored.`;
      } else if (a.capability === "token_accounting") {
        kind = "Instrumentation";
        action = `Emit token usage attributes on model calls${nums ? ` - ${nums} carry them today` : ""}.`;
      } else if (a.derivation.expression.includes("linked(AgentRun)")) {
        kind = "Instrumentation";
        action = `Some model calls happen outside any identified agent${nums ? ` (${nums} are attributable)` : ""}. Instrument the service making them, or they stay unattributable to an auditor.`;
      } else {
        kind = "Instrumentation";
        action = `Close the gap on “${a.description}”${nums ? ` - currently ${nums}` : ""}.`;
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
      ? `<p class="dq-note">Honesty first: this report saw ${pct(batch.completeness.mapped_ratio)} of the telemetry it was given${
          limits.length > 0 ? `, and ${limits.length} evidence categor${limits.length === 1 ? "y is" : "ies are"} limited` : ""
        }. Anything the telemetry could not see is marked, never assumed. Details in <a href="#data-quality">Data quality</a>.</p>`
      : "";

  return `<section class="glance">
    <h2>Where you stand</h2>
    <p class="big">Against the ${esc(frameworks)}, you can cite runtime evidence for
      <b class="v-evidenced">${ready} of ${total}</b> controls today.
      ${partial > 0 ? `<b class="v-partially_evidenced">${partial}</b> ${partial === 1 ? "is" : "are"} nearly there,` : ""}
      ${missing > 0 ? `<b class="v-not_evidenced">${missing}</b> ${missing === 1 ? "needs" : "need"} work,` : ""}
      ${input > 0 ? `and <b class="v-unevaluable">${input}</b> need${input === 1 ? "s" : ""} input telemetry can't provide.` : ""}
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
            <span class="row-title">${esc(c.title)}${c.article ? ` <span class="row-article">${esc(c.article)}</span>` : ""}</span>
            <span class="row-status">${esc(statusSentence(c))}</span>
          </span>
          <span class="row-verdict v-${c.verdict}">${esc(PLAIN[c.verdict])}</span>
        </a>`,
      )
      .join("");

  return evaluations
    .map(
      (ev) => `<section>
        <h2>The checklist <span class="dim">· ${esc(FRAMEWORK_NAMES[ev.framework] ?? ev.framework)}</span></h2>
        <div class="checklist">${rows(ev)}</div>
      </section>`,
    )
    .join("");
}

function actionsSection(evaluations: FrameworkEvaluation[]): string {
  const gaps = gapActions(evaluations.flatMap((e) => e.controls));
  if (gaps.length === 0) {
    return `<section><h2>What to do next</h2><p class="lede">Nothing. Every control in scope is backed by runtime evidence. Seal the period and share it.</p></section>`;
  }
  const items = gaps
    .map(
      (g) => `<li>
        <span class="kind">${esc(g.kind)}</span>
        <div>
          <b>${esc(g.control.title)}</b> <span class="dim">(${esc(g.control.control_id)})</span><br>
          ${esc(g.action)}
        </div>
      </li>`,
    )
    .join("");
  return `<section>
    <h2>What to do next</h2>
    <p class="lede">Each open box above, turned into its next concrete step. Ordered by how much it matters.</p>
    <ul class="actions">${items}</ul>
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
      <span class="verdict v-${a.verdict}">${FLAG[a.verdict]} ${VERDICT_LABEL[a.verdict]}</span>
      <span class="sc sc-${a.source_class}">${SOURCE_LABEL[a.source_class]}</span>
      <span class="mono dim">${esc(a.assertion_id)}</span>
    </div>
    <p>${esc(a.description)}</p>
    ${a.unevaluable_reason ? `<p class="reason">Why unevaluable: ${esc(a.unevaluable_reason)}</p>` : ""}
    <details>
      <summary>How this was derived</summary>
      <div class="derivation">
        <div class="mono expr">${esc(d.expression)}</div>
        <table>
          <tbody>
            <tr><td>outcome</td><td class="mono">${esc(d.outcome)}</td></tr>
            ${d.comparator ? `<tr><td>threshold</td><td class="mono">${esc(d.comparator.op)} ${esc(d.comparator.value)}</td></tr>` : ""}
            ${intermediates}
          </tbody>
        </table>
        ${
          consulted !== ""
            ? `<table>
                <thead><tr><th>Events consulted</th><th>Total</th><th>Sample (span ids)</th></tr></thead>
                <tbody>${consulted}</tbody>
              </table>`
            : `<p class="dim">No events were consulted; no evidence source exists for this assertion yet.</p>`
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
        <h3>${esc(c.title)}</h3>
      </div>
      <span class="verdict v-${c.verdict}">${FLAG[c.verdict]} ${VERDICT_LABEL[c.verdict]}</span>
    </div>
    <p class="dim">${esc(c.requirement_summary)}</p>
    ${c.assertions.map(assertionBlock).join("")}
  </article>`;
}

function detailSection(evaluations: FrameworkEvaluation[]): string {
  return evaluations
    .map(
      (ev) => `<section>
        <h2>The evidence, control by control <span class="dim">· ${esc(FRAMEWORK_NAMES[ev.framework] ?? ev.framework)} (${esc(ev.framework_version)})</span></h2>
        <p class="lede">For the reviewer who wants to check the working. Every verdict expands into its derivation: the rule applied, the threshold, and the exact events consulted.</p>
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
        <b>${run.agents.length > 0 ? run.agents.map(esc).join(", ") : '<span class="dim">no agent span</span>'}</b>
        <span class="dim">${chips}</span>
        <span class="mono dim">run ${esc(run.run_id.slice(0, 12))}…</span>
      </summary>
      <table><tbody>${events}</tbody></table>
    </details>`;
  });

  return `<section id="activity">
    <h2>Activity log</h2>
    <p class="lede">Every run in the period, one row each - open a row to see what the agent actually did, event by event. Metadata only: models, tools, decisions and timings appear; prompts and payloads exist here only as digests. Span ids cross-reference the derivations above.</p>
    <div class="runlog">${rows.join("")}</div>
    ${
      runs.length > RUN_CAP
        ? `<p class="dim">Showing ${RUN_CAP} of ${runs.length} runs. Every run is included in the JSON output and in the sealed bundle's event digests.</p>`
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
    <h2>Data quality</h2>
    <p class="lede">What the telemetry could and could not see. A verdict above is only ever as good as this section, which is why nothing here is hidden.</p>
    <div class="statline mono">
      <span>${counts.spans_seen.toLocaleString("en-US")} spans seen</span>
      <span>${counts.spans_mapped.toLocaleString("en-US")} mapped (${pct(completeness.mapped_ratio)})</span>
      <span>${counts.spans_unmapped.toLocaleString("en-US")} unmapped</span>
      <span>generations: ${esc(detections.map((d) => `${d.generation} (${d.confidence})`).join(", ") || "none")}</span>
      ${conflicts.length > 0 ? `<span>${conflicts.length} span(s) carried mixed generations; resolved to the newest</span>` : ""}
    </div>
    <table>
      <thead><tr><th>Evidence category</th><th>Status</th><th>Notes</th></tr></thead>
      <tbody>${capRows}</tbody>
    </table>
    ${
      unmapped.length > 0
        ? `<h3>Spans this report could not use</h3>
           <table>
             <thead><tr><th>Span</th><th>Name</th><th>Reason</th></tr></thead>
             <tbody>${unmappedRows}</tbody>
           </table>
           ${unmapped.length > 20 ? `<p class="dim">…and ${unmapped.length - 20} more, enumerated in the JSON output.</p>` : ""}`
        : ""
    }
  </section>`;
}

/* ------------------------------------------------------------------ */

export function renderReport(input: ReportInput): string {
  const { batch, evaluations, meta } = input;
  const { from, to } = period(batch);
  const inv = inventory(batch);

  return `<!DOCTYPE html>
<html lang="en">
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
  ul.actions { list-style: none; }
  ul.actions li { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--rule-faint); font-size: 14px; max-width: 72ch; }
  .kind { font-family: ui-monospace, Menlo, monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--rule); padding: 2px 8px; height: fit-content; white-space: nowrap; }

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
      <div><dt>Subject</dt><dd>${esc(meta.subject)}</dd></div>
      <div><dt>Period</dt><dd>${from && to ? `${esc(fmtDay(from))} → ${esc(fmtDay(to))}` : "no events in period"}</dd></div>
      <div><dt>Source</dt><dd class="mono">${batch.source.files.map(esc).join(", ") || " - "} (${esc(batch.source.format)})</dd></div>
      <div><dt>Versions</dt><dd class="mono">proofbook ${esc(meta.tool_version)} · event schema ${esc(batch.schema_version)}</dd></div>
      ${meta.generated_at ? `<div><dt>Generated</dt><dd class="mono">${esc(meta.generated_at)}</dd></div>` : ""}
      <div><dt>Standing</dt><dd>Unsigned rendering. The verifiable artifact is a sealed bundle.</dd></div>
    </dl>
  </header>

  ${glanceSection(batch, evaluations)}
  ${checklistSection(evaluations)}
  ${actionsSection(evaluations)}
  ${detailSection(evaluations)}
  ${activitySection(batch)}
  ${dataQualitySection(batch)}

  <section>
    <h2>Scope and inventory</h2>
    <p class="lede">This report covers exactly what the telemetry could see. Services that were never instrumented do not appear here and are not covered by any verdict above.</p>
    <ul class="inv">
      <li><b>Agents</b> - ${inv.agents.length > 0 ? inv.agents.map(esc).join(", ") : "none observed"}</li>
      <li><b>Models</b> - ${inv.models.length > 0 ? inv.models.map(esc).join(", ") : "none observed"}</li>
      <li><b>Tools</b> - ${inv.tools.length > 0 ? inv.tools.map(esc).join(", ") : "none observed"}</li>
      <li><b>Runs</b> - ${new Set(
        Object.values(batch.events).flatMap((l) => (l as Array<{ run_id: string }>).map((e) => e.run_id)),
      ).size} trace(s) evaluated</li>
    </ul>
  </section>

  <section>
    <h2>Verification</h2>
    <p class="lede">This HTML file is a rendering for people. To hand a third party something they can verify without trusting the producer, seal the period into a signed bundle and share that:</p>
    <p class="mono">proof seal --period &lt;period&gt; &nbsp;·&nbsp; proofbook verify &lt;bundle&gt;</p>
    <p class="dim">A sealed bundle binds these verdicts to the exact crosswalk text (pinned in the evidence section by content hash), the event schema version, and the producing identity, and verifies offline against a published specification.</p>
  </section>

  <footer>
    Produced by Proofbook. Verdicts derive from telemetry; a runtime check supports a control and never satisfies a legal obligation on its own. Content is digest-referenced throughout; no prompt, completion or tool payload appears in this document.
  </footer>
</main>
</body>
</html>
`;
}
