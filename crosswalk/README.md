# The Proofbook Crosswalk

A versioned, declarative mapping between runtime evidence from agentic
AI systems and the compliance frameworks that ask about it. Licensed
CC BY 4.0, separately from the Proofbook code, and useful without it  - 
including as a plain checklist against the AI section of a vendor
security questionnaire.

## Layout

```
frameworks/       one YAML file per framework
equivalence.yaml  which controls the same evidence supports across frameworks
schema/           the JSON Schema every framework file validates against
LICENCE-NOTES.md  what this repository may never contain
```

## Format

Each control carries original paraphrases (never standard text), and
each assertion declares three things no other control mapping does:

- **source_class** - `observed` at runtime, `verified` in
  configuration, or `declared` by a named owner. Demonstrated fact and
  assertion are never conflated.
- **expression** - a deterministic check over the internal event model,
  in a small closed function set (`coverage`, `ratio`, `exists`, …).
- **verdict_map** - with a format-level invariant: `no_data` maps to
  `unevaluable`, always. Missing telemetry can never produce a pass.

## Versioning

Framework files are pinned by content hash in every evidence bundle, so
a verdict is always traceable to the exact crosswalk text that produced
it. `crosswalk_version` follows semver; identifiers are stable across
patch and minor versions.
