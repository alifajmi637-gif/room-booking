"use strict";

// User page: see the schedule, book a room, cancel your own bookings.
(() => {
  const { db, $, state, el, button, showMsg, friendlyError, withBusy,
          zoned, ymdInTz, addDays, fmtTime, fmtDate, createCalendar, renderTimeline,
          loadSettings, isAdmin, loadDayBookings, cancelBooking, startAuth } = window.App;

  let rooms = [];
  const calendar = createCalendar($("calendar"), (ymd) => {
    $("day").value = ymd;
    loadSchedule();
  });

  function minutesLabel(m) {
    const h = Math.floor(m / 60), r = m % 60;
    return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
  }

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

    const durs = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 600, 720]
      .filter((m) => m <= s.max_duration_minutes);
    if (!durs.includes(s.max_duration_minutes)) durs.push(s.max_duration_minutes);
    $("duration").replaceChildren(...durs.map((m) => {
      const o = el("option", minutesLabel(m));
      o.value = String(m);
      return o;
    }));
    $("duration").value = durs.includes(60) ? "60" : String(durs[0]);
  }

  async function loadSchedule() {
    const ymd = $("day").value;
    let data;
    try { data = await loadDayBookings(ymd); } catch (err) { showMsg(friendlyError(err), "error"); return; }

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
