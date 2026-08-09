// Deployment constants. Both values below are public by design: the Supabase
// anon key is the browser-side key (RLS + auth gate everything it can reach),
// and the API base is the deployed Minted Panel app. The service-role key
// must NEVER appear anywhere in this codebase.
//
// 3M Slice 5 / F13 — optional Vite env overrides so a staging (or local panel)
// build does not require editing this file. Unset vars keep production
// defaults. A real staging Supabase/Vercel project is still a platform ops
// deliverable (ROADMAP); this only removes the "edit source to retarget" muda.

function envOr(
  name: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY" | "VITE_API_BASE_URL",
  fallback: string,
): string {
  const value = import.meta.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export const SUPABASE_URL = envOr(
  "VITE_SUPABASE_URL",
  "https://fkvuhfsqcmujywzgczmc.supabase.co",
);
export const SUPABASE_ANON_KEY = envOr(
  "VITE_SUPABASE_ANON_KEY",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrdnVoZnNxY211anl3emdjem1jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNTQ0NzIsImV4cCI6MjA5NjYzMDQ3Mn0.Ek_6EvJkqJzdFmb0Ipwfl6zyOR6HzikKSz14EIOh2W8",
);
export const API_BASE_URL = envOr("VITE_API_BASE_URL", "https://mintedpanel.vercel.app");
