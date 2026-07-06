// Main build: the side panel page (html entry) and the background service
// worker (ES module — manifest declares "type": "module"). The content script
// is built separately as an IIFE by vite.content.config.ts because content
// scripts cannot be ES modules.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: "sidepanel.html",
        background: "src/background/index.ts",
      },
      output: {
        // The manifest points at a stable filename for the worker; panel
        // assets keep hashed names since sidepanel.html references them.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
