# Proofbook portal

The hosted chain and auditor portal: receives sealed bundles from
`proof push`, re-verifies them on receipt with the same open-source
verifier a recipient runs offline, and serves scoped, expiring share
links to the people who need to read the evidence: vendor risk
analysts, external auditors and security engineers, none of whom ever
create an account.

The governing rule, from the product spec: the portal must be
verifiable without trusting Proofbook. Every verification claim shown
in the UI comes with the command that reproduces it independently, and
the downloaded bundle verifies offline with `proofbook verify`.

## Running locally

Supabase runs in its own containers on ports **55520-55529** (API
55521, DB 55522, Studio 55523, Mailpit 55524), chosen not to collide
with the other local Supabase stacks on this machine.

```sh
cd apps/portal
npx supabase start          # applies migrations
pnpm dev                    # Next.js on http://localhost:55530
```

Copy the keys `supabase start` prints into `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55521
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
NEXT_PUBLIC_PORTAL_URL=http://localhost:55530
```

Sign in at `/login` (magic links land in Mailpit at
http://127.0.0.1:55524), create an org, mint a push token, then from
any repo with sealed evidence:

```sh
PROOFBOOK_URL=http://localhost:55530 PROOFBOOK_TOKEN=pbk_… proof push
```

Create a share link on the dashboard and open `/s/<slug>`.

## Surfaces

- `POST /v1/bundles`: the receiving end of `proof push`. Bearer token,
  `{ root, files }`. Bundles failing verification are refused with the
  failing checks, not stored. Idempotent per root; a re-sealed period
  supersedes visibly.
- `/s/<slug>`: recipient portal. Four-minute view, control detail with
  source-class distinction, chain with loud gaps, independent
  verification page, bundle download. Server-rendered, works without
  JavaScript, no third-party requests of any kind.
- `/dashboard`: customer surface. Push tokens, received chain, share
  links (scope, expiry, revocation, email gate) and per-link access
  logs. Deliberately minimal, not an analytics product.

## Access model

Share links grant a period range and framework set, never the account.
30-day expiry by default, instantly revocable (recipients see an honest
"access withdrawn", not a 404), optional email gate whose collected
address watermarks the view and feeds the access log the customer sees.
