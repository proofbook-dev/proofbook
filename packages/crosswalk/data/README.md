# The Proofbook Crosswalk

A versioned, declarative mapping between runtime evidence from agentic
AI systems and the compliance frameworks that ask about it. Licensed
CC BY 4.0, separately from the Proofbook code, and useful without it,
including as a plain checklist against the AI section of a vendor
questionnaire.

Frameworks shipped:

| File | Framework | Controls |
|---|---|---|
| `frameworks/eu-ai-act.yaml` | EU AI Act (2024/1689), Articles 12, 13, 14, 15, 50 | 13 |
| `frameworks/iso-42001.yaml` | ISO/IEC 42001 (2023), Annex A | 8 |
| `frameworks/nist-ai-rmf.yaml` | NIST AI RMF 1.0 | 7 |

`equivalence.yaml` maps one evidence set to the controls it supports
across frameworks, so a period sealed once answers several
questionnaires.

## Format

A control has an id, an original paraphrase of the requirement (never
the standard's text), and one or more assertions. Every assertion
declares:

- **source_class**: `observed` at runtime, `configured` and verified,
  or `declared` by a named owner. Verdicts carry this distinction all
  the way to the auditor.
- **expression**: a closed, tiny language over the event model
  (`coverage`, `ratio`, `exists`, `count`, `distinct`, `declared`,
  `config`, …). No eval, validated at load, rejected at authoring time
  rather than in someone's CI at 2am.
- **verdict_map**: the format's central safety property. `no_data` maps
  to `unevaluable` and nothing else, so no control can pass on missing
  telemetry, accidentally or otherwise.

`schema/crosswalk.schema.json` is the independently usable JSON Schema.

## Authoring a control

```yaml
- id: my-framework-oversight
  article: "§ 4.2"
  title: Human oversight is exercised
  requirement_summary: >
    Your own paraphrase of the requirement.
  assertions:
    - id: my-oversight-exercised
      description: At least one human checkpoint was recorded.
      source_class: observed
      capability: human_oversight   # required for observed assertions
      expression: "exists(HumanCheckpoint)"
      verdict_map:
        pass: evidenced
        fail: not_evidenced
        no_data: unevaluable
```

Validate by loading: `proof crosswalk list` in a checkout of
[proofbook](https://github.com/proofbook-dev/proofbook) refuses any
file that breaks the grammar or the safety constraints.

## Licence

See `LICENCE-NOTES.md`. Requirement summaries are Proofbook's own
paraphrases; no standard's text is reproduced, and a runtime check
supports an obligation rather than satisfying it. The files say so
explicitly and tooling must not claim otherwise.

## Where this lives

Source of truth: `packages/crosswalk/data` in the
[proofbook monorepo](https://github.com/proofbook-dev/proofbook). The
[proofbook-dev/crosswalk](https://github.com/proofbook-dev/crosswalk)
repository is a published mirror of this directory.
