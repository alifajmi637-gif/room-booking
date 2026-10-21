"use strict";

// Admin page. Hiding it from non-admins is only tidiness: every action below is
// re-checked by the database (RLS + admin functions), so a non-admin gets nothing.
(() => {
  const { db, $, state, el, button, showMsg, friendlyError, withBusy,
          ymdInTz, fmtTime, fmtStamp, loadSettings, isAdmin, loadDayBookings,
          cancelBooking, startAuth } = window.App;

  let rooms = [];

  startAuth({
    async onSignedIn() {
      if (!(await isAdmin())) {
        $("app").hidden = true;
        $("denied").hidden = false;
        return;
      }
      $("denied").hidden = true;
      await loadSettings();
      if (!$("day").value) $("day").value = ymdInTz(new Date());
      fillRulesForm();
      $("app").hidden = false;
      await Promise.all([reloadRooms(), loadAdmins(), loadAudit()]);
    },
    onSignedOut() {
      $("app").hidden = true;
      $("denied").hidden = true;
    },
  });

  // ---------------------------------------------------------------------------
  // All bookings for a day, with who made them
  // ---------------------------------------------------------------------------

  async function loadSchedule() {
    let data;
    try { data = await loadDayBookings($("day").value); } catch (err) { showMsg(friendlyError(err), "error"); return; }

    const owners = new Map();
    if (data.length) {
      const res = await db.rpc("admin_booking_owners", { p_ids: data.map((b) => b.id) });
      if (!res.error) for (const o of res.data) owners.set(o.id, o.email);
    }

    const byRoom = new Map(rooms.map((r) => [r.id, []]));
    for (const b of data) if (byRoom.has(b.room_id)) byRoom.get(b.room_id).push(b);

    $("schedule").replaceChildren(...rooms.filter((r) => r.is_active || byRoom.get(r.id).length).map((r) => {
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
        const li = el("li");
        const text = el("span");
        text.append(
          el("span", `${fmtTime(new Date(b.starts_at))} – ${fmtTime(new Date(b.ends_at))} `, "time"),
          el("span", b.title),
          " ",
          el("span", owners.get(b.id) || "", "who"),
        );
        li.append(text, button("Cancel", "link", (btn) => cancelBooking(b.id, btn, () => Promise.all([loadSchedule(), loadAudit()]))));
        ul.append(li);
      }
      card.append(ul);
      return card;
    }));
  }

  $("day").addEventListener("change", () => { if (state.user && $("day").value) loadSchedule(); });

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------

  async function reloadRooms() {
    const { data, error } = await db.from("rooms").select("id, name, capacity, is_active").order("name");
    if (error) { showMsg(friendlyError(error), "error"); return; }
    rooms = data;
    renderRooms();
    await loadSchedule();
  }

  function renderRooms() {
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
        await Promise.all([reloadRooms(), loadAudit()]);
      }));

      const del = button("Delete", "danger", (btn) => {
        if (!confirm(`Delete "${r.name}"? This only works if it has never been booked.`)) return;
        withBusy(btn, async () => {
          const { error, count } = await db.from("rooms").delete({ count: "exact" }).eq("id", r.id);
          if (error || count === 0) { showMsg(error ? friendlyError(error) : "Couldn't delete that room.", "error"); return; }
          showMsg("Room deleted.", "ok");
          await Promise.all([reloadRooms(), loadAudit()]);
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
      await Promise.all([reloadRooms(), loadAudit()]);
    });
  });

  // ---------------------------------------------------------------------------
  // Booking rules
  // ---------------------------------------------------------------------------

  const RULE_FIELDS = {
    "rule-tz": "timezone",
    "rule-open": "open_hour",
    "rule-close": "close_hour",
    "rule-duration": "max_duration_minutes",
    "rule-ahead": "max_days_ahead",
    "rule-cap": "max_upcoming_per_user",
  };

  function fillRulesForm() {
    for (const [id, key] of Object.entries(RULE_FIELDS)) $(id).value = String(state.settings[key]);
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
      await loadSettings();
      fillRulesForm();
      showMsg("Rules saved.", "ok");
      await Promise.all([loadSchedule(), loadAudit()]);
    });
  });

  // ---------------------------------------------------------------------------
  // Admins
  // ---------------------------------------------------------------------------

  async function loadAdmins() {
    const { data, error } = await db.rpc("admin_list_admins");
    if (error) { showMsg(friendlyError(error), "error"); return; }
    $("admin-list").replaceChildren(...data.map((a) => {
      const li = el("li");
      li.append(el("span", a.user_id === state.user.id ? `${a.email} (you)` : a.email));
      li.append(button("Remove", "danger", (btn) => {
        if (!confirm(`Remove admin rights from ${a.email}?`)) return;
        withBusy(btn, async () => {
          const { error: err } = await db.rpc("admin_remove", { p_user_id: a.user_id });
          if (err) { showMsg(friendlyError(err), "error"); return; }
          if (a.user_id === state.user.id) { location.href = "./"; return; }
          showMsg("Admin removed.", "ok");
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

  // ---------------------------------------------------------------------------
  // Activity log
  // ---------------------------------------------------------------------------

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
