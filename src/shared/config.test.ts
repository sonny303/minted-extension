import { describe, expect, it } from "vitest";
import { API_BASE_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

describe("config defaults (F13)", () => {
  it("keeps production defaults when Vite env overrides are unset", () => {
    expect(SUPABASE_URL).toBe("https://fkvuhfsqcmujywzgczmc.supabase.co");
    expect(API_BASE_URL).toBe("https://mintedpanel.com");
    expect(SUPABASE_ANON_KEY.startsWith("eyJ")).toBe(true);
    // Payload embeds the project ref (base64) — pin length so the default did
    // not get truncated by an empty env override.
    expect(SUPABASE_ANON_KEY.length).toBeGreaterThan(100);
  });
});
