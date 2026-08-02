# 003 · The gate fires only at zero emitting sites

Decided at stage 10, because the gate's threshold is the difference
between a control that stays protected and a check the team disables.

`proof gate` fails a PR only when an event type backing an evidenced
control drops from at least one emitting call site to **zero**. Never
on partial reduction, never on moved instrumentation, never for
controls that did not reach an evidenced verdict in the last sealed
period.

Why zero and not "fewer":

- A blocking check gets one false positive. After that the team adds a
  skip, and a skipped gate protects nothing while appearing to. The
  cost asymmetry is stark: a missed regression surfaces honestly a
  month later as `unevaluable` in the sealed bundle; a false block
  destroys the gate permanently.
- "Fewer sites" is not evidence of less emission. Refactors merge call
  sites; wrappers centralise them. Site count is a proxy with noise in
  both directions, and only its zero point is meaningful: zero sites
  cannot emit.
- The same reasoning picks the signal set. Only distinctive literals
  (dotted attribute keys, snake_case operation names, instrumentation
  package names) count as emission signals. A generic word would record
  phantom sites whose later deletion looks like a regression.

Consequences accepted deliberately:

- Removing most, but not all, instrumentation passes the gate. The
  scheduled evidence run still reports the coverage drop; the gate is
  not the last line of defence, the sealed verdicts are.
- Controls whose telemetry the scanner cannot see (event types with no
  hand-written signals and no curated SDK match) are unenforced and the
  gate says so, rather than guessed at.

The enforcement set comes from `.proofbook/instrumentation.lock`,
written by `proof seal` after evaluation so `evidenced: false` controls
are excluded: the gate protects evidence that exists, it does not
demand evidence that never did.
