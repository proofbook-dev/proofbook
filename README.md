# Proofbook

**The evidence layer for agentic AI systems.** Your agents already emit OpenTelemetry traces. Proofbook evaluates them against named compliance controls (EU AI Act, ISO/IEC 42001, NIST AI RMF) and seals the result into signed, hash-chained bundles an auditor can verify offline, without trusting you or us.

[proofbook.dev](https://proofbook.dev) · [Documentation](https://proofbook.dev/docs/) · [Portal](https://portal.proofbook.dev) · [Crosswalk](https://github.com/proofbook-dev/crosswalk)

[![npm](https://img.shields.io/npm/v/proofbook)](https://www.npmjs.com/package/proofbook) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Local, offline, no account. Traces never leave your machine; reports and bundles carry verdicts, counts and sha256 digests, never content.

## Two minutes to a report

Requires Node 20+. No install, no API key, no telemetry.

```sh
npx proofbook report ./traces/
```

Point it at OTLP JSON or JSONL (the OTel collector file exporter's output, or a `proof pull` from your vendor) and it tells you what your telemetry can and cannot prove:

```
Found 6 spans (1 file, 2026-07-10 to 2026-07-10)
Detected: OpenTelemetry GenAI conventions (otel-genai, otel-genai-latest)

Coverage check:
  ✓ Span mapping        complete
  ✓ Model calls         complete
  ✓ Human checkpoints   complete
  ⚠ Content digests     some model calls are missing content digests (1 of 2)
                        → 2 controls degraded

eu-ai-act: 7 evidenced · 0 partial · 1 not evidenced · 0 contradicted · 5 unevaluable
iso-42001: 4 evidenced · 0 partial · 1 not evidenced · 0 contradicted · 3 unevaluable
nist-ai-rmf: 5 evidenced · 0 partial · 0 not evidenced · 0 contradicted · 2 unevaluable
```

Every gap names the engineering task that closes it: `proof explain human-checkpoints` prints the exact attributes to emit and the controls they unlock.

## How it works

```
OTLP traces ──▶ normalize ──▶ evaluate against the crosswalk ──▶ Agent Trust Report
 (yours,          (event        (per-control assertions,           (HTML + JSON)
  local)          model)         open, versioned)                       │
                                                                        ▼
                              proof seal: hash-chained, signed bundle ──▶ verify offline
```

Five verdicts: `evidenced`, `partially_evidenced`, `not_evidenced`, `contradicted`, `unevaluable`. The format's central safety property: missing data can only ever map to `unevaluable`, so no control can pass on absent telemetry. Every mapping in the [crosswalk](https://github.com/proofbook-dev/crosswalk) declares `relation: supports`; a runtime check supports an obligation, it never satisfies one, and there is a page on [what Proofbook cannot evidence](https://proofbook.dev/docs/#limits).

One clock matters: trace vendors retain days, audits ask about months, and deleted telemetry is unrecoverable. Whatever is not sealed while it exists can never be evidence. `proof pull` prints the exact retention horizon for your vendor on every run.

## Commands

```
proof init          detect your stack, write config, explain the retention clock
proof report        evaluate traces → Agent Trust Report
proof pull          fetch traces: --source datadog|langfuse|langsmith|tempo|s3
proof watch         local OTLP/HTTP receiver for development
proof seal          seal a period into a signed, chained bundle
proof chain         continuity report: periods, gaps, verification
proof push          send a sealed bundle to the hosted chain
proof list          list evidence sets on the hosted chain (subject, periods, root)
proof delete        remove an evidence set from the hosted chain: root prefix or --subject (--yes)
proof verify        verify any bundle offline, check by check
proof gate          PR gate: fail when code stops emitting a control's evidence
proof answer        draft questionnaire answers from evidence
proof export        evidence for GRC platforms: --format vanta|drata
proof explain       a coverage gap → the engineering task that closes it
proof doctor        diagnostics: generations, mapping, capabilities, chain
proof mcp           read-only MCP server for coding agents
proof crosswalk     list frameworks and controls, show one control
```

`report`, `verify`, `gate` and `doctor` take `--json` (one versioned JSON document on stdout, nothing else). Exit codes mean something: `0` clean, `1` tool error, `2` controls regressed or bundle invalid, `3` insufficient data, `4` provenance expectations unmet. Full reference: [proofbook.dev/docs](https://proofbook.dev/docs/).

## Sealing in CI

One workflow file pulls nightly, seals each month with the workflow's OIDC identity (Sigstore, public transparency log entry), and pushes to the hosted chain. Copy the template for your source from [`examples/workflows/`](./examples/workflows/) and add the secrets it names. A missed run becomes an explicit, recorded gap, never silence.

The signature binds the bundle to the repository, workflow and commit that produced it, which is why evidence cannot be fabricated after the fact, by you or by us.

- [`proofbook-dev/evidence-action`](https://github.com/proofbook-dev/evidence-action): scheduled seal and push.
- [`proofbook-dev/gate-action`](https://github.com/proofbook-dev/gate-action): fails a PR only when it removes the last code site emitting the events behind an evidenced control, and names the control, the event and the removed file:line.

## Verifying a bundle (recipient side)

```sh
npx proofbook verify bundle-2026-07/
```

Recomputes every digest, checks the chain link and the signature, and prints check-by-check results. Runs anywhere, needs no account, and the verifier is open source, so a security team can read exactly what a VALID means.

## MCP

Read-only in both forms; nothing can seal, push, share or attest through MCP.

```sh
# local traces, stdio: the instrumentation loop for coding agents.
# Run inside the repo whose traces you want to query; @latest matters
# (mcp shipped in 0.1.2, and a bare "proofbook" can hit npx's stale cache)
claude mcp add proofbook -- npx -y proofbook@latest mcp
claude mcp list          # → proofbook: … - ✔ Connected

# pushed bundles, remote clients: coverage, verdicts, gaps, regressions
claude mcp add proofbook https://api.proofbook.dev/mcp \
  -t http -H "Authorization: Bearer $PROOFBOOK_TOKEN"
```

Not connecting? The four causes, in order of likelihood: stale npx cache (pin `@latest`), project scope (`claude mcp add` registers for the current project; use `--scope user` for everywhere), an already-open session (restart, then `/mcp`), or no traces in the directory (the tools say so instead of failing). Full walkthrough: [docs](https://proofbook.dev/docs/#mcp).

`get_coverage_gaps` returns each missing capability with the exact attributes that close it, so an agent can open the PR that instruments it.

## The portal

[portal.proofbook.dev](https://portal.proofbook.dev) receives pushed bundles and gives the compliance side a place to self-serve: verdict registers with derivations, regression deltas between periods, scoped share links a reviewer verifies offline, questionnaire answers, and declared sign-offs recorded beside sealed bundles, never inside them. The CLI, crosswalk and verifier are free forever; the hosted chain and portal are the paid tier.

## Development

Node 22+ and [pnpm](https://pnpm.io):

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm proof report ./fixtures/traces/   # run the CLI from source
```

| Package | What it does |
|---|---|
| `packages/schema` | The internal event model and verdict types |
| `packages/normalize` | OTLP → events, generation detection, completeness scoring |
| `packages/crosswalk` | Control definitions and the assertion expression language |
| `packages/crosswalk/data/` | The crosswalk data itself; mirrored to [proofbook-dev/crosswalk](https://github.com/proofbook-dev/crosswalk) |
| `packages/engine` | Evaluates controls against an event batch |
| `packages/report` | The Agent Trust Report HTML renderer |
| `packages/seal` | Deterministic, hash-chained bundle construction and verification |
| `packages/provenance` | Sigstore keyless signing, in-toto attestation, offline verify |
| `packages/store` | The local evidence store: period continuity, gap recording |
| `packages/sources` | Vendor trace connectors: datadog, langfuse, langsmith, tempo, s3 |
| `packages/gate` | The PR instrumentation gate: scanner, lock file, regression diff |
| `packages/cli` | The `proof` command |
| `packages/action` · `packages/gate-action` | The GitHub Actions, mirrored to their own repos |

## License

[MIT](./LICENSE)
