import { afterEach, describe, expect, it } from "vitest";
import { getExtensionVersionInfo } from "./version";

describe("getExtensionVersionInfo", () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it("resolves default fallback when chrome runtime is undefined", () => {
    delete (globalThis as { chrome?: unknown }).chrome;
    const info = getExtensionVersionInfo();
    expect(info.version).toBe("0.1.4");
    expect(info.displayVersion).toBe("v0.1.4");
    expect(info.name).toBe("Minted Panel Workbench");
    expect(info.isStaging).toBe(false);
    expect(info.tooltip).toBe("Minted Panel Workbench v0.1.4");
  });

  it("resolves dynamically from chrome.runtime.getManifest() for production", () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        getManifest: () => ({
          manifest_version: 3,
          name: "Minted Panel Workbench",
          version: "0.1.4",
        }),
      },
    };
    const info = getExtensionVersionInfo();
    expect(info.version).toBe("0.1.4");
    expect(info.displayVersion).toBe("v0.1.4");
    expect(info.name).toBe("Minted Panel Workbench");
    expect(info.isStaging).toBe(false);
    expect(info.tooltip).toBe("Minted Panel Workbench v0.1.4");
  });

  it("identifies staging builds from manifest name and formats display string", () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        getManifest: () => ({
          manifest_version: 3,
          name: "Minted Panel Workbench — STAGING (Local)",
          version: "0.1.4",
        }),
      },
    };
    const info = getExtensionVersionInfo();
    expect(info.version).toBe("0.1.4");
    expect(info.displayVersion).toBe("v0.1.4 • staging");
    expect(info.isStaging).toBe(true);
    expect(info.tooltip).toBe("Minted Panel Workbench — STAGING (Local) v0.1.4");
  });
});
