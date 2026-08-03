import { notFound } from "next/navigation";
import { assembleChain, coverageOf, totalCounts, VERDICTS } from "@/lib/bundles";
import { resolveShare, sharedBundles } from "@/lib/share";

/**
 * Screen one: the four-minute view. The vendor risk analyst sees only
 * this. Verdict counts with the bad numbers at equal weight, the scope
 * statement above the fold, verification status with the independent
 * reproduction offered immediately, and the bundle download. No
 * scoring, no grading, no adjectives about the customer.
 */

const VERDICT_LABEL: Record<string, string> = {
  evidenced: "Evidenced",
  partially_evidenced: "Partially evidenced",
  not_evidenced: "Not evidenced",
  contradicted: "Contradicted",
  unevaluable: "Unevaluable",
};

export default async function Overview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") notFound();
  const bundles = await sharedBundles(resolved.share);
  const chain = assembleChain(bundles);
  const live = bundles.filter((b) => !b.superseded_by);
  const latest = live.at(-1);

  if (!latest) {
    return (
      <>
        <h1>{resolved.org.name}</h1>
        <p className="muted">
          No sealed evidence bundles fall inside this grant&apos;s scope yet.
        </p>
      </>
    );
  }

  const counts = totalCounts(live.flatMap((b) => b.summaries));
  const coverage = coverageOf(latest) as {
    counts?: { spans_seen?: number; spans_mapped?: number; files?: string[] };
  } | null;
  const gaps = chain.filter((e) => e.kind === "gap");
  const periods = live
    .map((b) => b.period_label)
    .filter(Boolean);
  const frameworks = [...new Set(live.flatMap((b) => b.frameworks))];

  return (
    <>
      <h1>{latest.subject}</h1>
      <p className="muted">
        Periods {periods[0]} to {periods.at(-1)} · {frameworks.join(", ")} ·{" "}
        {live.length} sealed bundle{live.length === 1 ? "" : "s"}
        {gaps.length > 0 ? " · gaps present, shown below" : ""}
      </p>

      <div className="counts">
        {VERDICTS.map((v) => (
          <div className="count" key={v}>
            <b>{counts[v]}</b>
            <span>{VERDICT_LABEL[v]}</span>
          </div>
        ))}
      </div>
      {gaps.length > 0 && (
        <div className="gapbox">
          {gaps.flatMap((g) => (g.kind === "gap" ? g.labels : [])).join(", ")}{" "}
          {gaps.flatMap((g) => (g.kind === "gap" ? g.labels : [])).length === 1 ? "was" : "were"}{" "}
          never sealed. Evidence for missing periods cannot be produced
          retroactively; the chain records the hole rather than hiding it.
        </div>
      )}

      <section className="scope">
        <h3>Scope</h3>
        <p className="small">
          Evidence covers the system named <strong>{latest.subject}</strong> for
          the periods listed, evaluated against {frameworks.join(" and ")}.
          {coverage?.counts?.spans_seen !== undefined && (
            <>
              {" "}
              The latest bundle derives from {coverage.counts.spans_seen} telemetry
              spans{coverage.counts.spans_mapped !== undefined &&
                `, ${coverage.counts.spans_mapped} of which mapped to evaluable events`}.
            </>
          )}{" "}
          Verdicts describe what the telemetry demonstrates and nothing beyond
          it; controls the telemetry cannot support read as unevaluable rather
          than passing. Prompt and completion content is hashed at source and
          never leaves the producer&apos;s systems.
        </p>
      </section>

      <h2>Verification status</h2>
      <table>
        <tbody>
          {latest.verification.checks.map((c) => (
            <tr key={c.id}>
              <td className={c.ok ? "check-ok" : "check-bad"}>{c.ok ? "✓" : "✗"} {c.id}</td>
              <td className="small">{c.detail}</td>
            </tr>
          ))}
          <tr>
            <td className="check-ok">✓ signing mode</td>
            <td className="small">{latest.provenance_mode}</td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">
        These checks were computed by this server, which you have no reason to
        trust. Reproduce them yourself:
      </p>
      <pre>{`curl -LO ${process.env.NEXT_PUBLIC_PORTAL_URL ?? ""}/s/${slug}/bundle/${latest.root}.json
npx proofbook verify ${latest.root.slice(0, 12)}….json`}</pre>
      <p className="small">
        <a className="btn" href={`/s/${slug}/bundle/${latest.root}.json`} download>
          Download latest bundle
        </a>{" "}
        <a className="btn" href={`/s/${slug}/verify`}>
          Full verification procedure
        </a>
      </p>
    </>
  );
}
