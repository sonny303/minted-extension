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
  tabQueries: chrome.tabs.QueryInfo[];
  /** One-shot hooks consumed in order by storage.session.set. Tests use these
   * to hold or fail a specific persistence step without changing production. */
  queueSessionSet(hook: (items: Record<string, unknown>) => Promise<void>): void;
  setQueryTabs(tabs: chrome.tabs.Tab[]): void;
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
  const tabQueries: chrome.tabs.QueryInfo[] = [];
  const sessionSetHooks: Array<(items: Record<string, unknown>) => Promise<void>> = [];
  let queryTabs: chrome.tabs.Tab[] = [];
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
          const hook = sessionSetHooks.shift();
          if (hook) await hook(items);
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
      query: async (queryInfo: chrome.tabs.QueryInfo = {}) => {
        tabQueries.push(queryInfo);
        return queryTabs.filter(
          (tab) =>
            (queryInfo.windowId == null || tab.windowId === queryInfo.windowId) &&
            (queryInfo.active == null || tab.active === queryInfo.active),
        );
      },
      sendMessage: async () => {
        throw new Error("no content script in the harness");
      },
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, url: "" }],
    },
    // Absent on purpose: activeCase.ts optional-chains sidePanel.
    sidePanel: undefined,
  };

  (globalThis as { chrome?: unknown }).chrome = chromeLike;

  return {
    sessionStore,
    broadcasts,
    tabQueries,
    queueSessionSet(hook) {
      sessionSetHooks.push(hook);
    },
    setQueryTabs(tabs) {
      queryTabs = tabs;
    },
    events,
    reset() {
      sessionStore.clear();
      broadcasts.length = 0;
      tabQueries.length = 0;
      sessionSetHooks.length = 0;
      queryTabs = [];
    },
  };
}

// Self-install so `import "./chromeStub"` (or importing the named helper)
// guarantees chrome exists before background modules load.
export const stub: ChromeStub = installChromeStub();
