# Room Booking

A small meeting room booking app. Static frontend hosted on **GitHub Pages**, data and sign-in on **Supabase**.

## Security model

The browser is untrusted. Every rule is enforced by Postgres in [supabase/schema.sql](supabase/schema.sql):

| Threat | Defence |
| --- | --- |
| Anonymous access | All privileges revoked from `anon`; only `authenticated` gets grants |
| Editing or deleting someone else's booking | RLS: users insert and delete only their own; no UPDATE grant at all |
| Becoming admin | `admins` table has no client grants at all; admin actions run through functions that re-check `is_admin()` on every call; the last admin can't be removed |
| Covering tracks | `audit_log` is written only by triggers and has no client grants, so nobody can edit it from the app |
| Spoofing the owner | Trigger overwrites `user_id` with `auth.uid()`; column-level grants block writing it |
| Double booking (including races) | `EXCLUDE USING gist` constraint on room + time range |
| Junk data | CHECK constraints on text, whole minutes (5-minute minimum), no past bookings; opening hours, max length, days ahead and per-user cap come from admin-editable `settings` and are enforced in a trigger |
| One user hoarding rooms | Per-user cap on upcoming bookings, serialised with an advisory lock |
| Unwanted accounts | No public sign-up: admins create accounts from the admin page via the `admin-create-user` Edge Function, which holds the service key server-side and re-checks `is_admin()` |
| XSS | User text is rendered with `textContent` only. Strict CSP: no inline scripts, no third-party scripts |
| Supply chain | supabase-js 2.45.4 is vendored in `vendor/`, not loaded from a CDN |
| Clickjacking | Frame-busting check (GitHub Pages can't send `frame-ancestors`) |

The anon key in `config.js` is meant to be public. **Never** put the `service_role` key in this repo.

## Setup

### 1. Supabase

1. Create a project at <https://supabase.com/dashboard>.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and click **Run**. Edit the seed rooms at the bottom first if you want.
3. **Edge Functions → Deploy a new function → Via Editor**: name it `admin-create-user`, paste `supabase/functions/admin-create-user/index.ts`, keep **Verify JWT** on, and deploy.
4. **Authentication → Sign In / Providers**:
   - Keep **Email** enabled and turn off every provider you don't use.
   - Turn off **Allow new users to sign up**. Admins add people from the admin page instead.
5. **Authentication → URL Configuration**: set **Site URL** to your Pages URL, e.g. `https://<your-username>.github.io/room-booking/`.
6. Optional: to restrict access to your company domain, uncomment the `company_only_*` policies in `schema.sql`, set your domain and run them.
7. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `config.js`.

### 2. Make yourself admin

Create your account under **Authentication → Users → Add user** (tick **Auto Confirm User**), then run this in the SQL Editor with your email:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'you@example.com';
```

Then open `admin.html` and sign in. From there you can see all bookings, manage rooms, booking rules, users and admins, and see recent activity.

### 3. GitHub Pages

```bash
git remote add origin https://github.com/<your-username>/room-booking.git
git push -u origin main
```

Then go to **repo Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, **Branch: `main` / root**. The site goes live at `https://<your-username>.github.io/room-booking/`.

## Running locally

```bash
npx serve .
```

Open the printed URL. You can't use `file://`, because the CSP only allows scripts from the page's own origin.
