"use strict";

// Shared by the user page (index.html) and the admin page (admin.html).
window.App = (() => {
  // Refuse to run inside a frame (clickjacking). CSP frame-ancestors can't be set
  // from a <meta> tag on GitHub Pages, so this is the fallback.
  if (window.top !== window.self) {
    document.documentElement.textContent = "This page cannot be embedded.";
    throw new Error("framed");
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const $ = (id) => document.getElementById(id);
  const state = { user: null, settings: null };

  // ---------------------------------------------------------------------------
  // Helpers. All user-controlled text goes through textContent, never innerHTML.
  // ---------------------------------------------------------------------------

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, className, onClick) {
    const b = el("button", text, className);
    b.type = "button";
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  function showMsg(text, kind) {
    const m = $("msg");
    m.textContent = text;
    m.className = kind || "";
    m.hidden = !text;
    if (text) m.scrollIntoView({ block: "nearest" });
  }

  // Only show messages we wrote ourselves; anything unexpected becomes generic
  // so internal details never leak to the screen.
  function friendlyError(err) {
    if (!err) return "Something went wrong.";
    if (err.code === "23P01") return "That room is already booked during that time.";
    if (err.code === "22023" && err.message) return err.message;
    if (err.code === "42501") return "You don't have permission to do that.";
    if (err.code === "23503") return "That room has bookings, so it can't be deleted. Untick Active to hide it instead.";
    if (err.code === "23505") return "A room with that name already exists.";
    if (err.code === "23514") return "That isn't allowed (check the values you entered).";
    if (err.status === 429) return "Too many attempts. Please wait a minute and try again.";
    console.error(err);
    return "Something went wrong. Please try again.";
  }

  async function withBusy(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } finally { if (btn) btn.disabled = false; }
  }

  // ---------------------------------------------------------------------------
  // Time: everything is shown and entered in the organisation's timezone
  // (settings.timezone), not the viewer's, so it matches what the database enforces.
  // ---------------------------------------------------------------------------

  const tz = () => state.settings.timezone;

  function tzOffsetMs(utcMs) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz(), hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }

  // Wall-clock time in the org timezone -> real instant.
  function zoned(y, m, d, minutes) {
    const guess = Date.UTC(y, m - 1, d, 0, minutes);
    let ts = guess - tzOffsetMs(guess);
    ts = guess - tzOffsetMs(ts);  // second pass settles DST edges
    return new Date(ts);
  }

  function ymdInTz(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  function addDays(ymd, n) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  const fmtTime = (d) => d.toLocaleTimeString([], { timeZone: tz(), hour: "2-digit", minute: "2-digit" });
  const fmtDate = (d) => d.toLocaleDateString([], { timeZone: tz(), weekday: "short", day: "numeric", month: "short" });
  const fmtStamp = (d) => d.toLocaleString([], { timeZone: tz(), day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  // ---------------------------------------------------------------------------
  // Data shared by both pages
  // ---------------------------------------------------------------------------

  async function loadSettings() {
    const { data, error } = await db.from("settings")
      .select("timezone, open_hour, close_hour, max_duration_minutes, max_days_ahead, max_upcoming_per_user")
      .single();
    if (error) throw error;
    state.settings = data;
    return data;
  }

  async function isAdmin() {
    const { data, error } = await db.rpc("is_admin");
    if (error) throw error;
    return data === true;
  }

  // Bookings overlapping one day (YYYY-MM-DD in the org timezone).
  async function loadDayBookings(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    const { data, error } = await db
      .from("bookings")
      .select("id, room_id, user_id, title, starts_at, ends_at")
      .lt("starts_at", zoned(y, m, d, 24 * 60).toISOString())
      .gt("ends_at", zoned(y, m, d, 0).toISOString())
      .order("starts_at");
    if (error) throw error;
    return data;
  }

  async function cancelBooking(id, btn, after) {
    if (!confirm("Cancel this booking?")) return;
    await withBusy(btn, async () => {
      const { error, count } = await db.from("bookings").delete({ count: "exact" }).eq("id", id);
      if (error || count === 0) { showMsg(error ? friendlyError(error) : "Couldn't cancel that booking.", "error"); return; }
      showMsg("Booking cancelled.", "ok");
      await after();
    });
  }

  // ---------------------------------------------------------------------------
  // Auth (email + password; accounts are created by an admin in Supabase)
  // ---------------------------------------------------------------------------

  function startAuth({ onSignedIn, onSignedOut }) {
    $("login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const email = $("email").value.trim().toLowerCase();
      const password = $("password").value;
      if (!email || !password) { showMsg("Enter your email and password.", "error"); return; }
      withBusy(e.submitter, async () => {
        const { error } = await db.auth.signInWithPassword({ email, password });
        $("password").value = "";
        // One message for every failure, so it doesn't reveal which emails have accounts.
        if (error) {
          showMsg(error.status === 429 ? friendlyError(error) : "Wrong email or password.", "error");
          return;
        }
        showMsg("");
      });
    });

    $("sign-out").addEventListener("click", () => db.auth.signOut());

    function render() {
      const user = state.user;
      $("auth").hidden = !!user;
      $("who").hidden = !user;
      $("who-email").textContent = user ? user.email || "" : "";
      if (user) {
        Promise.resolve(onSignedIn(user)).catch((err) => showMsg(friendlyError(err), "error"));
      } else {
        onSignedOut();
      }
    }

    // Fires INITIAL_SESSION on load, then on sign-in/out. Defer render so we never
    // make Supabase calls inside this callback (supabase-js can deadlock otherwise).
    db.auth.onAuthStateChange((event, session) => {
      const nextUser = session ? session.user : null;
      const changed = (nextUser && nextUser.id) !== (state.user && state.user.id);
      state.user = nextUser;
      if (event === "INITIAL_SESSION" || changed) setTimeout(render, 0);
    });
  }

  return {
    db, $, state, el, button, showMsg, friendlyError, withBusy,
    zoned, ymdInTz, addDays, fmtTime, fmtDate, fmtStamp,
    loadSettings, isAdmin, loadDayBookings, cancelBooking, startAuth,
  };
})();
