// `npm run watch` — rebuild BOTH bundles on change.
//
// Two Vite configs emit into the same dist/: the main one (side panel +
// background, ES modules) and vite.content.config.ts (the content script, a
// standalone IIFE — content scripts cannot be ES modules). Watching only the
// main config, as this script used to do, left dist/content.js stale after the
// first edit, so fill and capture silently ran old code in the page.
//
// They cannot simply run as two independent watchers: the main config sets
// emptyOutDir, so every main rebuild deletes dist/content.js, and the content
// watcher has no reason to re-emit it. So the main watcher's completion is what
// triggers a content rebuild, and a second watcher covers content-only edits.
import { build } from "vite";

let contentBuild = Promise.resolve();

/** Serialize content builds so two triggers can never write dist/content.js at once. */
function rebuildContent(reason) {
  contentBuild = contentBuild
    .then(() => build({ configFile: "vite.content.config.ts", logLevel: "warn" }))
    .then(() => {
      console.log(`content.js rebuilt (${reason})`);
    })
    .catch((error) => {
      console.error(`content.js build failed (${reason}):`, error);
    });
  return contentBuild;
}

// Main watcher: side panel + background. Its emptyOutDir wipe is why every
// successful bundle has to be followed by a content rebuild.
const mainWatcher = await build({ build: { watch: {} } });
mainWatcher.on("event", (event) => {
  if (event.code === "END") void rebuildContent("main bundle changed");
  if (event.code === "ERROR") console.error(event.error);
});

// Content watcher: picks up edits under src/content/ that the main config
// never sees. Its output survives until the next main rebuild, which re-emits.
const contentWatcher = await build({
  configFile: "vite.content.config.ts",
  build: { watch: {} },
});
contentWatcher.on("event", (event) => {
  if (event.code === "ERROR") console.error(event.error);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void Promise.all([mainWatcher.close(), contentWatcher.close()]).finally(() => {
      process.exit(0);
    });
  });
}
