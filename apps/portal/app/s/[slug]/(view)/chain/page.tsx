import { notFound } from "next/navigation";
import { assembleChain, verdictDeltas, type StoredBundle } from "@/lib/bundles";
import { resolveShare, sharedBundles } from "@/lib/share";

/**
 * Screen three: the chain. Gaps render as loud breaks; per-period
 * verdict deltas surface before the auditor asks; and the honest
 * caveat is stated in the UI, not a footnote: the chain proves bundles
 * were not altered after publication, not that instrumentation was
 * complete at capture time.
 */

export default async function Chain({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") notFound();
  const bundles = await sharedBundles(resolved.share);
  const entries = assembleChain(bundles);
  const superseded = bundles.filter((b) => b.superseded_by);

  let prev: StoredBundle | null = null;
  return (
    <>
      <h1>Evidence chain</h1>
      <p className="small muted">
        Each bundle commits to the root hash of its predecessor. The chain
        proves the record was not altered or backdated after publication. It
        does not prove instrumentation was complete at capture time; the scope
        statement on the overview covers what was observed.
      </p>

      {entries.length === 0 && <p className="muted">No bundles in scope.</p>}
      {entries.map((entry, i) => {
        if (entry.kind === "gap") {
          return (
            <div className="gapbox" key={`gap-${i}`}>
              <strong>Gap:</strong> {entry.labels.join(", ")}{" "}
              {entry.labels.length === 1 ? "was" : "were"} never sealed. Evidence
              for {entry.labels.length === 1 ? "this period" : "these periods"}{" "}
              cannot be produced retroactively.
            </div>
          );
        }
        const b = entry.bundle;
        const deltas = prev ? verdictDeltas(prev, b) : [];
        prev = b;
        return (
          <article className="card" key={b.root} id={b.period_label ?? b.root}>
            <h3 style={{ margin: 0 }}>
              {b.period_label ?? "ad hoc"}{" "}
              <span className="muted small">
                {b.period_from?.slice(0, 10)} → {b.period_to?.slice(0, 10)}
              </span>
            </h3>
            <p className="small" style={{ fontFamily: "var(--mono)" }}>
              root {b.root}
              <br />
              prev {b.previous_root ?? "none (first link)"}
            </p>
            <p className="small muted">
              received {b.received_at.slice(0, 10)} · signing {b.provenance_mode} ·{" "}
              verification {b.verification_ok ? "passed" : "FAILED"} ·{" "}
              <a href={`/s/${slug}/bundle/${b.root}.json`}>download</a>
            </p>
            {deltas.length > 0 && (
              <>
                <h3>Verdict changes this period</h3>
                <table>
                  <tbody>
                    {deltas.map((d) => (
                      <tr key={d.control_id}>
                        <td><code>{d.control_id}</code></td>
                        <td>
                          <span className={`verdict v-${d.from}`}>{d.from.replace("_", " ")}</span>
                          {" → "}
                          <span className={`verdict v-${d.to}`}>{d.to.replace("_", " ")}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </article>
        );
      })}

      {superseded.length > 0 && (
        <>
          <h2>Superseded bundles</h2>
          <p className="small muted">
            Re-sealed periods keep their original bundle in the record, marked
            superseded, rather than disappearing.
          </p>
          <table>
            <tbody>
              {superseded.map((b) => (
                <tr key={b.root}>
                  <td>{b.period_label}</td>
                  <td className="small" style={{ fontFamily: "var(--mono)" }}>
                    {b.root.slice(0, 16)}… superseded by {b.superseded_by!.slice(0, 16)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
