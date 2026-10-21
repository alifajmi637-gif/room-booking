"use strict";

// User page: see the schedule, book a room, cancel your own bookings.
(() => {
  const { db, $, state, el, button, showMsg, friendlyError, withBusy,
          zoned, ymdInTz, addDays, fmtTime, fmtDate, createCalendar, renderTimeline,
          loadSettings, isAdmin, loadDayBookings, cancelBooking, startAuth } = window.App;

  let rooms = [];
  let dayBookings = [];
  const calendar = createCalendar($("calendar"), (ymd) => {
    $("day").value = ymd;
    loadSchedule();
  });

  function minutesLabel(m) {
    const h = Math.floor(m / 60), r = m % 60;
    return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
  }

  const STEP = 15;
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  // Minutes since midnight (org timezone) on the selected day that are already past.
  function nowMinOnDay() {
    const [y, m, d] = $("day").value.split("-").map(Number);
    return (Date.now() - zoned(y, m, d, 0).getTime()) / 60000;
  }

  // ---------------------------------------------------------------------------
  // Time slider in the booking form: two handles for start and end, 15-minute
  // steps, with the selected room's bookings and past time drawn underneath.
  // Kept in sync with the Start/Duration dropdowns (both ways).
  // ---------------------------------------------------------------------------

  const slider = (() => {
    const root = $("slider");
    const readout = el("div", null, "rs-readout");
    const track = el("div", null, "rs-track");
    const past = el("div", null, "rs-past");
    const busyLayer = el("div");
    const range = el("div", null, "rs-range");
    const handles = { start: el("button", null, "rs-handle"), end: el("button", null, "rs-handle") };
    const labels = el("div", null, "rs-labels");
    for (const [which, h] of Object.entries(handles)) {
      h.type = "button";
      h.setAttribute("role", "slider");
      h.setAttribute("aria-label", which === "start" ? "Start time" : "End time");
    }
    track.append(past, busyLayer, range, handles.start, handles.end);
    root.append(readout, track, labels);

    let open = 0, close = 0, maxLen = 0, a = 0, b = 0, busy = [], earliest = 0, active = null;
    const pos = (min) => `${((min - open) / (close - open)) * 100}%`;

    function draw() {
      range.style.left = pos(a);
      range.style.width = `calc(${pos(b)} - ${pos(a)})`;
      handles.start.style.left = pos(a);
      handles.end.style.left = pos(b);
      const clash = a < earliest || busy.some(([s, e]) => a < e && s < b);
      root.classList.toggle("clash", clash);
      readout.textContent = `${hhmm(a)} – ${hhmm(b)} · ${minutesLabel(b - a)}${clash ? " · not available" : ""}`;
      for (const [h, v] of [[handles.start, a], [handles.end, b]]) {
        h.setAttribute("aria-valuenow", String(v));
        h.setAttribute("aria-valuetext", hhmm(v));
      }
    }

    // Push the current range into the dropdowns.
    function commit() {
      $("start").value = String(a);
      $("duration").value = String(b - a);
    }

    function move(which, min) {
      const v = Math.round(min / STEP) * STEP;
      if (which === "start") a = Math.min(b - STEP, Math.max(open, b - maxLen, v));
      else b = Math.max(a + STEP, Math.min(close, a + maxLen, v));
      draw();
    }

    function minAt(clientX) {
      const rect = track.getBoundingClientRect();
      return open + Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (close - open);
    }

    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const min = minAt(e.clientX);
      // Grab the handle that was pressed, or else whichever is nearer.
      active = e.target === handles.start ? "start"
        : e.target === handles.end ? "end"
        : Math.abs(min - a) <= Math.abs(min - b) ? "start" : "end";
      move(active, min);
      track.setPointerCapture(e.pointerId);
      handles[active].focus({ preventScroll: true });
      e.preventDefault();
    });
    track.addEventListener("pointermove", (e) => { if (active) move(active, minAt(e.clientX)); });
    track.addEventListener("pointerup", () => { if (active) { active = null; commit(); } });
    track.addEventListener("pointercancel", () => { active = null; });

    for (const [which, h] of Object.entries(handles)) {
      h.addEventListener("keydown", (e) => {
        const delta = { ArrowLeft: -STEP, ArrowDown: -STEP, ArrowRight: STEP, ArrowUp: STEP }[e.key];
        if (!delta) return;
        e.preventDefault();
        move(which, (which === "start" ? a : b) + delta);
        commit();
      });
    }

    return {
      configure(o) {
        ({ open, close, maxLen } = o);
        for (const h of Object.values(handles)) {
          h.setAttribute("aria-valuemin", String(open));
          h.setAttribute("aria-valuemax", String(close));
        }
        // Strong line every hour, faint line every 15 minutes.
        const hours = (close - open) / 60;
        track.style.backgroundSize = `${100 / hours}% 100%, ${100 / (hours * 4)}% 100%`;
        const every = Math.max(1, Math.ceil(hours / 5));
        const marks = [];
        for (let h = open / 60; h < close / 60; h += every) marks.push(h * 60);
        if (close - marks[marks.length - 1] >= 120) marks.push(close);
        labels.replaceChildren(...marks.map((min) => {
          const t = el("span", hhmm(min));
          t.style.left = pos(min);
          return t;
        }));
      },
      set(na, nb) {
        a = Math.max(open, Math.min(close - STEP, na));
        b = Math.min(close, a + maxLen, Math.max(a + STEP, nb));
        draw();
        if (a !== na || b !== nb) commit();  // e.g. a 1-hour default that ran past closing
      },
      setBusy(intervals, notBefore) {
        busy = intervals;
        earliest = notBefore;
        past.style.width = notBefore > open ? pos(Math.min(close, notBefore)) : "0";
        busyLayer.replaceChildren(...intervals.map(([s, e]) => {
          const blk = el("div", null, "rs-busy");
          blk.style.left = pos(Math.max(open, s));
          blk.style.width = `calc(${pos(Math.min(close, e))} - ${pos(Math.max(open, s))})`;
          return blk;
        }));
        draw();
      },
    };
  })();

  // Show the selected room's bookings on the slider.
  function updateSliderBusy() {
    const [y, m, d] = $("day").value.split("-").map(Number);
    const dayStart = zoned(y, m, d, 0).getTime();
    const roomId = Number($("room").value);
    const intervals = dayBookings
      .filter((b) => b.room_id === roomId)
      .map((b) => [(new Date(b.starts_at) - dayStart) / 60000, (new Date(b.ends_at) - dayStart) / 60000]);
    slider.setBusy(intervals, Math.ceil(nowMinOnDay() / STEP) * STEP);
  }

  function syncSliderFromForm() {
    const start = Number($("start").value);
    slider.set(start, start + Number($("duration").value));
  }

  $("room").addEventListener("change", updateSliderBusy);
  $("start").addEventListener("change", syncSliderFromForm);
  $("duration").addEventListener("change", syncSliderFromForm);

  startAuth({
    async onSignedIn() {
      const [, r, admin] = await Promise.all([
        loadSettings(),
        db.from("rooms").select("id, name, capacity").eq("is_active", true).order("name"),
        isAdmin(),
      ]);
      if (r.error) throw r.error;
      rooms = r.data;
      $("admin-link").hidden = !admin;
      setupForm();
      $("app").hidden = false;
      await refresh();
    },
    onSignedOut() {
      $("app").hidden = true;
      $("admin-link").hidden = true;
    },
  });

  async function refresh() {
    await Promise.all([loadSchedule(), loadMine()]);
  }

  function setupForm() {
    const s = state.settings;
    const today = ymdInTz(new Date());
    const day = $("day");
    day.min = today;
    day.max = addDays(today, s.max_days_ahead);
    if (!day.value || day.value < day.min || day.value > day.max) day.value = today;
    calendar.update({ value: day.value, min: day.min, max: day.max, today });

    $("room").replaceChildren(...rooms.map((r) => {
      const o = el("option", `${r.name} (${r.capacity})`);
      o.value = String(r.id);
      return o;
    }));

    const starts = [];
    for (let mins = s.open_hour * 60; mins < s.close_hour * 60; mins += 15) {
      const o = el("option", `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
      o.value = String(mins);
      starts.push(o);
    }
    $("start").replaceChildren(...starts);

    // Every 15-minute length, so any range picked on the slider fits.
    const durs = [];
    for (let m = STEP; m <= s.max_duration_minutes; m += STEP) durs.push(m);
    $("duration").replaceChildren(...durs.map((m) => {
      const o = el("option", minutesLabel(m));
      o.value = String(m);
      return o;
    }));
    $("duration").value = durs.includes(60) ? "60" : String(durs[0]);

    // Start at the next free quarter-hour rather than at opening time.
    const next = Math.ceil(nowMinOnDay() / STEP) * STEP;
    if (next > s.open_hour * 60 && next < s.close_hour * 60) $("start").value = String(next);

    slider.configure({ open: s.open_hour * 60, close: s.close_hour * 60, maxLen: s.max_duration_minutes });
    syncSliderFromForm();
  }

  async function loadSchedule() {
    const ymd = $("day").value;
    let data;
    try { data = await loadDayBookings(ymd); } catch (err) { showMsg(friendlyError(err), "error"); return; }
    dayBookings = data;
    updateSliderBusy();

    const [y, m, d] = ymd.split("-").map(Number);
    $("day-label").textContent = `Schedule · ${fmtDate(zoned(y, m, d, 12 * 60))}`;
    renderTimeline($("schedule"), {
      rooms,
      bookings: data,
      ymd,
      describe: (b) => b.user_id === state.user.id
        ? { text: `${b.title} (you)`, mine: true, onClick: (btn) => cancelBooking(b.id, btn, refresh) }
        : { text: b.title },
      onFree: pickSlot,
    });
  }

  // Clicking an empty spot on the timeline fills in the booking form.
  function pickSlot(room, mins) {
    const [y, m, d] = $("day").value.split("-").map(Number);
    if (zoned(y, m, d, mins + 15) <= new Date()) { showMsg("That time has already passed.", "error"); return; }
    $("room").value = String(room.id);
    $("start").value = String(mins);
    updateSliderBusy();
    syncSliderFromForm();
    showMsg(`${room.name} at ${$("start").selectedOptions[0].textContent} selected. Add a title and press Book.`, "ok");
    $("book-form").scrollIntoView({ behavior: "smooth", block: "center" });
    $("title").focus({ preventScroll: true });
  }

  async function loadMine() {
    const { data, error } = await db
      .from("bookings")
      .select("id, room_id, title, starts_at, ends_at")
      .eq("user_id", state.user.id)
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
      li.append(text, button("Cancel", "link", (btn) => cancelBooking(b.id, btn, refresh)));
      return li;
    }));
  }

  $("book-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const s = state.settings;
    const roomId = Number($("room").value);
    const startMins = Number($("start").value);
    const durMins = Number($("duration").value);
    const title = $("title").value.trim();

    if (!rooms.some((r) => r.id === roomId)) { showMsg("Pick a room.", "error"); return; }
    if (!title || title.length > 100) { showMsg("Title must be 1–100 characters.", "error"); return; }
    if (startMins + durMins > s.close_hour * 60) {
      showMsg(`That would run past closing time (${s.close_hour}:00).`, "error");
      return;
    }

    const [y, m, d] = $("day").value.split("-").map(Number);
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
})();
