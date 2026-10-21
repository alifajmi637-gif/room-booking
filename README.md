# Room Booking

A small meeting room booking app. Static frontend hosted on **GitHub Pages**, data and sign-in on **Supabase**.

## Security model

The browser is untrusted. Every rule is enforced by Postgres in [supabase/schema.sql](supabase/schema.sql):

| Threat | Defence |
| --- | --- |
| Anonymous access | All privileges revoked from `anon`; only `authenticated` gets grants |
| Editing or deleting someone else's booking | RLS: insert and delete only where `user_id = auth.uid()`; no UPDATE grant at all |
| Spoofing the owner | Trigger overwrites `user_id` with `auth.uid()`; column-level grants block writing it |
| Double booking (including races) | `EXCLUDE USING gist` constraint on room + time range |
| Junk data | CHECK constraints on title length and control characters, 15-min slots, 15 min–8 h duration, no past bookings, max 90 days ahead |
| One user hoarding rooms | Max 20 upcoming bookings per user, serialised with an advisory lock |
| Password leaks | No passwords: sign-in is by a one-time email code |
| XSS | User text is rendered with `textContent` only. Strict CSP: no inline scripts, no third-party scripts |
| Supply chain | supabase-js 2.45.4 is vendored in `vendor/`, not loaded from a CDN |
| Clickjacking | Frame-busting check (GitHub Pages can't send `frame-ancestors`) |

The anon key in `config.js` is meant to be public. **Never** put the `service_role` key in this repo.

## Setup

### 1. Supabase

1. Create a project at <https://supabase.com/dashboard>.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and click **Run**. Edit the seed rooms at the bottom first if you want.
3. **Authentication → Emails → Magic Link template**: make the body contain the code, e.g. `Your sign-in code is {{ .Token }}`.
4. **Authentication → Sign In / Providers**:
   - Keep **Email** enabled and turn off every provider you don't use.
   - Optional but recommended: turn off **Allow new users to sign up**. Then add staff under **Authentication → Users → Invite**, and only they can sign in.
5. **Authentication → URL Configuration**: set **Site URL** to your Pages URL, e.g. `https://<your-username>.github.io/room-booking/`.
6. Optional: to restrict access to your company domain, uncomment the `company_only_*` policies in `schema.sql`, set your domain and run them.
7. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `config.js`.

### 2. GitHub Pages

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
