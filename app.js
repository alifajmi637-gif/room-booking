"use strict";

(() => {
  // Refuse to run inside a frame (clickjacking). CSP frame-ancestors can't be set
  // from a <meta> tag on GitHub Pages, so this is the fallback.
  if (window.top !== window.self) {
    document.body.textContent = "This page cannot be embedded.";
    return;
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const $ = (id) => document.getElementById(id);
  const DAY_START_HOUR = 7;
  const DAY_END_HOUR = 21;

  let user = null;
  let rooms = [];
  let pendingEmail = "";

  // ---------------------------------------------------------------------------
  // Helpers. All user-controlled text goes through textContent, never innerHTML.
  // ---------------------------------------------------------------------------

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function showMsg(text, kind) {
    const m = $("msg");
    m.textContent = text;
    m.className = kind || "";
    m.hidden = !text;
  }

  // Only show messages we wrote ourselves; anything unexpected becomes generic
  // so internal details never leak to the screen.
  function friendlyError(err) {
    if (!err) return "Something went wrong.";
    if (err.code === "23P01") return "That room is already booked during that time.";
    if (err.code === "22023" && err.message) return err.message;
    if (err.code === "23514") return "That booking isn't allowed (check the time and title).";
    if (err.status === 429) return "Too many attempts. Please wait a minute and try again.";
    console.error(err);
    return "Something went wrong. Please try again.";
  }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDate(d) {
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  }

  function localDateValue(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function selectedDay() {
    const [y, m, d] = $("day").value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  async function withBusy(button, fn) {
    button.disabled = true;
    try { await fn(); } finally { button.disabled = false; }
  }

  // ---------------------------------------------------------------------------
  // Auth (email one-time code)
  // ---------------------------------------------------------------------------

  $("email-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      showMsg("Enter a valid email address.", "error");
      return;
    }
    withBusy(e.submitter, async () => {
      const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      // Same response whether or not the account exists (no user enumeration).
      if (error && error.status === 429) { showMsg(friendlyError(error), "error"); return; }
      pendingEmail = email;
      $("email-form").hidden = true;
      $("code-form").hidden = false;
      $("code").focus();
      showMsg("If that address is allowed, a code is on its way.", "ok");
    });
  });

  $("code-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const token = $("code").value.trim();
    if (!/^\d{6}$/.test(token)) { showMsg("Enter the 6-digit code.", "error"); return; }
    withBusy(e.submitter, async () => {
      const { error } = await db.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
      $("code").value = "";
      if (error) { showMsg("That code is invalid or expired.", "error"); return; }
      showMsg("");
    });
  });

  $("code-back").addEventListener("click", () => {
    pendingEmail = "";
    $("code-form").hidden = true;
    $("email-form").hidden = false;
    showMsg("");
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
      $("who-email").textContent = "";
      $("email-form").hidden = false;
      $("code-form").hidden = true;
      return;
    }
    $("who-email").textContent = user.email || "";
    loadAll();
  }

  async function loadAll() {
    const { data, error } = await db.from("rooms").select("id, name, capacity").order("name");
    if (error) { showMsg(friendlyError(error), "error"); return; }
    rooms = data;
    fillRoomSelect();
    fillTimeSelects();
    await Promise.all([loadSchedule(), loadMine()]);
  }

  function fillRoomSelect() {
    const sel = $("room");
    sel.replaceChildren(...rooms.map((r) => {
      const o = el("option", `${r.name} (${r.capacity})`);
      o.value = String(r.id);
      return o;
    }));
  }

  function fillTimeSelects() {
    const start = $("start");
    const opts = [];
    for (let mins = DAY_START_HOUR * 60; mins < DAY_END_HOUR * 60; mins += 15) {
      const d = new Date(2000, 0, 1, 0, mins);
      const o = el("option", fmtTime(d));
      o.value = String(mins);
      opts.push(o);
    }
    start.replaceChildren(...opts);

    const dur = $("duration");
    const durs = [15, 30, 45, 60, 90, 120, 180, 240, 480].map((m) => {
      const label = m < 60 ? `${m} min` : `${m / 60} h`;
      const o = el("option", label);
      o.value = String(m);
      return o;
    });
    dur.replaceChildren(...durs);
    dur.value = "60";
  }

  async function loadSchedule() {
    const dayStart = selectedDay();
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const { data, error } = await db
      .from("bookings")
      .select("id, room_id, user_id, title, starts_at, ends_at")
      .lt("starts_at", dayEnd.toISOString())
      .gt("ends_at", dayStart.toISOString())
      .order("starts_at");
    if (error) { showMsg(friendlyError(error), "error"); return; }

    const byRoom = new Map(rooms.map((r) => [r.id, []]));
    for (const b of data) if (byRoom.has(b.room_id)) byRoom.get(b.room_id).push(b);

    const cards = rooms.map((r) => {
      const card = el("div", null, "room");
      const h = el("h3", r.name);
      h.append(" ", el("span", `· ${r.capacity} people`, "cap"));
      card.append(h);
      const items = byRoom.get(r.id);
      if (!items.length) {
        card.append(el("p", "Free all day", "empty"));
      } else {
        const ul = el("ul", null, "list");
        for (const b of items) {
          const mine = b.user_id === user.id;
          const li = el("li", null, mine ? "mine" : "");
          li.append(
            el("span", `${fmtTime(new Date(b.starts_at))} – ${fmtTime(new Date(b.ends_at))}`, "time"),
            el("span", mine ? `${b.title} (you)` : b.title),
          );
          ul.append(li);
        }
        card.append(ul);
      }
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
      const btn = el("button", "Cancel", "link");
      btn.type = "button";
      btn.addEventListener("click", () => cancelBooking(b.id, btn));
      li.append(text, btn);
      return li;
    }));
  }

  function cancelBooking(id, btn) {
    if (!confirm("Cancel this booking?")) return;
    withBusy(btn, async () => {
      const { error, count } = await db.from("bookings").delete({ count: "exact" }).eq("id", id);
      if (error || count === 0) { showMsg(error ? friendlyError(error) : "Couldn't cancel that booking.", "error"); return; }
      showMsg("Booking cancelled.", "ok");
      await Promise.all([loadSchedule(), loadMine()]);
    });
  }

  $("book-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const roomId = Number($("room").value);
    const startMins = Number($("start").value);
    const durMins = Number($("duration").value);
    const title = $("title").value.trim();

    if (!rooms.some((r) => r.id === roomId)) { showMsg("Pick a room.", "error"); return; }
    if (!title || title.length > 100) { showMsg("Title must be 1–100 characters.", "error"); return; }

    const day = selectedDay();
    const starts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMins);
    const ends = new Date(starts.getTime() + durMins * 60000);
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
      await Promise.all([loadSchedule(), loadMine()]);
    });
  });

  $("day").addEventListener("change", () => { if (user) loadSchedule(); });

  // Init
  $("day").value = localDateValue(new Date());
  $("day").min = localDateValue(new Date());
})();
