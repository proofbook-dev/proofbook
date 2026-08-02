# Proofbook Gate Action

The pull-request instrumentation gate (mode 3). Not a runtime check:
production traces do not exist at PR time. The gate checks that the
code still emits the events that back the controls you have been
sealing evidence for. If an engineer deletes the last approval
checkpoint, the PR fails with the control's name and the removed
file:line, before the evidence quietly reads `unevaluable` a month
later.

```yaml
name: gate
on: pull_request
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: proofbook-dev/gate-action@v1
        with:
          baseline: origin/main
          fail-on: control-regression
```

## What it will and will not flag

Fails only when an event type backing an evidenced control drops to
**zero** emitting call sites relative to the baseline lock. It will not
flag removing three of four model-call sites, refactors that move
instrumentation, or controls that were never evidenced in the first
place. A blocking check earns exactly one false positive before the
team adds `--skip` forever, so the gate under-reports by design.

## Where the baseline comes from

`.proofbook/instrumentation.lock`, read from the `baseline` ref. The
lock is written by `proof seal` after each evidence run (recording
which controls actually reached an evidenced verdict), or bootstrapped
with `proof gate --write`. Commit it. No lock on the baseline means
nothing to enforce: the gate passes and says why, so adopting it never
breaks a repository's first CI run.

A failure message reads:

```
✗ Control eu-ai-act-a14-checkpoints (Human oversight is exercised and recorded in operation)
  lost its only evidence source: no code site still emits HumanCheckpoint.
  the last emitting site, now removed:
    src/agents/claims.ts:214 (proofbook.human_checkpoint.type)
```
