// Edge Function: lets an admin create a user account (email + password) from the
// admin page. It runs on Supabase, so the service-role key never reaches a browser.
//
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function -> Via Editor,
// name it "admin-create-user", paste this file, Deploy. Keep "Verify JWT" ON.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Only the booking site may call this from a browser.
const ALLOWED_ORIGIN = "https://alifajmi637-gif.github.io";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Not signed in" }, 401);

  // Check admin rights as the caller, through the same is_admin() the app uses.
  const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isAdmin, error: adminErr } = await asCaller.rpc("is_admin");
  if (adminErr || isAdmin !== true) return json({ error: "Admins only" }, 403);

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  if (password.length < 8 || password.length > 72) {
    return json({ error: "Password must be 8–72 characters." }, 400);
  }

  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: caller } = await service.auth.getUser(jwt);

  // email_confirm: the admin vouches for the address, so no confirmation email is needed.
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    const exists = /already|registered|exists/i.test(error.message);
    return json({ error: exists ? "A user with that email already exists." : "Couldn't create the user." }, 400);
  }

  // Record it in the activity log alongside the database's own audit entries.
  await service.from("audit_log").insert({
    actor: caller?.user?.id ?? null,
    action: "INSERT",
    table_name: "users",
    row_id: data.user.id,
    new_data: { email: data.user.email },
  });

  return json({ id: data.user.id, email: data.user.email });
});
