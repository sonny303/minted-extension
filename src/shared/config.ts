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

// On-device AI suggestions stay out of the fill flow until they return with a
// designed review step (PM decision, Oct 14 2026). The code is kept; this one
// gate skips the model check, the page scan, and the review card.
export const AI_FILL_ENABLED = false;

// The per-field fresh PROBE_FILL the worker sends before every write after
// the first is the measured top cost of a fill (docs/fill-latency-spike.md):
// each one waits for a 120 ms mutation-quiet window, capped at 700 ms. On,
// that re-probe goes out unsettled first and is re-sent settled only when the
// fast probe finds no unique target. Off until a staging fill of a real form
// shows identical filled/skipped lists with the flag on and off.
export const FAST_REPROBE_ENABLED = false;
