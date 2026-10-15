// Capture-probe build: the extension's scanner as one self-contained IIFE an
// agent injects into a payer form (payer-form-capture skill). Separate outDir
// so it can never ride an extension package.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist-probe",
    emptyOutDir: true,
    lib: {
      entry: "src/probe/captureProbe.ts",
      formats: ["iife"],
      name: "MintedCaptureProbe",
      fileName: () => "capture-probe.js",
    },
  },
});
