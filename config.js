// Public Supabase settings. Both values are safe to publish: the anon key only
// grants what Row Level Security in supabase/schema.sql allows.
// NEVER put the service_role key here.
window.APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
});
