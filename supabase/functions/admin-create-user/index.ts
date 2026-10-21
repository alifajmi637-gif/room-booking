// Edge Function: user management for admins (list, create, disable/enable,
// reset password, delete). It runs on Supabase, so the service-role key never
// reaches a browser, and it re-checks that the caller is an admin every time.
//
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function -> Via Editor,
// name it "admin-create-user" (keeps the name of the first version), paste this file, Deploy. Keep "Verify JWT" ON.

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOREVER = "876000h";  // ~100 years: Supabase's way of disabling an account

function checkPassword(password: string): string | null {
  return password.length < 8 || password.length > 72 ? "Password must be 8–72 characters." : null;
}

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

  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerData } = await service.auth.getUser(jwt);
  const callerId = callerData?.user?.id ?? null;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const action = String(body.action ?? "");

  // Everything below is recorded next to the database's own audit entries.
  const audit = (act: string, rowId: string, data: Record<string, unknown>) =>
    service.from("audit_log").insert({ actor: callerId, action: act, table_name: "users", row_id: rowId, new_data: data });

  const adminIds = async () => {
    const { data } = await service.from("admins").select("user_id");
    return new Set((data ?? []).map((r: { user_id: string }) => r.user_id));
  };

  if (action === "list") {
    const { data, error } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return json({ error: error.message }, 400);
    const admins = await adminIds();
    const now = Date.now();
    const users = data.users
      .map((u) => ({
        id: u.id,
        email: u.email ?? "",
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        disabled: !!u.banned_until && new Date(u.banned_until).getTime() > now,
        is_admin: admins.has(u.id),
        is_you: u.id === callerId,
      }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return json({ users });
  }

  if (action === "create") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);
    const bad = checkPassword(password);
    if (bad) return json({ error: bad }, 400);
    // email_confirm: the admin vouches for the address, so no confirmation email is needed.
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) {
      const exists = /already|registered|exists/i.test(error.message);
      return json({ error: exists ? "A user with that email already exists." : error.message }, 400);
    }
    await audit("INSERT", data.user.id, { email });
    return json({ ok: true });
  }

  // The remaining actions target one existing user.
  const userId = String(body.userId ?? "");
  if (!UUID_RE.test(userId)) return json({ error: "Invalid user" }, 400);
  if (userId === callerId && action !== "reset_password") {
    return json({ error: "You can't do that to your own account." }, 400);
  }
  const { data: target, error: targetErr } = await service.auth.admin.getUserById(userId);
  if (targetErr || !target?.user) return json({ error: "User not found" }, 404);
  const email = target.user.email ?? "";
  if ((action === "disable" || action === "delete") && (await adminIds()).has(userId)) {
    return json({ error: "That user is an admin. Remove their admin rights first." }, 400);
  }

  if (action === "disable" || action === "enable") {
    const { error } = await service.auth.admin.updateUserById(userId, {
      ban_duration: action === "disable" ? FOREVER : "none",
    });
    if (error) return json({ error: error.message }, 400);
    await audit("UPDATE", userId, { email, change: action === "disable" ? "disabled" : "enabled" });
    return json({ ok: true });
  }

  if (action === "reset_password") {
    const password = String(body.password ?? "");
    const bad = checkPassword(password);
    if (bad) return json({ error: bad }, 400);
    const { error } = await service.auth.admin.updateUserById(userId, { password });
    if (error) return json({ error: error.message }, 400);
    await audit("UPDATE", userId, { email, change: "reset the password of" });
    return json({ ok: true });
  }

  if (action === "delete") {
    // Their bookings go with them (bookings.user_id is ON DELETE CASCADE).
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error) return json({ error: error.message }, 400);
    await audit("DELETE", userId, { email });
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
