-- The CLI no longer auto-exposes new tables to the API roles; every
-- grant is explicit. anon gets nothing: recipients are served by the
-- server with the service role, never through the client API.

grant usage on schema public to authenticated, service_role;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Customers (RLS applies on top of these).
grant select on public.orgs, public.org_members, public.bundles, public.share_access_log to authenticated;
grant select, insert, update on public.api_tokens, public.share_links to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
