"use strict";

// User page: see the schedule, book a room, cancel your own bookings.
(() => {
  const { db, $, state, el, button, showMsg, friendlyError, withBusy,
          zoned, ymdInTz, addDays, fmtTime, fmtDate, loadSettings, isAdmin,
          loadDayBookings, cancelBooking, startAuth } = window.App;

  let rooms = [];

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
    let data;
    try { data = await loadDayBookings($("day").value); } catch (err) { showMsg(friendlyError(err), "error"); return; }

    const byRoom = new Map(rooms.map((r) => [r.id, []]));
    for (const b of data) if (byRoom.has(b.room_id)) byRoom.get(b.room_id).push(b);

    $("schedule").replaceChildren(...rooms.map((r) => {
      const card = el("div", null, "room");
      const h = el("h3", r.name);
      h.append(" ", el("span", `· ${r.capacity} people`, "cap"));
      card.append(h);
      const items = byRoom.get(r.id);
      if (!items.length) {
        card.append(el("p", "Free all day", "empty"));
        return card;
      }
      const ul = el("ul", null, "list");
      for (const b of items) {
        const mine = b.user_id === state.user.id;
        const li = el("li", null, mine ? "mine" : "");
        const text = el("span");
        text.append(
          el("span", `${fmtTime(new Date(b.starts_at))} – ${fmtTime(new Date(b.ends_at))} `, "time"),
          el("span", mine ? `${b.title} (you)` : b.title),
        );
        li.append(text);
        ul.append(li);
      }
      card.append(ul);
      return card;
    }));
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

  $("day").addEventListener("change", () => { if (state.user && $("day").value) loadSchedule(); });
})();
