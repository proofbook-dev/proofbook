import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * Two clients, two trust levels.
 *
 * The user client carries the visitor's auth cookie and is bound by
 * RLS: it is the customer surface. The service client bypasses RLS and
 * serves the recipient surface, where access is decided by share-link
 * scope, not by identity; recipients have no accounts by design.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;

export function serviceClient(): SupabaseClient {
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

export async function userClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (all) => {
        try {
          for (const { name, value, options } of all) store.set(name, value, options);
        } catch {
          /* server component render; middleware refresh handles it */
        }
      },
    },
  });
}
