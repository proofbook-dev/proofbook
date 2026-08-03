-- Proofbook hosted chain + auditor portal.
--
-- Two populations, one hard boundary:
--   Customers (orgs) authenticate, push bundles, mint share links.
--   Recipients never authenticate. They are served exclusively by the
--   server with the service role; nothing recipient-facing goes through
--   the client API, and RLS is the backstop, not the mechanism.

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Bearer tokens for CI push (PROOFBOOK_TOKEN). Only the sha256 of the
-- token is stored; the plaintext is shown once at creation.
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  prefix text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- A pushed, server-verified bundle. `files` is the exact map the CLI
-- pushed: digests, verdicts and signatures, never trace content.
create table public.bundles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  root text not null,
  previous_root text,
  subject text not null,
  period_label text,
  period_from timestamptz,
  period_to timestamptz,
  frameworks text[] not null default '{}',
  summaries jsonb not null default '[]'::jsonb,
  verification jsonb not null,
  verification_ok boolean not null,
  provenance_mode text not null default 'local-ed25519',
  files jsonb not null,
  superseded_by text,
  received_at timestamptz not null default now(),
  unique (org_id, root)
);
create index bundles_org_period on public.bundles (org_id, period_from);

-- Scoped, expiring, revocable recipient access. A grant names periods
-- and frameworks, never "the account".
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  slug text not null unique,
  label text not null,
  period_from text,
  period_to text,
  frameworks text[],
  email_gate boolean not null default false,
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.share_access_log (
  id bigint generated always as identity primary key,
  share_id uuid not null references public.share_links(id) on delete cascade,
  at timestamptz not null default now(),
  email text,
  section text not null,
  user_agent text
);
create index share_access_log_share on public.share_access_log (share_id, at desc);

-- RLS for the customer side.
create function public.is_org_member(org uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = org and m.user_id = auth.uid()
  );
$$;

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.api_tokens enable row level security;
alter table public.bundles enable row level security;
alter table public.share_links enable row level security;
alter table public.share_access_log enable row level security;

create policy org_read on public.orgs for select using (public.is_org_member(id));
create policy members_read on public.org_members for select using (user_id = auth.uid() or public.is_org_member(org_id));
create policy tokens_rw on public.api_tokens for all using (public.is_org_member(org_id));
create policy bundles_read on public.bundles for select using (public.is_org_member(org_id));
create policy shares_rw on public.share_links for all using (public.is_org_member(org_id));
create policy access_log_read on public.share_access_log for select
  using (exists (select 1 from public.share_links s where s.id = share_id and public.is_org_member(s.org_id)));
