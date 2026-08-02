# Proofbook

An evidence layer for agentic AI systems: turn the traces your agents
already emit into verifiable, signed audit evidence. Local, offline, no
account. Traces never leave your machine; reports and bundles contain
digests, never content.

Point it at a directory of OTLP traces and it produces an Agent Trust
Report: control-by-control verdicts against compliance frameworks
(EU AI Act Articles 12, 14 and 50 today), with honest `unevaluable`
verdicts where the telemetry cannot support a conclusion. Seal a period
and you get a signed, hash-chained bundle an auditor can verify offline.

## Installing (current state)

Not yet published to npm. Until then, run it from a clone.

Requirements: Node 22+ and [pnpm](https://pnpm.io).

```sh
git clone git@github.com:proofbook-dev/proofbook.git
cd proofbook
pnpm install
```

Everything runs through the `proof` script:

```sh
pnpm proof report ./traces        # evaluate traces → Agent Trust Report (HTML + JSON)
pnpm proof seal --period last-month --sign local
pnpm proof chain                  # the continuity report: periods, gaps, verification
pnpm proof verify <bundle-dir>    # verify a bundle offline, check by check
pnpm proof gate                   # PR gate: fail when code stops emitting a control's evidence
pnpm proof help                   # the full command list
```

No configuration is required for first value: `pnpm proof report` with a
directory of OTLP JSON or JSONL traces produces a legible report with
zero setup.

Verify the checkout:

```sh
pnpm typecheck
pnpm test
```

## In CI

Two GitHub Actions wrap the same CLI:

- [`proofbook-dev/evidence-action`](https://github.com/proofbook-dev/evidence-action)
  seals each period on a schedule, signs with the workflow's OIDC
  identity and records gaps explicitly.
- [`proofbook-dev/gate-action`](https://github.com/proofbook-dev/gate-action)
  is the pull-request instrumentation gate: it fails only when a change
  removes the last code site emitting the events that back an evidenced
  control.

## Layout

| Package | What it does |
|---|---|
| `packages/schema` | The internal event model and verdict types |
| `packages/normalize` | OTLP → events, generation detection, completeness scoring |
| `packages/crosswalk` | Framework control definitions and the assertion expression language |
| `packages/engine` | Evaluates controls against an event batch |
| `packages/report` | The Agent Trust Report HTML renderer |
| `packages/seal` | Deterministic, hash-chained bundle construction and verification |
| `packages/provenance` | Sigstore keyless signing, in-toto attestation, offline verify |
| `packages/store` | The local evidence store: period continuity, gap recording |
| `packages/gate` | The PR instrumentation gate: scanner, lock file, regression diff |
| `packages/cli` | The `proof` command |
| `crosswalk/` | The published crosswalk data (frameworks, equivalences, JSON Schema) |
