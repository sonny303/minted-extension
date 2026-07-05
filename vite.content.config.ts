// Content-script build: a single self-contained IIFE (content scripts run in
// the page's process and cannot be ES modules). Runs after the main build
// with emptyOutDir off so dist/ accumulates both outputs.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/content/index.ts",
      formats: ["iife"],
      name: "MintedContent",
      fileName: () => "content.js",
    },
  },
});
