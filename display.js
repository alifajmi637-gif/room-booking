"use strict";

// Lobby display: which rooms are free or occupied today. No login; the key in
// the URL fragment (never sent to GitHub) is checked by display_today().
(() => {
  const { db, $, state, el, showMsg, ymdInTz, fmtTime, fmtDate, renderTimeline } = window.App;

  const key = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  let data = null;

  async function load() {
    if (!key) { fail(); return; }
    const { data: res, error } = await db.rpc("display_today", { p_key: key });
    if (error) { fail(); return; }
    data = res;
    state.settings = { timezone: res.timezone, open_hour: res.open_hour, close_hour: res.close_hour };
    showMsg("");
    $("app").hidden = false;
    render();
    $("updated").textContent = `Updated ${fmtTime(new Date())}. Refreshes every minute.`;
  }

  function fail() {
    data = null;
    $("app").hidden = true;
    showMsg("This display link is invalid or has been turned off. Ask an admin for a new one.", "error");
  }

  function render() {
    const now = Date.now();
    const closeToday = closeTime();

    $("status").replaceChildren(...data.rooms.map((r) => {
      const mine = data.bookings
        .filter((b) => b.room_id === r.id)
        .map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()]);
      const current = mine.find(([s, e]) => s <= now && now < e);
      const card = el("div", null, "status-card");
      card.append(el("strong", r.name), el("small", `${r.capacity} people`));

      if (current) {
        // Back-to-back bookings count as one stretch.
        let until = current[1];
        for (const [s, e] of mine) if (s <= until && e > until) until = e;
        card.classList.add("busy");
        card.append(el("span", "Occupied", "state"), el("span", `until ${fmtTime(new Date(until))}`, "detail"));
      } else {
        const next = mine.filter(([s]) => s > now).sort((a, b) => a[0] - b[0])[0];
        card.classList.add("free");
        card.append(
          el("span", now >= closeToday ? "Closed" : "Free", "state"),
          el("span", next ? `until ${fmtTime(new Date(next[0]))}` : "for the rest of today", "detail"),
        );
      }
      return card;
    }));

    renderTimeline($("schedule"), {
      rooms: data.rooms,
      bookings: data.bookings,
      ymd: ymdInTz(new Date()),
      describe: () => ({ text: "Occupied" }),
    });
  }

  function closeTime() {
    const [y, m, d] = ymdInTz(new Date()).split("-").map(Number);
    return window.App.zoned(y, m, d, state.settings.close_hour * 60).getTime();
  }

  function tick() {
    const now = new Date();
    if (state.settings) {
      $("clock-date").textContent = fmtDate(now);
      $("clock-time").textContent = fmtTime(now);
    }
  }

  load().then(tick);
  setInterval(tick, 1000);
  setInterval(() => { if (data) render(); }, 15000);  // statuses roll over between refreshes
  setInterval(load, 60000);
  window.addEventListener("hashchange", () => location.reload());
})();
