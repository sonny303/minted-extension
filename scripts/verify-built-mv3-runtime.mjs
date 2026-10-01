import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const API_ORIGIN = "https://mintedpanel.vercel.app";
const SUPABASE_ORIGIN = "https://fkvuhfsqcmujywzgczmc.supabase.co";
const AUTH_KEY = "sb-fkvuhfsqcmujywzgczmc-auth-token";
const ACTIVE_CASE_KEY = "minted.activeCase";
const ACTIVE_ORG_KEY = "minted.activeOrgId";
const SELECTED_PROVIDER_KEY = "minted.selectedProviderId";
const OWNER_KEY = "minted.workbenchOwner";

const EXPECTED_MANIFEST = {
  permissions: [
    "storage",
    "activeTab",
    "sidePanel",
    "scripting",
    "webNavigation",
  ],
  host_permissions: [
    "https://mintedpanel.vercel.app/*",
    "https://mintedpanel.com/*",
    "https://fkvuhfsqcmujywzgczmc.supabase.co/*",
  ],
  optional_host_permissions: ["https://*/*"],
  externally_connectable: [
    "https://mintedpanel.vercel.app/*",
    "https://mintedpanel.com/*",
    "https://www.mintedpanel.com/*",
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error(
    "Chrome/Chromium was not found; set CHROME_BIN to the executable.",
  );
}

class DevTools {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(url) {
    const Socket = globalThis.WebSocket;
    if (!Socket)
      throw new Error("This Node runtime does not provide global WebSocket.");
    this.#socket = new Socket(url);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.#socket.addEventListener("open", resolveReady, { once: true });
      this.#socket.addEventListener(
        "error",
        () =>
          rejectReady(new Error("Chrome DevTools WebSocket failed to open.")),
        { once: true },
      );
    });
    this.#socket.addEventListener("message", (event) =>
      this.#dispatch(event.data),
    );
    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values())
        pending.reject(new Error("Chrome DevTools connection closed."));
      this.#pending.clear();
    });
  }

  #dispatch(raw) {
    const message = JSON.parse(String(raw));
    if (message.id != null) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.#listeners.get(message.method) ?? []) {
      listener(message.params ?? {}, message.sessionId);
    }
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = ++this.#nextId;
    return new Promise((resolveResult, rejectResult) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectResult(new Error(`Chrome DevTools timed out: ${method}`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: resolveResult,
        reject: rejectResult,
        timeout,
      });
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    this.#socket.close();
  }
}

async function poll(read, accept, label, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${label}${last ? ` (${last instanceof Error ? last.message : JSON.stringify(last)})` : ""}.`,
  );
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
  await new Promise((resolveClosed) => {
    const forceKill = setTimeout(() => chrome.kill("SIGKILL"), 5_000);
    const giveUp = setTimeout(resolveClosed, 10_000);
    chrome.once("close", () => {
      clearTimeout(forceKill);
      clearTimeout(giveUp);
      resolveClosed();
    });
    chrome.kill("SIGTERM");
  });
}

async function evaluate(devtools, expression, sessionId) {
  const response = await devtools.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text;
    throw new Error(`Extension evaluation failed: ${description}`);
  }
  return response.result?.value;
}

function protocolResponse(
  body,
  contentType = "application/json; charset=utf-8",
) {
  return {
    responseHeaders: [
      { name: "content-type", value: contentType },
      { name: "access-control-allow-origin", value: "*" },
      {
        name: "access-control-allow-headers",
        value: "authorization, apikey, content-type, x-client-info, x-org-id",
      },
      {
        name: "access-control-allow-methods",
        value: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      },
    ],
    body: Buffer.from(body).toString("base64"),
  };
}

function activeCaseRecord(tabId) {
  const timestamp = new Date().toISOString();
  return {
    receiptId: "m22-runtime-smoke-receipt",
    providerId: "8f3b6609-f0c9-4682-ad2e-7e5ec8e87155",
    caseId: "a53ee610-f54f-4f32-9eb1-271da140e9e2",
    orgId: "m22-runtime-org",
    // This host is already granted by the production manifest, so Chrome
    // includes the URL on tabs.onUpdated without requesting broader access.
    portalUrl: "https://mintedpanel.com/m22-runtime",
    portalKey: "m22-runtime-portal",
    facilityId: null,
    source: "handoff",
    boundTabId: tabId,
    tabClosedAt: null,
    createdAt: timestamp,
    lastActivityAt: timestamp,
  };
}

async function main() {
  const manifest = JSON.parse(
    await readFile(join(DIST, "manifest.json"), "utf8"),
  );
  assert(manifest.manifest_version === 3, "Built package is not Manifest V3.");
  assert(
    JSON.stringify(manifest.permissions) ===
      JSON.stringify(EXPECTED_MANIFEST.permissions),
    "Built manifest permissions changed unexpectedly.",
  );
  assert(
    JSON.stringify(manifest.host_permissions) ===
      JSON.stringify(EXPECTED_MANIFEST.host_permissions),
    "Built manifest host_permissions changed unexpectedly.",
  );
  assert(
    JSON.stringify(manifest.optional_host_permissions) ===
      JSON.stringify(EXPECTED_MANIFEST.optional_host_permissions),
    "Built manifest optional host permissions changed unexpectedly.",
  );
  assert(
    JSON.stringify(manifest.externally_connectable?.matches) ===
      JSON.stringify(EXPECTED_MANIFEST.externally_connectable),
    "Built manifest externally_connectable changed unexpectedly.",
  );
  assert(
    manifest.background?.service_worker === "background.js" &&
      manifest.background?.type === "module",
    "Built package has no MV3 module service worker.",
  );

  const chromePath = findChrome();
  const profileDir = await mkdtemp(join(tmpdir(), "minted-m22-chrome-"));
  let chrome;
  let devtools;
  try {
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions-except=" + DIST,
        "--load-extension=" + DIST,
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "--user-data-dir=" + profileDir,
        "--disable-dev-shm-usage",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    chrome.on("error", (error) => {
      throw new Error(`Could not launch Chrome: ${error.message}`);
    });

    const activePortFile = join(profileDir, "DevToolsActivePort");
    const activePort = await poll(
      async () => (await readFile(activePortFile, "utf8")).split("\n")[0],
      (value) => /^\d+$/.test(value ?? ""),
      "Chrome DevTools port",
    );
    const version = await globalThis
      .fetch(`http://127.0.0.1:${activePort}/json/version`)
      .then((response) => response.json());
    devtools = new DevTools(version.webSocketDebuggerUrl);
    await devtools.send("Target.setDiscoverTargets", { discover: true });

    const targets = async () =>
      (await devtools.send("Target.getTargets")).targetInfos;
    const worker = await poll(
      targets,
      (items) =>
        items.find(
          (target) =>
            target.type === "service_worker" &&
            target.url.endsWith("/background.js"),
        ),
      "built extension service worker",
    ).then((items) =>
      items.find(
        (target) =>
          target.type === "service_worker" &&
          target.url.endsWith("/background.js"),
      ),
    );
    const extensionId = new URL(worker.url).hostname;
    const workerSession = (
      await devtools.send("Target.attachToTarget", {
        targetId: worker.targetId,
        flatten: true,
      })
    ).sessionId;
    await devtools.send("Runtime.enable", {}, workerSession);

    const unhandledRejections = [];
    const runtimeExceptions = [];
    await devtools.send(
      "Runtime.addBinding",
      { name: "__m22ReportUnhandled" },
      workerSession,
    );
    devtools.on("Runtime.bindingCalled", (params, sessionId) => {
      if (sessionId === workerSession && params.name === "__m22ReportUnhandled")
        unhandledRejections.push(params.payload);
    });
    devtools.on("Runtime.exceptionThrown", (params, sessionId) => {
      if (sessionId === workerSession)
        runtimeExceptions.push(
          params.exceptionDetails?.text ?? "runtime exception",
        );
    });
    await evaluate(
      devtools,
      "globalThis.addEventListener('unhandledrejection', event => globalThis.__m22ReportUnhandled(String(event.reason)))",
      workerSession,
    );

    const pageTargetId = (
      await devtools.send("Target.createTarget", {
        url: `chrome-extension://${extensionId}/sidepanel.html`,
      })
    ).targetId;
    const pageSession = (
      await devtools.send("Target.attachToTarget", {
        targetId: pageTargetId,
        flatten: true,
      })
    ).sessionId;
    await devtools.send("Page.enable", {}, pageSession);
    await devtools.send("Runtime.enable", {}, pageSession);
    const pageReady = await poll(
      () =>
        evaluate(
          devtools,
          "JSON.stringify({url:location.href,readyState:document.readyState,title:document.title})",
          pageSession,
        ),
      (value) => {
        const page = JSON.parse(value ?? "null");
        return page?.readyState === "complete" && page.title === "Minted Panel Workbench";
      },
      "built side panel page",
    );
    assert(pageReady, "Built side panel did not load.");

    const panelEvidence = await evaluate(
      devtools,
      "JSON.stringify({title:document.title, signInHeading:document.querySelector('#view-signin h1')?.textContent, manifest:chrome.runtime.getManifest().manifest_version})",
      pageSession,
    );
    const panel = JSON.parse(panelEvidence);
    assert(
      panel.title === "Minted Panel Workbench" &&
        panel.signInHeading === "Sign in" &&
        panel.manifest === 3,
      "Built side panel UI or extension runtime did not initialize.",
    );

    let orgFetchCount = 0;
    const retrySequence = [];
    devtools.on("Fetch.requestPaused", (params, sessionId) => {
      if (sessionId !== workerSession) return;
      void (async () => {
        const url = new URL(params.request.url);
        if (params.request.method === "OPTIONS") {
          await devtools.send(
            "Fetch.fulfillRequest",
            {
              requestId: params.requestId,
              responseCode: 204,
              ...protocolResponse("", "text/plain"),
            },
            sessionId,
          );
          return;
        }
        if (url.origin === API_ORIGIN && url.pathname === "/api/me/orgs") {
          orgFetchCount += 1;
          retrySequence.push(`orgs-${orgFetchCount}`);
          if (orgFetchCount === 1) {
            await devtools.send(
              "Fetch.fulfillRequest",
              {
                requestId: params.requestId,
                responseCode: 401,
                responseHeaders: [
                  { name: "content-type", value: "application/json" },
                  { name: "access-control-allow-origin", value: "*" },
                ],
                body: Buffer.from(
                  '{"error":"synthetic expired access token"}',
                ).toString("base64"),
              },
              sessionId,
            );
          } else {
            await devtools.send(
              "Fetch.fulfillRequest",
              {
                requestId: params.requestId,
                responseCode: 200,
                ...protocolResponse(
                  JSON.stringify({
                    data: [
                      {
                        orgId: "m22-runtime-org",
                        orgName: "Synthetic Runtime Org",
                        role: "admin",
                      },
                    ],
                    meta: null,
                    error: null,
                  }),
                ),
              },
              sessionId,
            );
          }
          return;
        }
        if (
          url.origin === SUPABASE_ORIGIN &&
          url.pathname === "/auth/v1/token"
        ) {
          retrySequence.push("refresh");
          const user = {
            id: "m22-runtime-user",
            aud: "authenticated",
            role: "authenticated",
            email: "runtime@example.test",
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: {},
            created_at: new Date().toISOString(),
          };
          await devtools.send(
            "Fetch.fulfillRequest",
            {
              requestId: params.requestId,
              responseCode: 200,
              ...protocolResponse(
                JSON.stringify({
                  access_token: "synthetic-refreshed-access-token",
                  token_type: "bearer",
                  expires_in: 3600,
                  refresh_token: "synthetic-refreshed-refresh-token",
                  user,
                }),
              ),
            },
            sessionId,
          );
          return;
        }
        if (
          url.origin === SUPABASE_ORIGIN &&
          url.pathname === "/auth/v1/logout"
        ) {
          await devtools.send(
            "Fetch.fulfillRequest",
            {
              requestId: params.requestId,
              responseCode: 204,
              responseHeaders: [
                { name: "access-control-allow-origin", value: "*" },
              ],
              body: "",
            },
            sessionId,
          );
          return;
        }
        await devtools.send(
          "Fetch.fulfillRequest",
          {
            requestId: params.requestId,
            responseCode: 503,
            responseHeaders: [
              { name: "content-type", value: "application/json" },
              { name: "access-control-allow-origin", value: "*" },
            ],
            body: Buffer.from(
              '{"error":"no synthetic route configured"}',
            ).toString("base64"),
          },
          sessionId,
        );
      })().catch((error) => {
        runtimeExceptions.push(`Fetch interception: ${error.message}`);
      });
    });
    await devtools.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      workerSession,
    );

    const signedInUser = {
      id: "m22-runtime-user",
      aud: "authenticated",
      role: "authenticated",
      email: "runtime@example.test",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
    const initialSession = {
      access_token: "synthetic-expired-access-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "synthetic-refresh-token",
      user: signedInUser,
    };
    await evaluate(
      devtools,
      `chrome.storage.session.set({${JSON.stringify(AUTH_KEY)}: ${JSON.stringify(JSON.stringify(initialSession))}}).then(() => true)`,
      workerSession,
    );

    const sendMessage = async (message) => {
      const encoded = JSON.stringify(JSON.stringify(message));
      const result = await evaluate(
        devtools,
        `chrome.runtime.sendMessage(JSON.parse(${encoded})).then(result => JSON.stringify(result))`,
        pageSession,
      );
      return JSON.parse(result);
    };

    const orgResult = await sendMessage({ type: "LIST_MY_ORGS" });
    assert(
      orgResult.ok === true && orgResult.data?.[0]?.orgId === "m22-runtime-org",
      "Built worker did not return the synthetic org list after refresh.",
    );
    assert(
      orgFetchCount === 2 &&
        retrySequence.join(",") === "orgs-1,refresh,orgs-2",
      `Expected one 401 refresh retry; got ${retrySequence.join(",")}.`,
    );

    await evaluate(
      devtools,
      `chrome.storage.session.set({${JSON.stringify(ACTIVE_ORG_KEY)}:'org-a', ${JSON.stringify(SELECTED_PROVIDER_KEY)}:'provider-a', ${JSON.stringify(OWNER_KEY)}:'m22-runtime-user', ${JSON.stringify(ACTIVE_CASE_KEY)}:${JSON.stringify(activeCaseRecord(-1))}}).then(() => true)`,
      workerSession,
    );
    const switchResult = await sendMessage({
      type: "SET_ACTIVE_ORG",
      orgId: "org-b",
    });
    const afterSwitch = JSON.parse(
      await evaluate(
        devtools,
        `chrome.storage.session.get(null).then(s => JSON.stringify({activeOrg:s[${JSON.stringify(ACTIVE_ORG_KEY)}], provider:s[${JSON.stringify(SELECTED_PROVIDER_KEY)}], activeCase:s[${JSON.stringify(ACTIVE_CASE_KEY)}]}))`,
        workerSession,
      ),
    );
    assert(
      switchResult.ok === true &&
        afterSwitch.activeOrg === "org-b" &&
        afterSwitch.provider == null &&
        afterSwitch.activeCase == null,
      "Org switch did not clear prior org-scoped case/provider state.",
    );

    await evaluate(
      devtools,
      `chrome.storage.session.set({${JSON.stringify(ACTIVE_ORG_KEY)}:'org-b', ${JSON.stringify(SELECTED_PROVIDER_KEY)}:'provider-b', ${JSON.stringify(OWNER_KEY)}:'m22-runtime-user', ${JSON.stringify(ACTIVE_CASE_KEY)}:${JSON.stringify(activeCaseRecord(-2))}}).then(() => true)`,
      workerSession,
    );
    const logoutResult = await sendMessage({ type: "SIGN_OUT" });
    const afterLogout = JSON.parse(
      await evaluate(
        devtools,
        `chrome.storage.session.get(null).then(s => JSON.stringify({auth:s[${JSON.stringify(AUTH_KEY)}], activeOrg:s[${JSON.stringify(ACTIVE_ORG_KEY)}], provider:s[${JSON.stringify(SELECTED_PROVIDER_KEY)}], owner:s[${JSON.stringify(OWNER_KEY)}], activeCase:s[${JSON.stringify(ACTIVE_CASE_KEY)}]}))`,
        workerSession,
      ),
    );
    assert(
      logoutResult.ok === true &&
        afterLogout.auth == null &&
        afterLogout.activeOrg == null &&
        afterLogout.provider == null &&
        afterLogout.owner == null &&
        afterLogout.activeCase == null,
      "Logout did not clear synthetic auth and workbench state.",
    );

    const tabs = JSON.parse(
      await evaluate(
        devtools,
        "Promise.all([chrome.tabs.create({url:'about:blank', active:false}), chrome.tabs.create({url:'about:blank', active:false})]).then(t => JSON.stringify(t.map(x => x.id)))",
        workerSession,
      ),
    );
    const [boundTabId, otherTabId] = tabs;
    await evaluate(
      devtools,
      `chrome.storage.session.set({${JSON.stringify(ACTIVE_CASE_KEY)}:${JSON.stringify(activeCaseRecord(boundTabId))}}).then(() => true)`,
      workerSession,
    );
    await evaluate(
      devtools,
      `globalThis.__m22RejectedWrites=0; globalThis.__m22OriginalStorageSet=chrome.storage.session.set.bind(chrome.storage.session); Object.defineProperty(chrome.storage.session,'set',{configurable:true,writable:true,value:async items=>{if(Object.hasOwn(items,${JSON.stringify(ACTIVE_CASE_KEY)})){globalThis.__m22RejectedWrites+=1;throw new Error('synthetic tab-listener storage failure')}return globalThis.__m22OriginalStorageSet(items)}}); true`,
      workerSession,
    );
    await evaluate(
      devtools,
      `chrome.tabs.update(${otherTabId}, {active:true}).then(() => true)`,
      workerSession,
    );
    await evaluate(
      devtools,
      `chrome.tabs.update(${boundTabId}, {active:true}).then(() => true)`,
      workerSession,
    );
    await poll(
      () => evaluate(devtools, "globalThis.__m22RejectedWrites", workerSession),
      (count) => count >= 1,
      "tab activation listener rejection",
    );
    await evaluate(
      devtools,
      `chrome.tabs.update(${boundTabId}, {url:'https://mintedpanel.com/m22-runtime', active:true}).then(() => true)`,
      workerSession,
    );
    await poll(
      () => evaluate(devtools, "globalThis.__m22RejectedWrites", workerSession),
      (count) => count >= 2,
      "tab update listener rejection",
    );
    await evaluate(
      devtools,
      `chrome.tabs.remove(${boundTabId}).then(() => true)`,
      workerSession,
    );
    await poll(
      () => evaluate(devtools, "globalThis.__m22RejectedWrites", workerSession),
      (count) => count >= 3,
      "tab removal listener rejection",
    );
    await delay(250);
    const rejectedWrites = await evaluate(
      devtools,
      "globalThis.__m22RejectedWrites",
      workerSession,
    );
    await evaluate(
      devtools,
      "Object.defineProperty(chrome.storage.session,'set',{configurable:true,writable:true,value:globalThis.__m22OriginalStorageSet}); delete globalThis.__m22OriginalStorageSet; true",
      workerSession,
    );
    await evaluate(
      devtools,
      `chrome.tabs.remove(${otherTabId}).catch(() => undefined)`,
      workerSession,
    );
    assert(
      rejectedWrites === 3,
      `Expected update/activation/removal storage failures, observed ${rejectedWrites}.`,
    );
    assert(
      unhandledRejections.length === 0,
      `Built worker emitted unhandled promise rejections: ${unhandledRejections.join("; ")}`,
    );
    assert(
      runtimeExceptions.length === 0,
      `Built worker raised runtime exceptions: ${runtimeExceptions.join("; ")}`,
    );

    console.log(
      JSON.stringify(
        {
          result: "passed",
          node: process.version,
          chrome: version.Browser,
          extensionId,
          manifest: {
            permissions: manifest.permissions,
            host_permissions: manifest.host_permissions,
            optional_host_permissions: manifest.optional_host_permissions,
            externally_connectable: manifest.externally_connectable.matches,
          },
          sidePanelLoaded: true,
          organizationSwitchClearedPriorState: true,
          logoutClearedAuthAndWorkbench: true,
          retrySequence,
          tabListenerRejectedWrites: rejectedWrites,
          unhandledRejections: unhandledRejections.length,
          runtimeExceptions: runtimeExceptions.length,
          network:
            "synthetic-only; DNS blocked and worker requests fulfilled by CDP",
        },
        null,
        2,
      ),
    );
  } finally {
    devtools?.close();
    await stopChrome(chrome);
    await rm(profileDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

await main();
