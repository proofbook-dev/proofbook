/**
 * The English reference catalog. Every other language must provide
 * exactly these keys (enforced by the Catalog type), and English is
 * the authoritative rendering: translations are a convenience layer
 * over sealed data that never changes with language.
 *
 * Placeholders are {name}; plural variants are separate keys. Verdict
 * and source-class identifiers themselves are never translated: they
 * are the sealed vocabulary, shown beside the translated label.
 */
const en = {
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as string[],

  // verdict vocabulary
  of: "of",
  verdict_evidenced: "Evidenced",
  verdict_partially_evidenced: "Partially evidenced",
  verdict_not_evidenced: "Not evidenced",
  verdict_contradicted: "Contradicted",
  verdict_unevaluable: "Unevaluable",
  plain_evidenced: "Ready to cite",
  plain_partially_evidenced: "Nearly there",
  plain_not_evidenced: "Not yet",
  plain_contradicted: "Needs attention first",
  plain_unevaluable: "Needs your input",
  source_observed: "Observed at runtime",
  source_configured: "Verified in configuration",
  source_declared: "Declared by a named owner",

  // header
  meta_subject: "Subject",
  meta_period: "Period",
  meta_source: "Source",
  meta_versions: "Versions",
  meta_generated: "Generated",
  meta_standing: "Standing",
  standing_text: "Unsigned rendering. The verifiable artifact is a sealed bundle.",
  no_events_in_period: "no events in period",
  language_note: "Rendered in {language} for convenience; the sealed bundle and its English identifiers are authoritative.",

  // where you stand
  glance_title: "Where you stand",
  glance_main: "Against the {frameworks}, you can cite runtime evidence for {ready} of {total} controls today.",
  glance_partial_one: "{n} is nearly there,",
  glance_partial_other: "{n} are nearly there,",
  glance_missing_one: "{n} needs work,",
  glance_missing_other: "{n} need work,",
  glance_input_one: "and {n} needs input telemetry can't provide.",
  glance_input_other: "and {n} need input telemetry can't provide.",
  dq_note_start: "Honesty first: this report saw {pct} of the telemetry it was given",
  dq_note_limited_one: ", and {n} evidence category is limited",
  dq_note_limited_other: ", and {n} evidence categories are limited",
  dq_note_end: ". Anything the telemetry could not see is marked, never assumed. Details in",
  dq_note_link: "Data quality",

  // checklist
  checklist_title: "The checklist",
  status_evidenced: "Backed by runtime evidence for the whole period.",
  status_partial: "Holds for most of the system{nums}, one gap short of fully counting.",
  status_not_evidenced: "The records this needs don't exist yet{nums}.",
  status_contradicted: "The telemetry argues against this claim{nums} - resolve before anyone external sees it.",
  status_unevaluable_declared: "Telemetry can't see this one; it needs a signed statement from a named owner.",
  status_unevaluable_configured: "Telemetry can't see this one; it's verified from configuration.",
  status_unevaluable: "The telemetry can't answer this yet - an instrumentation gap, not necessarily a control gap.",
  nums_present: " ({nums} present)",
  nums_only_hold: " (only {nums} hold)",

  // actions
  actions_title: "What to do next",
  actions_none: "Nothing. Every control in scope is backed by runtime evidence. Seal the period and share it.",
  actions_lede: "Each open box above, turned into its next concrete step, grouped by the kind of work it takes.",
  kind_instrumentation: "Instrumentation",
  kind_configuration: "Configuration",
  kind_signoff: "Sign-off",
  kind_note_instrumentation: "engineering work: emit or enrich telemetry",
  kind_note_configuration: "verify a setting; not observable from traces",
  kind_note_signoff: "a named owner signs a declaration; no engineering work",
  action_signoff: "Have a named owner sign the declaration for “{title}”. No engineering work involved.",
  action_configured: "Verify this from configuration for “{title}”; it is not observable from traces.",
  action_unevaluable_fallback: "The telemetry cannot answer this; extend instrumentation.",
  action_content: "Enable content capture on the emitter{today}. Content is digest-hashed on the way through; nothing is stored.",
  action_content_today: " - {nums} model calls carry digests today",
  action_tokens: "Emit token usage attributes on model calls{today}.",
  action_tokens_today: " - {nums} carry them today",
  action_unattributed: "Some model calls happen outside any identified agent{nums}. Instrument the service making them, or they stay unattributable to an auditor.",
  action_unattributed_nums: " ({nums} are attributable)",
  action_generic: "Close the gap on “{description}”{nums}.",
  action_generic_nums: " - currently {nums}",

  // evidence detail
  detail_title: "The evidence, control by control",
  detail_lede: "For the reviewer who wants to check the working. Every verdict expands into its derivation: the rule applied, the threshold, and the exact events consulted.",
  why_unevaluable: "Why unevaluable:",
  how_derived: "How this was derived",
  th_outcome: "outcome",
  th_threshold: "threshold",
  th_events_consulted: "Events consulted",
  th_total: "Total",
  th_sample: "Sample (span ids)",
  no_events_consulted: "No events were consulted; no evidence source exists for this assertion yet.",

  // activity log
  activity_title: "Activity log",
  activity_lede: "Every run in the period, one row each - open a row to see what the agent actually did, event by event. Metadata only: models, tools, decisions and timings appear; prompts and payloads exist here only as digests. Span ids cross-reference the derivations above.",
  no_agent_span: "no agent span",
  showing_runs: "Showing {shown} of {total} runs. Every run is included in the JSON output and in the sealed bundle's event digests.",

  // data quality
  dq_title: "Data quality",
  dq_lede: "What the telemetry could and could not see. A verdict above is only ever as good as this section, which is why nothing here is hidden.",
  dq_spans_seen: "{n} spans seen",
  dq_spans_mapped: "{n} mapped ({pct})",
  dq_spans_unmapped: "{n} unmapped",
  dq_generations: "generations: {list}",
  dq_conflicts: "{n} span(s) carried mixed generations; resolved to the newest",
  th_category: "Evidence category",
  th_status: "Status",
  th_notes: "Notes",
  dq_unusable_title: "Spans this report could not use",
  th_span: "Span",
  th_name: "Name",
  th_reason: "Reason",
  dq_more: "…and {n} more, enumerated in the JSON output.",

  // scope
  scope_title: "Scope and inventory",
  scope_lede: "This report covers exactly what the telemetry could see. Services that were never instrumented do not appear here and are not covered by any verdict above.",
  inv_agents: "Agents",
  inv_models: "Models",
  inv_tools: "Tools",
  inv_runs: "Runs",
  none_observed: "none observed",
  traces_evaluated: "{n} trace(s) evaluated",

  // verification + footer
  verification_title: "Verification",
  verification_lede: "This HTML file is a rendering for people. To hand a third party something they can verify without trusting the producer, seal the period into a signed bundle and share that:",
  verification_note: "A sealed bundle binds these verdicts to the exact crosswalk text (pinned in the evidence section by content hash), the event schema version, and the producing identity, and verifies offline against a published specification.",
  footer_text: "Produced by Proofbook. Verdicts derive from telemetry; a runtime check supports a control and never satisfies a legal obligation on its own. Content is digest-referenced throughout; no prompt, completion or tool payload appears in this document.",
};

export default en;
