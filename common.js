"use strict";

// Shared by the user page (index.html) and the admin page (admin.html).
window.App = (() => {
  // Refuse to run inside a frame (clickjacking). CSP frame-ancestors can't be set
  // from a <meta> tag on GitHub Pages, so this is the fallback.
  if (window.top !== window.self) {
    document.documentElement.textContent = "This page cannot be embedded.";
    throw new Error("framed");
  }

  // Each page keeps its own session, so signing in on one doesn't sign you in on
  // the other. The admin session lives in sessionStorage: it ends with the tab.
  const isAdminPage = document.body.dataset.page === "admin";
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: isAdminPage ? "room-booking-admin" : "room-booking-user",
      storage: isAdminPage ? window.sessionStorage : window.localStorage,
    },
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
    // The code alone reveals nothing sensitive but makes problems quick to diagnose.
    const code = err.code || err.status;
    return `Something went wrong${code ? ` (code ${code})` : ""}. Please try again.`;
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
  // Month calendar. Dates are YYYY-MM-DD strings in the org timezone.
  // ---------------------------------------------------------------------------

  function createCalendar(container, onSelect) {
    let opts = null;  // { value, min, max, today }
    let view = null;  // [year, month]
    const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;

    function render() {
      const [y, m] = view;
      const first = new Date(Date.UTC(y, m - 1, 1));
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const lead = (first.getUTCDay() + 6) % 7;  // weeks start on Monday

      const prev = button("‹", "cal-nav", () => { view = m === 1 ? [y - 1, 12] : [y, m - 1]; render(); });
      const next = button("›", "cal-nav", () => { view = m === 12 ? [y + 1, 1] : [y, m + 1]; render(); });
      prev.setAttribute("aria-label", "Previous month");
      next.setAttribute("aria-label", "Next month");
      if (opts.min && ym(y, m) <= opts.min.slice(0, 7)) prev.disabled = true;
      if (opts.max && ym(y, m) >= opts.max.slice(0, 7)) next.disabled = true;
      const head = el("div", null, "cal-head");
      head.append(prev, el("span", first.toLocaleDateString([], { timeZone: "UTC", month: "long", year: "numeric" }), "cal-title"), next);

      const grid = el("div", null, "cal-grid");
      for (const w of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) grid.append(el("span", w, "cal-dow"));
      for (let i = 0; i < lead; i++) grid.append(el("span"));
      for (let d = 1; d <= daysInMonth; d++) {
        const ymd = `${ym(y, m)}-${String(d).padStart(2, "0")}`;
        const b = button(String(d), "cal-day", () => { opts.value = ymd; render(); onSelect(ymd); });
        if ((opts.min && ymd < opts.min) || (opts.max && ymd > opts.max)) b.disabled = true;
        if (ymd === opts.today) b.classList.add("today");
        if (ymd === opts.value) { b.classList.add("selected"); b.setAttribute("aria-pressed", "true"); }
        grid.append(b);
      }
      container.replaceChildren(head, grid);
    }

    return {
      update(next) {
        opts = next;
        view = next.value.split("-").map(Number).slice(0, 2);
        render();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Day timeline: one row per room, opening hours across, bookings as blocks.
  // Positions are wall-clock minutes of the day in the org timezone.
  //   describe(booking) -> { text, mine?, onClick? }
  //   onSelect(room, startMin, endMin): when given, rows work like a video
  //     editor timeline: drag across free time to create a selection (a tap
  //     makes 1 hour), drag its edges to trim, drag its middle to move it.
  //     Minute precision; never runs into a booking, the past, closing time
  //     or maxMinutes. A line follows the mouse showing the exact time.
  // Returns { select(roomId, startMin, endMin) } to show a range picked elsewhere.
  // ---------------------------------------------------------------------------

  const MIN_LEN = 5;  // matches the min_5_minutes constraint in schema.sql
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  function renderTimeline(container, { rooms, bookings, ymd, describe, onSelect, maxMinutes }) {
    const s = state.settings;
    const [y, m, d] = ymd.split("-").map(Number);
    const openMin = s.open_hour * 60;
    const closeMin = s.close_hour * 60;
    const hours = s.close_hour - s.open_hour;
    const dayStart = zoned(y, m, d, 0).getTime();
    const toMin = (ms) => (ms - dayStart) / 60000;
    const pos = (min) => `${Math.min(100, Math.max(0, ((min - openMin) / (closeMin - openMin)) * 100))}%`;
    const nowMin = toMin(Date.now());
    const earliest = Math.max(openMin, Math.ceil(nowMin));
    const maxLen = maxMinutes || closeMin - openMin;

    const inner = el("div", null, "tl-inner");

    const hourTrack = el("div", null, "tl-track tl-hours");
    for (let h = s.open_hour; h < s.close_hour; h++) {  // label sits at the start of each hour
      const t = el("span", hhmm(h * 60), "tl-hour");
      t.style.left = pos(h * 60);
      hourTrack.append(t);
    }
    const headRow = el("div", null, "tl-row tl-head");
    headRow.append(el("div", null, "tl-label"), hourTrack);
    inner.append(headRow);

    // One selection and one hover line, moved between rows as needed.
    const sel = el("div", null, "tl-sel");
    const selLabel = el("span", null, "tl-sel-label");
    const handleStart = el("span", null, "tl-handle start");
    const handleEnd = el("span", null, "tl-handle end");
    sel.append(handleStart, selLabel, handleEnd);
    const guide = el("div", null, "tl-guide");
    const guideLabel = el("span");
    guide.append(guideLabel);

    const tracks = new Map();
    const busy = new Map();  // roomId -> [[startMin, endMin], ...]
    let current = null;      // { roomId, a, b }
    let drag = null;         // { roomId, mode: "new" | "start" | "end" | "move", anchor, offset, lo, hi, x, moved }

    const isFree = (roomId, a, b) =>
      a >= earliest && b <= closeMin && !busy.get(roomId).some(([bs, be]) => a < be && bs < b);

    // The free stretch around [a, b): from the previous booking (or now/opening)
    // to the next booking (or closing).
    function bounds(roomId, a, b) {
      let lo = earliest, hi = closeMin;
      for (const [bs, be] of busy.get(roomId)) {
        if (be <= a) lo = Math.max(lo, be);
        if (bs >= b) hi = Math.min(hi, bs);
      }
      return [lo, hi];
    }

    function show() {
      const track = current && tracks.get(current.roomId);
      if (!track) { sel.remove(); return; }
      sel.style.left = pos(current.a);
      sel.style.width = `calc(${pos(current.b)} - ${pos(current.a)})`;
      selLabel.textContent = `${hhmm(current.a)}–${hhmm(current.b)}`;
      sel.title = selLabel.textContent;
      sel.classList.toggle("clash", !isFree(current.roomId, current.a, current.b));
      if (sel.parentNode !== track) track.append(sel);
    }

    function minAt(track, clientX) {
      const rect = track.getBoundingClientRect();
      return openMin + Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (closeMin - openMin);
    }

    function dragTo(cur) {
      const { mode, anchor, lo, hi, roomId } = drag;
      const v = Math.round(cur);
      let a, b;
      if (mode === "start") {
        b = current.b;
        a = Math.min(b - MIN_LEN, Math.max(lo, b - maxLen, v));
      } else if (mode === "end") {
        a = current.a;
        b = Math.max(a + MIN_LEN, Math.min(hi, a + maxLen, v));
      } else if (mode === "move") {
        const len = current.b - current.a;
        a = Math.min(hi - len, Math.max(lo, Math.round(cur - drag.offset)));
        b = a + len;
      } else if (cur >= anchor) {
        a = anchor;
        b = Math.max(anchor + MIN_LEN, Math.min(hi, anchor + maxLen, v));
      } else {
        b = anchor + MIN_LEN;
        a = Math.min(anchor, Math.max(lo, b - maxLen, v));
      }
      current = { roomId, a, b };
      show();
    }

    for (const r of rooms) {
      const label = el("div", null, "tl-label");
      label.append(el("strong", r.name), el("small", `${r.capacity} people${r.is_active === false ? " · inactive" : ""}`));

      const track = el("div", null, "tl-track");
      track.style.backgroundSize = `${100 / hours}% 100%`;  // one gridline per hour
      tracks.set(r.id, track);
      busy.set(r.id, []);

      if (nowMin > openMin) {
        const past = el("div", null, "tl-past");
        past.style.width = pos(nowMin);
        track.append(past);
      }
      if (nowMin > openMin && nowMin < closeMin) {
        const line = el("div", null, "tl-now");
        line.style.left = pos(nowMin);
        track.append(line);
      }

      for (const b of bookings) {
        if (b.room_id !== r.id) continue;
        const st = new Date(b.starts_at).getTime();
        const en = new Date(b.ends_at).getTime();
        const a = toMin(st), z = toMin(en);
        if (z <= openMin || a >= closeMin) continue;
        busy.get(r.id).push([a, z]);
        const info = describe(b);
        const block = info.onClick ? button(info.text, "tl-block", info.onClick) : el("div", info.text, "tl-block");
        if (info.mine) block.classList.add("mine");
        block.title = `${fmtTime(new Date(st))}–${fmtTime(new Date(en))}  ${info.text}`;
        block.style.left = pos(a);
        block.style.width = `calc(${pos(z)} - ${pos(a)})`;
        track.append(block);
      }

      if (onSelect) {
        track.classList.add("selectable");

        track.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.target.closest(".tl-block")) return;
          const cur = minAt(track, e.clientX);
          const onSel = current && current.roomId === r.id && e.target.closest(".tl-sel");
          if (onSel) {
            const [lo, hi] = bounds(r.id, current.a, current.b);
            const mode = e.target === handleStart ? "start" : e.target === handleEnd ? "end" : "move";
            drag = { roomId: r.id, mode, offset: cur - current.a, lo, hi, x: e.clientX, moved: mode !== "move" };
          } else {
            const anchor = Math.round(cur);
            if (!isFree(r.id, anchor, anchor + MIN_LEN)) return;
            const [lo, hi] = bounds(r.id, anchor, anchor + MIN_LEN);
            drag = { roomId: r.id, mode: "new", anchor, lo, hi, x: e.clientX, moved: false };
            dragTo(anchor);
          }
          track.setPointerCapture(e.pointerId);
          e.preventDefault();
        });

        track.addEventListener("pointermove", (e) => {
          const cur = minAt(track, e.clientX);
          if (e.pointerType === "mouse" || drag) {
            guide.style.left = pos(Math.round(cur));
            guideLabel.textContent = hhmm(Math.round(cur));
            if (guide.parentNode !== track) track.append(guide);
          }
          if (!drag || drag.roomId !== r.id) return;
          if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
          if (drag.moved) dragTo(cur);
        });

        track.addEventListener("pointerup", () => {
          if (!drag || drag.roomId !== r.id) return;
          if (drag.mode === "new" && !drag.moved) {  // a tap makes an hour
            current = { roomId: r.id, a: drag.anchor, b: Math.max(drag.anchor + MIN_LEN, Math.min(drag.hi, drag.anchor + Math.min(60, maxLen))) };
            show();
          }
          drag = null;
          guide.remove();
          onSelect(r, current.a, current.b);
        });
        track.addEventListener("pointercancel", () => { drag = null; guide.remove(); });
        track.addEventListener("pointerleave", () => { if (!drag) guide.remove(); });
      }

      const row = el("div", null, "tl-row");
      row.append(label, track);
      inner.append(row);
    }

    const wrap = el("div", null, "tl");
    wrap.append(inner);
    container.replaceChildren(wrap);

    return {
      select(roomId, a, b) {
        current = tracks.has(roomId) && b > a ? { roomId, a, b } : null;
        show();
      },
    };
  }
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
    zoned, ymdInTz, addDays, fmtTime, fmtDate, fmtStamp, hhmm, MIN_LEN,
    createCalendar, renderTimeline,
    loadSettings, isAdmin, loadDayBookings, cancelBooking, startAuth,
  };
})();
