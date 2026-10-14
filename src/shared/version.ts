/**
 * Resolves the display version and environment descriptor for the extension.
 * Reads dynamically from chrome.runtime.getManifest() at runtime, ensuring the
 * displayed version always reflects the active extension package.
 */
export interface ExtensionVersionInfo {
  version: string;
  displayVersion: string;
  name: string;
  isStaging: boolean;
  tooltip: string;
}

export function getExtensionVersionInfo(): ExtensionVersionInfo {
  let name = "Minted Panel Workbench";
  let version = "0.1.8";

  try {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.getManifest === "function") {
      const manifest = chrome.runtime.getManifest();
      if (manifest?.version) version = manifest.version;
      if (manifest?.name) name = manifest.name;
    }
  } catch {
    // Non-extension or test environment fallback
  }

  const isStaging = name.toUpperCase().includes("STAGING");
  const displayVersion = isStaging ? `v${version} • staging` : `v${version}`;
  const tooltip = `${name} v${version}`;

  return {
    version,
    displayVersion,
    name,
    isStaging,
    tooltip,
  };
}
