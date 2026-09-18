import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("release handoff configuration", () => {
  it("uses staging configuration and rejects production sender origins", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://staging.mintedpanel.com");
    vi.stubEnv("VITE_SUPABASE_URL", "https://vmznysvietfaddakkegt.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-value");
    vi.stubGlobal("__MINTED_RELEASE_HANDOFF_ORIGINS__", [
      "https://staging.mintedpanel.com",
      "https://mintedpanel-staging.vercel.app",
    ]);
    vi.resetModules();
    const config = await import("./config");
    const handoff = await import("./handoff");
    expect(config.API_BASE_URL).toBe("https://staging.mintedpanel.com");
    expect(config.SUPABASE_URL).toBe("https://vmznysvietfaddakkegt.supabase.co");
    expect(config.SUPABASE_ANON_KEY).toBe("synthetic-public-value");
    expect(handoff.isAllowedHandoffOrigin("https://staging.mintedpanel.com")).toBe(true);
    expect(handoff.isAllowedHandoffOrigin("https://mintedpanel-staging.vercel.app")).toBe(true);
    expect(handoff.isAllowedHandoffOrigin("https://www.mintedpanel.com")).toBe(false);
    expect(handoff.isAllowedHandoffOrigin("https://mintedpanel.vercel.app")).toBe(false);
  });
});
