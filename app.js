"use strict";

// User page: see the schedule, book a room, cancel your own bookings.
(() => {
  const { db, $, state, el, button, showMsg, friendlyError, withBusy,
          zoned, ymdInTz, addDays, fmtTime, fmtDate, hhmm, MIN_LEN, createCalendar, renderTimeline,
          loadSettings, isAdmin, loadDayBookings, cancelBooking, startAuth } = window.App;

  let rooms = [];
  let timeline = null;
  let picked = false;  // show a selection on the schedule only once the user has picked a time
  const calendar = createCalendar($("calendar"), (ymd) => {
    $("day").value = ymd;
    loadSchedule();
  });

  function minutesLabel(m) {
    const h = Math.floor(m / 60), r = m % 60;
    return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
  }

  // Bookings are to the minute; the form's dropdowns list quarter-hours, and any
  // other value picked on the timeline is added to them on the fly.
  function ensureOption(select, value, label) {
    const v = String(value);
    if (![...select.options].some((o) => o.value === v)) {
      const o = el("option", label);
      o.value = v;
      select.insertBefore(o, [...select.options].find((x) => Number(x.value) > value) || null);
    }
    select.value = v;
  }

  // Single place that sets the picked time: dropdowns and timeline.
  function setRange(a, b) {
    ensureOption($("start"), a, hhmm(a));
    ensureOption($("duration"), b - a, minutesLabel(b - a));
    if (timeline) timeline.select(Number($("room").value), a, b);
  }

  // Minutes since midnight (org timezone) on the selected day that are already past.
  function nowMinOnDay() {
    const [y, m, d] = $("day").value.split("-").map(Number);
    return (Date.now() - zoned(y, m, d, 0).getTime()) / 60000;
  }

  function syncFromForm() {
    picked = true;
    const start = Number($("start").value);
    setRange(start, start + Number($("duration").value));
  }

  $("room").addEventListener("change", syncFromForm);
  $("start").addEventListener("change", syncFromForm);
  $("duration").addEventListener("change", syncFromForm);

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

    // Quarter-hour lengths; other lengths picked on the timeline are added on the fly.
    const durs = [];
    for (let m = 15; m <= s.max_duration_minutes; m += 15) durs.push(m);
    $("duration").replaceChildren(...durs.map((m) => {
      const o = el("option", minutesLabel(m));
      o.value = String(m);
      return o;
    }));
    $("duration").value = durs.includes(60) ? "60" : String(durs[0]);

    // Start at the next free quarter-hour rather than at opening time.
    const next = Math.ceil(nowMinOnDay() / 15) * 15;
    if (next > s.open_hour * 60 && next < s.close_hour * 60) $("start").value = String(next);

  }

  async function loadSchedule() {
    const ymd = $("day").value;
    let data;
    try { data = await loadDayBookings(ymd); } catch (err) { showMsg(friendlyError(err), "error"); return; }

    const [y, m, d] = ymd.split("-").map(Number);
    $("day-label").textContent = `Schedule · ${fmtDate(zoned(y, m, d, 12 * 60))}`;
    timeline = renderTimeline($("schedule"), {
      rooms,
      bookings: data,
      ymd,
      describe: (b) => b.user_id === state.user.id
        ? { text: `${b.title} (you)`, mine: true, onClick: (btn) => cancelBooking(b.id, btn, refresh) }
        : { text: b.title },
      onSelect: pickRange,
      maxMinutes: state.settings.max_duration_minutes,
    });
    if (picked) syncFromForm();
  }

  // Dragging on the timeline fills in the booking form.
  function pickRange(room, a, b) {
    picked = true;
    $("room").value = String(room.id);
    setRange(a, b);
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
