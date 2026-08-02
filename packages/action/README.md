# Proofbook Evidence Action

The scheduled evidence job: seals each period while its traces still
exist, signs against the workflow's OIDC identity, records gaps
explicitly, and writes the chain report to the job summary.

```yaml
name: evidence
on:
  schedule:
    - cron: "0 6 1 * *"   # first of the month
permissions:
  id-token: write          # this line is what signs the bundle
  contents: read
jobs:
  seal:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: proofbook-dev/evidence-action@v1
        # zero required inputs; add push + a token for the hosted chain:
        # with:
        #   push: "true"
        #   proofbook-token: ${{ secrets.PROOFBOOK_TOKEN }}
```

Air-gapped and self-hosted runners work: without OIDC the seal falls
back to local signing and the bundle says so, honestly. Traces never
leave the runner; only the sealed bundle is uploaded (as an artifact,
and optionally to the hosted chain).
