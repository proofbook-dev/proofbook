# 002 · Content digests are unsalted at capture, for now

The build prompt asks the seal layer to store "a salted hash plus an
optional pointer". Sealing is the wrong place to salt, and this records
why, so it isn't rediscovered later.

Plaintext is discarded at normalise time; by the time a bundle is
sealed, only sha256 digests exist. HMAC-ing an existing digest with a
bundle-carried salt defends against nothing: an attacker dictionary-
guessing a short prompt has the salt (it is in the bundle) and can
compute the same two hashes. A salt only helps if it is applied at the
moment of capture and kept out of the artifact, or if it is applied at
capture and disclosed, which still breaks precomputed rainbow tables.

Therefore:

- Capture-time salting belongs in `instrument` and in the normaliser's
  hashing step, configured per deployment (`proofbook.yml`), and lands
  with the instrument distro.
- Until then, content digests are plain sha256 and every bundle
  manifest says so: `content_ref_hashing: "sha256-unsalted"`. Honest
  labelling over implied protection.
- Verifiers must read the hashing mode from the manifest rather than
  assume one.
