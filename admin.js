"use strict";

// Admin page. Hiding it from non-admins is only tidiness: every action below is
// re-checked by the database (RLS + admin functions), so a non-admin gets nothing.
(() => {
  const { db, $, state, el, button, showMsg, friendlyError, withBusy,
          zoned, ymdInTz, fmtDate, fmtStamp, createCalendar, renderTimeline,
          loadSettings, isAdmin, loadDayBookings, cancelBooking, startAuth } = window.App;

  let rooms = [];
  const calendar = createCalendar($("calendar"), (ymd) => {
    $("day").value = ymd;
    loadSchedule();
  });

  startAuth({
    async onSignedIn() {
      if (!(await isAdmin())) {
        $("app").hidden = true;
        $("denied").hidden = false;
        return;
      }
      $("denied").hidden = true;
      await loadSettings();
      const today = ymdInTz(new Date());
      if (!$("day").value) $("day").value = today;
      calendar.update({ value: $("day").value, today });  // admins can look at any day
      fillRulesForm();
      $("app").hidden = false;
      await Promise.all([reloadRooms(), loadAdmins(), loadAudit(), loadDisplayStatus(), loadUsers()]);
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
    const ymd = $("day").value;
    let data;
    try { data = await loadDayBookings(ymd); } catch (err) { showMsg(friendlyError(err), "error"); return; }

    const owners = new Map();
    if (data.length) {
      const res = await db.rpc("admin_booking_owners", { p_ids: data.map((b) => b.id) });
      if (!res.error) for (const o of res.data) owners.set(o.id, o.email);
    }

    const [y, m, d] = ymd.split("-").map(Number);
    $("day-label").textContent = `All bookings · ${fmtDate(zoned(y, m, d, 12 * 60))}`;
    const booked = new Set(data.map((b) => b.room_id));
    renderTimeline($("schedule"), {
      rooms: rooms.filter((r) => r.is_active || booked.has(r.id)),
      bookings: data,
      ymd,
      describe: (b) => ({
        text: owners.has(b.id) ? `${b.title} · ${owners.get(b.id)}` : b.title,
        onClick: (btn) => cancelBooking(b.id, btn, () => Promise.all([loadSchedule(), loadAudit()])),
      }),
    });
  }

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
          await Promise.all([loadAdmins(), loadAudit(), loadUsers()]);
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
      await Promise.all([loadAdmins(), loadAudit(), loadUsers()]);
    });
  });

  // ---------------------------------------------------------------------------
  // Users. Runs in the admin-create-user Edge Function, which holds the service
  // key and re-checks that the caller is an admin on every request.
  // ---------------------------------------------------------------------------

  async function usersApi(action, payload = {}) {
    const { data, error } = await db.functions.invoke("admin-create-user", { body: { action, ...payload } });
    if (error) {
      let message = "Couldn't reach the user service. Is the Edge Function deployed?";
      try { message = (await error.context.json()).error || message; } catch { /* network or not deployed */ }
      throw new Error(message);
    }
    return data;
  }

  function newPassword() {
    // No look-alike characters (0/O, 1/l/I), so it's easy to read out or type.
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint32Array(14));
    return Array.from(bytes, (n) => chars[n % chars.length]).join("");
  }

  // Run a user action from a button, then refresh the list and activity log.
  function userAction(btn, action, payload, done) {
    return withBusy(btn, async () => {
      try {
        await usersApi(action, payload);
      } catch (err) {
        showMsg(err.message, "error");
        return;
      }
      showMsg(done, "ok");
      await Promise.all([loadUsers(), loadAudit()]);
    });
  }

  async function loadUsers() {
    let data;
    try {
      data = await usersApi("list");
    } catch (err) {
      $("user-list").replaceChildren(el("li", err.message, "empty"));
      return;
    }
    if (!data.users.length) { $("user-list").replaceChildren(el("li", "No users yet.", "empty")); return; }
    $("user-list").replaceChildren(...data.users.map((u) => {
      const li = el("li", null, u.disabled ? "disabled" : "");
      const info = el("span");
      info.append(el("strong", u.email));
      if (u.is_you) info.append(el("span", "you", "tag"));
      if (u.is_admin) info.append(el("span", "admin", "tag"));
      if (u.disabled) info.append(el("span", "disabled", "tag off"));
      info.append(el("small", u.last_sign_in_at ? `Last sign-in ${fmtStamp(new Date(u.last_sign_in_at))}` : "Never signed in"));

      const actions = el("span", null, "row-actions");
      actions.append(button("Reset password", "link", (btn) => {
        const password = prompt(`New password for ${u.email} (8+ characters):`, newPassword());
        if (password == null) return;
        userAction(btn, "reset_password", { userId: u.id, password }, `Password changed for ${u.email}. Send it to them privately.`);
      }));
      if (!u.is_you) {
        actions.append(u.disabled
          ? button("Enable", "link", (btn) => userAction(btn, "enable", { userId: u.id }, `${u.email} can sign in again.`))
          : button("Disable", "danger", (btn) => {
            if (!confirm(`Disable ${u.email}? They won't be able to sign in until you enable them again.`)) return;
            userAction(btn, "disable", { userId: u.id }, `${u.email} is disabled.`);
          }));
        actions.append(button("Delete", "danger", (btn) => {
          if (!confirm(`Delete ${u.email}? This also deletes all their bookings and can't be undone.`)) return;
          userAction(btn, "delete", { userId: u.id }, `${u.email} was deleted.`);
        }));
      }
      li.append(info, actions);
      return li;
    }));
  }

  $("user-generate").addEventListener("click", () => {
    $("user-password").value = newPassword();
  });

  $("user-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("user-email").value.trim().toLowerCase();
    const password = $("user-password").value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg("Enter a valid email address.", "error"); return; }
    if (password.length < 8 || password.length > 72) { showMsg("Password must be 8–72 characters.", "error"); return; }
    withBusy(e.submitter, async () => {
      try {
        await usersApi("create", { email, password });
      } catch (err) {
        showMsg(err.message, "error");
        return;
      }
      $("user-email").value = "";
      $("user-password").value = "";
      showMsg(`User ${email} created. They can sign in now.`, "ok");
      await Promise.all([loadUsers(), loadAudit()]);
    });
  });

  // ---------------------------------------------------------------------------
  // Lobby display link. The key is made and hashed in the database and shown
  // here once; it goes after # so it never reaches GitHub's servers.
  // ---------------------------------------------------------------------------

  const DISPLAY_PAGE = "display-7b2923be3d9a.html";

  async function loadDisplayStatus() {
    const { data, error } = await db.rpc("admin_display_enabled");
    $("display-status").textContent = error
      ? "Couldn't check the display link."
      : data ? "The display link is on." : "The display link is off.";
  }

  $("display-create").addEventListener("click", (e) => {
    if (!confirm("Create a new display link? Any existing link stops working.")) return;
    withBusy(e.currentTarget, async () => {
      const { data: key, error } = await db.rpc("admin_rotate_display_key");
      if (error) { showMsg(friendlyError(error), "error"); return; }
      const base = location.href.replace(/[^/]*([?#].*)?$/, "");
      $("display-link").value = `${base}${DISPLAY_PAGE}#k=${key}`;
      $("display-link-box").hidden = false;
      $("display-once").hidden = false;
      showMsg("New display link created.", "ok");
      await Promise.all([loadDisplayStatus(), loadAudit()]);
    });
  });

  $("display-off").addEventListener("click", (e) => {
    if (!confirm("Turn off the display link? The lobby screen will stop showing the schedule.")) return;
    withBusy(e.currentTarget, async () => {
      const { error } = await db.rpc("admin_disable_display");
      if (error) { showMsg(friendlyError(error), "error"); return; }
      $("display-link-box").hidden = true;
      $("display-once").hidden = true;
      $("display-link").value = "";
      showMsg("Display link turned off.", "ok");
      await Promise.all([loadDisplayStatus(), loadAudit()]);
    });
  });

  $("display-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("display-link").value);
      showMsg("Link copied.", "ok");
    } catch {
      $("display-link").select();
      showMsg("Press Ctrl+C to copy the selected link.", "ok");
    }
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
      case "settings": {
        const o = row.old_data || {}, n = row.new_data || {};
        const keys = Object.keys(n).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
        if (keys.length === 1 && keys[0] === "display_key_hash") {
          return n.display_key_hash ? "created a new display link" : "turned off the display link";
        }
        return "changed booking rules";
      }
      case "admins": return row.action === "INSERT" ? "added an admin" : "removed an admin";
      case "users":
        if (row.action === "INSERT") return `created user ${data.email || ""}`;
        if (row.action === "DELETE") return `deleted user ${data.email || ""}`;
        return `${data.change || "changed"} user ${data.email || ""}`;
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
