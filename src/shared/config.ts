// Deployment constants. These values are public by design: the Supabase
// anon key is the browser-side key (RLS + auth gate everything it can reach),
// and the API base is the deployed Minted Panel app. The service-role key
// must NEVER appear anywhere in this codebase.
//
// Static references let Vite remove unused production defaults from a staging
// package. Guarded release builds require all three explicit values and inspect
// the complete output; the legacy development build keeps its defaults.
export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "https://fkvuhfsqcmujywzgczmc.supabase.co";
export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrdnVoZnNxY211anl3emdjem1jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNTQ0NzIsImV4cCI6MjA5NjYzMDQ3Mn0.Ek_6EvJkqJzdFmb0Ipwfl6zyOR6HzikKSz14EIOh2W8";
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://mintedpanel.vercel.app";
