// A minimal in-memory chrome.* stub for the mock harness (TE-10). Installs
// itself on import so it exists BEFORE any background module evaluates.
// Covers exactly what the modules under test touch: storage.session, runtime
// messaging surfaces, tabs listeners. No Chrome behavior is simulated beyond
// what the tests drive explicitly.

type Listener = (...args: unknown[]) => unknown;

function eventSurface(): { addListener: (fn: Listener) => void; listeners: Listener[] } {
  const listeners: Listener[] = [];
  return { addListener: (fn: Listener) => listeners.push(fn), listeners };
}

export interface ChromeStub {
  sessionStore: Map<string, unknown>;
  broadcasts: unknown[];
  events: {
    messageExternal: ReturnType<typeof eventSurface>;
    tabUpdated: ReturnType<typeof eventSurface>;
    tabActivated: ReturnType<typeof eventSurface>;
    tabRemoved: ReturnType<typeof eventSurface>;
  };
  reset(): void;
}

export function installChromeStub(): ChromeStub {
  const sessionStore = new Map<string, unknown>();
  const broadcasts: unknown[] = [];
  const events = {
    messageExternal: eventSurface(),
    tabUpdated: eventSurface(),
    tabActivated: eventSurface(),
    tabRemoved: eventSurface(),
  };

  const chromeLike = {
    storage: {
      session: {
        get: async (key: string | string[] | null) => {
          if (key == null) return Object.fromEntries(sessionStore);
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (sessionStore.has(k)) out[k] = sessionStore.get(k);
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
        },
        remove: async (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) sessionStore.delete(k);
        },
      },
    },
    runtime: {
      id: "test-extension-id",
      // Worker → panel broadcast lands here; tests read `broadcasts`.
      sendMessage: async (message: unknown) => {
        broadcasts.push(message);
      },
      onMessage: eventSurface(),
      onMessageExternal: events.messageExternal,
    },
    tabs: {
      onUpdated: events.tabUpdated,
      onActivated: events.tabActivated,
      onRemoved: events.tabRemoved,
      query: async () => [],
      sendMessage: async () => {
        throw new Error("no content script in the harness");
      },
    },
    // Absent on purpose: activeCase.ts optional-chains sidePanel.
    sidePanel: undefined,
  };

  (globalThis as { chrome?: unknown }).chrome = chromeLike;

  return {
    sessionStore,
    broadcasts,
    events,
    reset() {
      sessionStore.clear();
      broadcasts.length = 0;
    },
  };
}

// Self-install so `import "./chromeStub"` (or importing the named helper)
// guarantees chrome exists before background modules load.
export const stub: ChromeStub = installChromeStub();
