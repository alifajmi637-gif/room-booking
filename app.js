"use strict";

(() => {
  // Refuse to run inside a frame (clickjacking). CSP frame-ancestors can't be set
  // from a <meta> tag on GitHub Pages, so this is the fallback.
  if (window.top !== window.self) {
    document.body.textContent = "This page cannot be embedded.";
    return;
  }

  // Read what the email link brought back before supabase-js consumes it, so a
  // failed sign-in can be explained instead of silently showing the form again.
  const urlParams = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const linkError = urlParams.get("error_description") || hashParams.get("error_description");
  const hadLinkCode = urlParams.has("code");

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // PKCE: the emailed link only completes sign-in in the browser that asked for it.
    auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const $ = (id) => document.getElementById(id);

  let user = null;
  let isAdmin = false;
  let settings = null;
  let rooms = [];

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

  const tz = () => settings.timezone;

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

  function selectedYmd() {
    return $("day").value.split("-").map(Number);
  }

  const fmtTime = (d) => d.toLocaleTimeString([], { timeZone: tz(), hour: "2-digit", minute: "2-digit" });
  const fmtDate = (d) => d.toLocaleDateString([], { timeZone: tz(), weekday: "short", day: "numeric", month: "short" });
  const fmtStamp = (d) => d.toLocaleString([], { timeZone: tz(), day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function minutesLabel(m) {
    const h = Math.floor(m / 60), r = m % 60;
    return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
  }

  // ---------------------------------------------------------------------------
  // Auth (email one-time link)
  // ---------------------------------------------------------------------------

  $("email-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      showMsg("Enter a valid email address.", "error");
      return;
    }
    withBusy(e.submitter, async () => {
      const { error } = await db.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
      });
      // Same response whether or not the account exists (no user enumeration).
      if (error && error.status === 429) { showMsg(friendlyError(error), "error"); return; }
      showMsg("If that address is allowed, a sign-in link is on its way. Open it in this browser.", "ok");
    });
  });

  $("sign-out").addEventListener("click", async () => {
    await db.auth.signOut();
  });

  // Fires INITIAL_SESSION on load, then on sign-in/out. Defer render so we never
  // make Supabase calls inside this callback (supabase-js can deadlock otherwise).
  db.auth.onAuthStateChange((event, session) => {
    const nextUser = session ? session.user : null;
    const changed = (nextUser && nextUser.id) !== (user && user.id);
    user = nextUser;
    // Drop the one-time ?code= / #error from the address bar once it has been read.
    if (location.search || location.hash) history.replaceState(null, "", location.pathname);
    if (event === "INITIAL_SESSION" && !nextUser && (linkError || hadLinkCode)) {
      if (linkError) console.warn("Sign-in link error:", linkError);
      // Fixed wording only: never echo URL text onto the page.
      setTimeout(() => showMsg(linkError
        ? "That sign-in link didn't work. It may have expired or already been used. Request a new one below."
        : "That sign-in link must be opened in the same browser you requested it from. Request a new one below.",
        "error"), 0);
    }
    if (event === "INITIAL_SESSION" || changed) setTimeout(render, 0);
  });

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  function render() {
    $("auth").hidden = !!user;
    $("app").hidden = !user;
    $("who").hidden = !user;
    if (!user) {
      isAdmin = false;
      $("admin").hidden = true;
      $("who-email").textContent = "";
      return;
    }
    $("who-email").textContent = user.email || "";
    loadAll();
  }

  async function loadAll() {
    const [s, r, a] = await Promise.all([
      db.from("settings").select("timezone, open_hour, close_hour, max_duration_minutes, max_days_ahead, max_upcoming_per_user").single(),
      db.from("rooms").select("id, name, capacity, is_active").order("name"),
      db.rpc("is_admin"),
    ]);
    const error = s.error || r.error || a.error;
    if (error) { showMsg(friendlyError(error), "error"); return; }
    settings = s.data;
    rooms = r.data;
    isAdmin = a.data === true;

    setupForm();
    $("admin").hidden = !isAdmin;
    await Promise.all([loadSchedule(), loadMine(), isAdmin ? loadAdmin() : null]);
  }

  async function refresh() {
    await Promise.all([loadSchedule(), loadMine(), isAdmin ? loadAudit() : null]);
  }

  function setupForm() {
    const today = ymdInTz(new Date());
    const day = $("day");
    day.min = today;
    day.max = addDays(today, isAdmin ? 365 : settings.max_days_ahead);
    if (!day.value || day.value < day.min || day.value > day.max) day.value = today;

    const prevRoom = $("room").value;
    $("room").replaceChildren(...rooms.filter((r) => r.is_active).map((r) => {
      const o = el("option", `${r.name} (${r.capacity})`);
      o.value = String(r.id);
      return o;
    }));
    if (prevRoom) $("room").value = prevRoom;

    const starts = [];
    for (let mins = settings.open_hour * 60; mins < settings.close_hour * 60; mins += 15) {
      const o = el("option", `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
      o.value = String(mins);
      starts.push(o);
    }
    $("start").replaceChildren(...starts);

    const maxDur = isAdmin ? (settings.close_hour - settings.open_hour) * 60 : settings.max_duration_minutes;
    const durs = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 600, 720, 960, 1440]
      .filter((m) => m <= maxDur);
    if (!durs.includes(maxDur)) durs.push(maxDur);
    $("duration").replaceChildren(...durs.map((m) => {
      const o = el("option", minutesLabel(m));
      o.value = String(m);
      return o;
    }));
    $("duration").value = durs.includes(60) ? "60" : String(durs[0]);
  }

  async function loadSchedule() {
    const [y, m, d] = selectedYmd();
    const dayStart = zoned(y, m, d, 0);
    const dayEnd = zoned(y, m, d, 24 * 60);

    const { data, error } = await db
      .from("bookings")
      .select("id, room_id, user_id, title, starts_at, ends_at")
      .lt("starts_at", dayEnd.toISOString())
      .gt("ends_at", dayStart.toISOString())
      .order("starts_at");
    if (error) { showMsg(friendlyError(error), "error"); return; }

    // Admins see who booked what, so they can sort out problems.
    const owners = new Map();
    if (isAdmin && data.length) {
      const res = await db.rpc("admin_booking_owners", { p_ids: data.map((b) => b.id) });
      if (!res.error) for (const o of res.data) owners.set(o.id, o.email);
    }

    const byRoom = new Map(rooms.map((r) => [r.id, []]));
    for (const b of data) if (byRoom.has(b.room_id)) byRoom.get(b.room_id).push(b);

    const cards = rooms.filter((r) => r.is_active || byRoom.get(r.id).length).map((r) => {
      const card = el("div", null, "room");
      const h = el("h3", r.name);
      h.append(" ", el("span", `· ${r.capacity} people${r.is_active ? "" : " · inactive"}`, "cap"));
      card.append(h);
      const items = byRoom.get(r.id);
      if (!items.length) {
        card.append(el("p", "Free all day", "empty"));
        return card;
      }
      const ul = el("ul", null, "list");
      for (const b of items) {
        const mine = b.user_id === user.id;
        const li = el("li", null, mine ? "mine" : "");
        const text = el("span");
        text.append(
          el("span", `${fmtTime(new Date(b.starts_at))} – ${fmtTime(new Date(b.ends_at))} `, "time"),
          el("span", mine ? `${b.title} (you)` : b.title),
        );
        if (isAdmin && owners.has(b.id) && !mine) text.append(" ", el("span", owners.get(b.id), "who"));
        li.append(text);
        if (isAdmin) li.append(button("Cancel", "link", (btn) => cancelBooking(b.id, btn)));
        ul.append(li);
      }
      card.append(ul);
      return card;
    });
    $("schedule").replaceChildren(...cards);
  }

  async function loadMine() {
    const { data, error } = await db
      .from("bookings")
      .select("id, room_id, title, starts_at, ends_at")
      .eq("user_id", user.id)
      .gt("ends_at", new Date().toISOString())
      .order("starts_at");
    if (error) { showMsg(friendlyError(error), "error"); return; }

    const roomName = new Map(rooms.map((r) => [r.id, r.name]));
    const list = $("mine");
    if (!data.length) {
      list.replaceChildren(el("li", "No upcoming bookings.", "empty"));
      return;
    }
    list.replaceChildren(...data.map((b) => {
      const s = new Date(b.starts_at);
      const li = el("li");
      const text = el("span");
      text.append(
        el("span", `${fmtDate(s)} ${fmtTime(s)}–${fmtTime(new Date(b.ends_at))} `, "time"),
        el("span", `${roomName.get(b.room_id) || "Room"}: ${b.title}`),
      );
      li.append(text, button("Cancel", "link", (btn) => cancelBooking(b.id, btn)));
      return li;
    }));
  }

  function cancelBooking(id, btn) {
    if (!confirm("Cancel this booking?")) return;
    withBusy(btn, async () => {
      const { error, count } = await db.from("bookings").delete({ count: "exact" }).eq("id", id);
      if (error || count === 0) { showMsg(error ? friendlyError(error) : "Couldn't cancel that booking.", "error"); return; }
      showMsg("Booking cancelled.", "ok");
      await refresh();
    });
  }

  $("book-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const roomId = Number($("room").value);
    const startMins = Number($("start").value);
    const durMins = Number($("duration").value);
    const title = $("title").value.trim();

    if (!rooms.some((r) => r.id === roomId && r.is_active)) { showMsg("Pick a room.", "error"); return; }
    if (!title || title.length > 100) { showMsg("Title must be 1–100 characters.", "error"); return; }
    if (startMins + durMins > settings.close_hour * 60) {
      showMsg(`That would run past closing time (${settings.close_hour}:00).`, "error");
      return;
    }

    const [y, m, d] = selectedYmd();
    const starts = zoned(y, m, d, startMins);
    const ends = zoned(y, m, d, startMins + durMins);
    if (starts < new Date()) { showMsg("That start time has already passed.", "error"); return; }

    // The browser checks are only for convenience; the database enforces every rule.
    withBusy(e.submitter, async () => {
      const { error } = await db.from("bookings").insert({
        room_id: roomId,
        title,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
      });
      if (error) { showMsg(friendlyError(error), "error"); return; }
      $("title").value = "";
      showMsg("Booked!", "ok");
      await refresh();
    });
  });

  $("day").addEventListener("change", () => { if (user && $("day").value) loadSchedule(); });

  // ---------------------------------------------------------------------------
  // Admin panel
  // ---------------------------------------------------------------------------

  async function loadAdmin() {
    renderAdminRooms();
    fillRulesForm();
    await Promise.all([loadAdmins(), loadAudit()]);
  }

  async function reloadRooms() {
    const { data, error } = await db.from("rooms").select("id, name, capacity, is_active").order("name");
    if (error) { showMsg(friendlyError(error), "error"); return; }
    rooms = data;
    setupForm();
    renderAdminRooms();
    await refresh();
  }

  function renderAdminRooms() {
    $("admin-rooms").replaceChildren(...rooms.map((r) => {
      const row = el("div", null, "room-row");
      const name = el("input");
      name.type = "text"; name.value = r.name; name.maxLength = 60;
      name.setAttribute("aria-label", "Room name");
      const cap = el("input");
      cap.type = "number"; cap.min = "1"; cap.max = "500"; cap.value = String(r.capacity);
      cap.setAttribute("aria-label", "Capacity");
      const activeLabel = el("label");
      const active = el("input");
      active.type = "checkbox"; active.checked = r.is_active;
      activeLabel.append(active, "Active");

      const save = button("Save", "", (btn) => withBusy(btn, async () => {
        const capacity = Number(cap.value);
        if (!name.value.trim() || !Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
          showMsg("Room needs a name and a capacity between 1 and 500.", "error");
          return;
        }
        const { error } = await db.from("rooms")
          .update({ name: name.value.trim(), capacity, is_active: active.checked }).eq("id", r.id);
        if (error) { showMsg(friendlyError(error), "error"); return; }
        showMsg("Room saved.", "ok");
        await reloadRooms();
      }));

      const del = button("Delete", "danger", (btn) => {
        if (!confirm(`Delete "${r.name}"? This only works if it has never been booked.`)) return;
        withBusy(btn, async () => {
          const { error, count } = await db.from("rooms").delete({ count: "exact" }).eq("id", r.id);
          if (error || count === 0) { showMsg(error ? friendlyError(error) : "Couldn't delete that room.", "error"); return; }
          showMsg("Room deleted.", "ok");
          await reloadRooms();
        });
      });

      row.append(name, cap, activeLabel, save, del);
      return row;
    }));
  }

  $("room-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("room-name").value.trim();
    const capacity = Number($("room-capacity").value);
    if (!name || name.length > 60) { showMsg("Room name must be 1–60 characters.", "error"); return; }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) { showMsg("Capacity must be 1–500.", "error"); return; }
    withBusy(e.submitter, async () => {
      const { error } = await db.from("rooms").insert({ name, capacity });
      if (error) { showMsg(friendlyError(error), "error"); return; }
      $("room-name").value = "";
      $("room-capacity").value = "";
      showMsg("Room added.", "ok");
      await reloadRooms();
    });
  });

  const RULE_FIELDS = {
    "rule-tz": "timezone",
    "rule-open": "open_hour",
    "rule-close": "close_hour",
    "rule-duration": "max_duration_minutes",
    "rule-ahead": "max_days_ahead",
    "rule-cap": "max_upcoming_per_user",
  };

  function fillRulesForm() {
    for (const [id, key] of Object.entries(RULE_FIELDS)) $(id).value = String(settings[key]);
  }

  $("rules-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = {};
    for (const [id, key] of Object.entries(RULE_FIELDS)) {
      next[key] = key === "timezone" ? $(id).value.trim() : Number($(id).value);
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: next.timezone });
    } catch {
      showMsg("Unknown timezone. Use a name like Asia/Kuala_Lumpur.", "error");
      return;
    }
    withBusy(e.submitter, async () => {
      const { error } = await db.from("settings").update(next).eq("id", true);
      if (error) { showMsg(friendlyError(error), "error"); return; }
      showMsg("Rules saved.", "ok");
      await loadAll();
    });
  });

  async function loadAdmins() {
    const { data, error } = await db.rpc("admin_list_admins");
    if (error) { showMsg(friendlyError(error), "error"); return; }
    $("admin-list").replaceChildren(...data.map((a) => {
      const li = el("li");
      li.append(el("span", a.user_id === user.id ? `${a.email} (you)` : a.email));
      li.append(button("Remove", "danger", (btn) => {
        if (!confirm(`Remove admin rights from ${a.email}?`)) return;
        withBusy(btn, async () => {
          const { error: err } = await db.rpc("admin_remove", { p_user_id: a.user_id });
          if (err) { showMsg(friendlyError(err), "error"); return; }
          showMsg("Admin removed.", "ok");
          if (a.user_id === user.id) { await loadAll(); return; }
          await Promise.all([loadAdmins(), loadAudit()]);
        });
      }));
      return li;
    }));
  }

  $("admin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("admin-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg("Enter a valid email address.", "error"); return; }
    withBusy(e.submitter, async () => {
      const { error } = await db.rpc("admin_add", { p_email: email });
      if (error) { showMsg(friendlyError(error), "error"); return; }
      $("admin-email").value = "";
      showMsg("Admin added.", "ok");
      await Promise.all([loadAdmins(), loadAudit()]);
    });
  });

  function describeChange(row) {
    const data = row.new_data || row.old_data || {};
    const verb = { INSERT: "added", UPDATE: "changed", DELETE: "removed" }[row.action] || row.action;
    switch (row.table_name) {
      case "bookings": {
        const room = rooms.find((r) => r.id === data.room_id);
        const when = data.starts_at ? fmtStamp(new Date(data.starts_at)) : "";
        return `${row.action === "INSERT" ? "booked" : "cancelled"} ${room ? room.name : "a room"} ${when}: ${data.title || ""}`;
      }
      case "rooms": return `${verb} room "${data.name || ""}"`;
      case "settings": return "changed booking rules";
      case "admins": return row.action === "INSERT" ? "added an admin" : "removed an admin";
      default: return `${verb} ${row.table_name}`;
    }
  }

  async function loadAudit() {
    const { data, error } = await db.rpc("admin_audit_log", { p_limit: 50 });
    if (error) { showMsg(friendlyError(error), "error"); return; }
    if (!data.length) { $("audit").replaceChildren(el("li", "Nothing yet.", "empty")); return; }
    $("audit").replaceChildren(...data.map((row) => {
      const li = el("li");
      li.append(
        el("span", `${fmtStamp(new Date(row.at))} `, "time"),
        el("strong", row.email || "dashboard/system"),
        ` ${describeChange(row)}`,
      );
      return li;
    }));
  }
})();
