# 001 · run_id = trace_id

Decided at stage 3, because `coverage()` semantics depend on it.

A **run** is one trace: the full causal execution triggered by one
initiating request. Nested agent invocations share the run; the
parent/child structure is carried by `Delegation` events, and per-agent
attribution by `agent_id` on `AgentRun`.

Why not span-scoped runs (one run per `invoke_agent` span):

- `coverage(AgentRun, ...)` and `ratio(X[linked(AgentRun)], X)` read
  naturally over traces: "every execution produced lifecycle records",
  "every model call belongs to an attributable execution".
- Span-scoped runs double-count nested agents in denominators, so a
  multi-agent trace would weigh more than a single-agent trace in every
  coverage statistic for no evidentiary reason.
- The trace id is the one identifier every telemetry generation agrees
  on. Span-scoped run identity varies per framework.

Cost: "runs evaluated" in a bundle's coverage statement means traces,
not agent invocations. The report must label it that way.
