import { notFound } from "next/navigation";
import { resolveShare, sharedBundles } from "@/lib/share";

/**
 * Screen four: independent verification. A dedicated page, built
 * before control detail, because if this is not real nothing else on
 * the portal matters. Every claim names what it proves and what it
 * does not, and none of it requires Proofbook's servers.
 */

export default async function Verify({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") notFound();
  const bundles = await sharedBundles(resolved.share);
  const latest = bundles.filter((b) => !b.superseded_by).at(-1);

  return (
    <>
      <h1>Verify this evidence without trusting this site</h1>
      <p>
        Everything shown here is rendered from sealed bundle files you can
        download and check on your own machine, offline. Proofbook&apos;s
        servers are not required for any step below, and a verifier that
        disagrees with this portal is evidence against the portal.
      </p>

      <h2>Procedure</h2>
      <ol className="small">
        <li>Download a bundle (below, or from any period on the Chain page).</li>
        <li>
          On any machine with Node.js, no account and no network access to
          Proofbook, run the open-source verifier:
        </li>
      </ol>
      {latest && (
        <pre>{`# ${latest.period_label ?? "latest bundle"} · root ${latest.root.slice(0, 16)}…
npx proofbook verify proofbook-${latest.period_label ?? latest.root.slice(0, 12)}.json`}</pre>
      )}
      <p className="small">
        The verifier recomputes every digest from the bytes in the bundle and
        reports check by check. Compare its output with what this portal shows;
        they must agree exactly.
      </p>

      <h2>What each check proves</h2>
      <table>
        <thead>
          <tr><th>Check</th><th>Proves</th><th>Does not prove</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>manifest</code> and file digests</td>
            <td className="small">No file in the bundle was altered after sealing.</td>
            <td className="small">That the inputs to sealing were complete.</td>
          </tr>
          <tr>
            <td><code>signature</code></td>
            <td className="small">
              The bundle root was signed by the holder of the stated key or CI
              identity at seal time.
            </td>
            <td className="small">
              Anything about runtime behaviour beyond the recorded events.
            </td>
          </tr>
          <tr>
            <td>chain link (<code>previous</code>)</td>
            <td className="small">
              Each bundle commits to its predecessor; history cannot be
              rewritten without breaking every later root.
            </td>
            <td className="small">
              That instrumentation was complete at capture time. Scope on the
              overview covers what was and was not observed.
            </td>
          </tr>
          <tr>
            <td>provenance</td>
            <td className="small">
              {latest?.provenance_mode === "sigstore-oidc"
                ? "The bundle was produced by the named repository and workflow, logged to a public transparency log."
                : "Locally signed: integrity against the stated key only. The bundle says so itself rather than implying more."}
            </td>
            <td className="small">That the producing code was itself correct.</td>
          </tr>
        </tbody>
      </table>

      <h2>Verdicts you should expect to see</h2>
      <p className="small">
        A credible evidence set is rarely all green. <code>unevaluable</code>{" "}
        means the telemetry could not support a conclusion and the bundle says
        exactly what was missing; it is not a failure state, and its absence
        across every control on rich telemetry would itself be suspicious.
        Content (prompts, completions, tool arguments) appears only as sha256
        digests: the absence of content is by design, not omission.
      </p>

      <h2>Sources</h2>
      <p className="small">
        The verifier and its specification are open source:{" "}
        <a href="https://github.com/proofbook-dev/proofbook">github.com/proofbook-dev/proofbook</a>{" "}
        (packages/seal is the verification implementation this portal runs).
      </p>
    </>
  );
}
