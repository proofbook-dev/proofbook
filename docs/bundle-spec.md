# Proofbook bundle specification · v0.1.0

This document is the verification contract. Anyone can implement it and
must reach the same answer as `proofbook verify`, offline, without any
Proofbook code or service. If the tool and this document ever disagree,
the release carrying the discrepancy is defective.

## Layout

A bundle is a directory (or an archive of one) with this tree:

```
manifest.json            canonical JSON; digests of every content file
coverage.json            counts, completeness, detections, unmapped, conflicts
controls/<fw>/<id>.json  one control result per file, derivation included
evidence/events.merkle   merkle tree over per-event digests
evidence/samples.json    metadata-only event samples
provenance/local.json    signing mode and public key (and, later, the
                         Sigstore certificate and log entry)
signature                detached signature, hex
```

`manifest.json`, `signature` and `provenance/local.json` are the only
files not listed in the manifest's digest table.

## Canonical JSON

All hashed content is serialised as canonical JSON: object keys sorted
lexicographically at every depth, no whitespace, `undefined` members
omitted, arrays in order. `manifest.json` is stored in this form, so
its bytes are reproducible from its content.

## Verification algorithm

1. **Manifest.** Parse `manifest.json`. Re-serialise it canonically;
   the result must byte-equal the stored file.
2. **File digests.** For every `(path, digest)` in `manifest.files`,
   the file must exist and its sha256 (over raw bytes) must equal
   `digest`.
3. **Closure.** No file may exist in the bundle that is neither in
   `manifest.files` nor one of the three uncovered files above.
4. **Event tree.** In `evidence/events.merkle`, recompute the merkle
   root from `leaves`: pair adjacent hex leaves, hash
   `sha256(left_hex || right_hex)` over the concatenated hex strings,
   promote an odd tail unchanged, repeat to one node. It must equal
   `root`, and `leaves.length` must equal `leaf_count`. Each leaf was
   produced as `sha256(event_type + "\n" + canonical(event))`; a party
   holding the original traces can recompute leaves independently and
   check membership.
5. **Root.** The bundle root is `sha256(manifest.json bytes)`.
6. **Signature.** `signature` is a hex ed25519 signature over the raw
   32-byte root digest, verifying against `public_key` in
   `provenance/local.json` (mode `local-ed25519`). CI-signed bundles
   (mode `sigstore-oidc`, later) additionally carry a certificate and a
   transparency log entry, verified per the Sigstore bundle format.
7. **Chain.** `manifest.previous` is `null` (first period) or the
   64-hex root of the prior period's bundle. Continuity across a series
   of bundles is verified by walking the sequence: each bundle's
   `previous` must equal the predecessor's computed root, periods must
   not overlap, and a gap must be visible as a broken link.

## What verification proves, and what it does not

Proves: the bundle's content has not been altered since sealing; the
verdicts, derivations and coverage statements are the ones the producer
sealed; the event digest tree is internally consistent; the bundle
occupies a stated position in a chain.

Does not prove: that instrumentation was complete at capture time, or
(for `local-ed25519`) who controlled the signing key. The first is
addressed by the coverage statement inside the bundle; the second by
CI-bound OIDC signing with a public transparency log entry.

## Privacy invariants

A conforming bundle contains no prompt text, completion text, tool
arguments or results, end-user identifiers, or credentials. Content
appears only as digests; `manifest.content_ref_hashing` states the
digest scheme (`sha256-unsalted` in this version). A verifier that
finds payload content in a bundle should treat the producer as
non-conforming.

## Attestation (provenance package)

Bundles sealed by v0.1.0+ additionally carry
`provenance/attestation.intoto.json`: a DSSE envelope
(`application/vnd.in-toto+json`) whose payload is an in-toto Statement
with the bundle root as its single subject digest and a predicate
(`https://proofbook.dev/evidence/v0.1`) recording period, crosswalk
pins, normaliser and schema versions, verdict summaries, the coverage
file digest, the chain link, and the builder identity.

Verification, in addition to the seven structural steps:

8. **Envelope.** The DSSE signature verifies over
   `PAE(payloadType, payload)` against the expected key (local mode) or
   the Sigstore certificate (keyless mode, `provenance/sigstore.json`,
   verified per the Sigstore bundle format including the transparency
   log inclusion proof).
9. **Subject.** `subject[0].digest.sha256` equals the recomputed root.
   An attestation for any other content must be rejected.
10. **Identity.** When the verifier expects a repository, the statement's
    `predicate.builder` must be mode `github-oidc` with a matching
    `repository` (and, in keyless mode, a certificate SAN matching the
    workflow). A `local-ed25519` builder never satisfies a repository
    expectation: local attestations bind content to a key, not to a
    place of production. Expectations belong to the verifier; a bundle
    cannot vouch for itself.
