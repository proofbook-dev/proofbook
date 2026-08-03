import { notFound } from "next/navigation";
import { controlsOf, verdictDeltas, VERDICTS, type ControlRecord } from "@/lib/bundles";
import { resolveShare, sharedBundles } from "@/lib/share";

/**
 * Screen two: control detail, the auditor's hour. Source class is the
 * primary visual distinction: demonstrated fact (observed) versus
 * configuration versus assertion by a named owner. Derivations expand
 * in place; sampled evidence is metadata plus digests, and the absence
 * of content is stated, not glossed.
 */

const SOURCE_TITLE: Record<string, string> = {
  observed: "Observed at runtime",
  configured: "Verified in configuration",
  declared: "Declared by a named owner",
};

export default async function Controls({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const q = await searchParams;
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") notFound();
  const bundles = (await sharedBundles(resolved.share)).filter((b) => !b.superseded_by);
  const latest = bundles.at(-1);
  if (!latest) return <p className="muted">No bundles in scope.</p>;
  const previous = bundles.at(-2);

  const changed = new Set(
    previous ? verdictDeltas(previous, latest).map((d) => d.control_id) : [],
  );
  let controls = controlsOf(latest);
  const frameworks = [...new Set(controls.map((c) => c.framework))];
  if (q.verdict) controls = controls.filter((c) => c.verdict === q.verdict);
  if (q.framework) controls = controls.filter((c) => c.framework === q.framework);
  if (q.source)
    controls = controls.filter((c) => c.assertions.some((a) => a.source_class === q.source));
  if (q.changed === "1") controls = controls.filter((c) => changed.has(c.control_id));

  return (
    <>
      <h1>Controls · {latest.period_label ?? "latest period"}</h1>
      <form className="filters" method="get">
        <span>
          <label htmlFor="f-verdict">Verdict</label>
          <select id="f-verdict" name="verdict" defaultValue={q.verdict ?? ""}>
            <option value="">all</option>
            {VERDICTS.map((v) => (
              <option key={v} value={v}>{v.replace("_", " ")}</option>
            ))}
          </select>
        </span>
        <span>
          <label htmlFor="f-source">Source class</label>
          <select id="f-source" name="source" defaultValue={q.source ?? ""}>
            <option value="">all</option>
            <option value="observed">observed</option>
            <option value="configured">configured</option>
            <option value="declared">declared</option>
          </select>
        </span>
        <span>
          <label htmlFor="f-fw">Framework</label>
          <select id="f-fw" name="framework" defaultValue={q.framework ?? ""}>
            <option value="">all</option>
            {frameworks.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </span>
        <span>
          <label htmlFor="f-changed">Changed since previous period</label>
          <select id="f-changed" name="changed" defaultValue={q.changed ?? ""}>
            <option value="">all</option>
            <option value="1">changed only</option>
          </select>
        </span>
        <button className="btn" type="submit">Filter</button>
      </form>

      {controls.length === 0 && (
        <p className="muted">No controls match these filters.</p>
      )}
      {controls.map((c) => (
        <ControlCard key={c.control_id} control={c} changed={changed.has(c.control_id)} />
      ))}
    </>
  );
}

function ControlCard({ control, changed }: { control: ControlRecord; changed: boolean }) {
  return (
    <article className="card" id={control.control_id}>
      <h3 style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", margin: 0 }}>
        <a href={`#${control.control_id}`} style={{ textDecoration: "none" }}>
          <code>{control.control_id}</code>
        </a>
        <span className={`verdict v-${control.verdict}`}>{control.verdict.replace("_", " ")}</span>
        {changed && <span className="verdict v-partially_evidenced">changed this period</span>}
      </h3>
      <p style={{ marginTop: 6 }}>
        <strong>{control.title}</strong>
        {control.article && <span className="muted small"> · {control.article}</span>}
      </p>
      <p className="small muted">{control.requirement_summary}</p>
      {control.assertions.map((a) => (
        <details key={a.assertion_id}>
          <summary>
            <span className={`source s-${a.source_class}`}>{SOURCE_TITLE[a.source_class]}</span>{" "}
            <span className={`verdict v-${a.verdict}`}>{a.verdict.replace("_", " ")}</span>{" "}
            <span className="small">{a.description}</span>
          </summary>
          <h3>Derivation</h3>
          <pre>{JSON.stringify(a.derivation, null, 2)}</pre>
          {a.unevaluable_reason && (
            <p className="small">
              <strong>Why unevaluable:</strong> {a.unevaluable_reason}
            </p>
          )}
          {a.evidence ? (
            <>
              <h3>Sampled evidence (metadata only)</h3>
              <pre>{JSON.stringify(a.evidence, null, 2)}</pre>
              <p className="small muted">
                Event content is hashed at source; digests above are the
                complete record by design, not an omission.
              </p>
            </>
          ) : (
            <p className="small muted">No event sample attached to this assertion.</p>
          )}
        </details>
      ))}
    </article>
  );
}
