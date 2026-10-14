import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

// Session and arrival states from the 0.1.8 state boards (A3, A4, A5, A7,
// B1, B2, B6, B9 to B12, the site access ask). Runs the unchanged main.ts
// functions against a controlled DOM and state, and pins the approved copy.
const MAIN = readFileSync("src/sidepanel/main.ts", "utf8");
const HTML = readFileSync("sidepanel.html", "utf8");
const tree = ts.createSourceFile("main.ts", MAIN, ts.ScriptTarget.Latest, true);
function code(names: string[]) {
  const selected = tree.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
  ).map((node) => node.getText(tree)).join("\n");
  return ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
const doc = new JSDOM(HTML).window.document;
const text = (id: string) => doc.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim();

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const provider = { id: PROVIDER_ID, firstName: "Jane", lastName: "Doe" };

describe("approved copy in the markup", () => {
  it("A3 and A4 in the sign-in view", () => {
    expect(text("signin-handoff-hint")).toBe("Sign in to open the case you sent from Minted Panel.");
    expect(text("signin-expired-hint")).toBe("Your sign-in expired. Sign in again. The case stays linked.");
    const signin = doc.getElementById("view-signin")!;
    expect(signin.contains(doc.getElementById("signin-expired-hint"))).toBe(true);
    expect(doc.getElementById("signin-expired-hint")!.hasAttribute("hidden")).toBe(true);
  });

  it("B6 and the registry-level site access ask", () => {
    expect(text("portal-registry-empty")).toBe("No payer forms are set up yet. Ask an admin.");
    expect(text("portal-access-text")).toBe(
      "On a payer form? Allow Minted on your organization's payer sites so it can fill them.",
    );
    expect(text("portal-access-grant")).toBe("Allow Minted on payer sites");
  });

  it("placeholders and notices in main.ts", () => {
    expect(MAIN).toContain('"Pick the organization you\'re working in"');
    expect(MAIN).toContain('new Option("Pick the group for this case", "")');
    expect(MAIN.match(/"Pick a location",/g)).toHaveLength(2);
    expect(MAIN).toContain('new Option("Pick a case", "", true, rememberedId == null)');
    // The ad hoc option and its value are unchanged.
    expect(MAIN).toContain('new Option("No case · Ad hoc fill", AD_HOC_CASE_SELECTION,');
    expect(MAIN).toContain(
      '"This case is in an organization your account isn\'t part of. Sign in with the right account, or search."',
    );
    for (const retired of ["Select an organization…", "Select a group…", "Select a location…", "Select a case or ad hoc fill…"]) {
      expect(MAIN).not.toContain(retired);
    }
  });
});

describe("sign-in view hints (A3, A4)", () => {
  function signinHarness(caseState: unknown, workState: unknown) {
    const dom = new JSDOM('<p id="handoff"></p><p id="expired"></p>');
    const handoff = dom.window.document.querySelector<HTMLElement>("#handoff")!;
    const expired = dom.window.document.querySelector<HTMLElement>("#expired")!;
    const sendToBackground = vi.fn(async (request: { type: string }) =>
      request.type === "GET_ACTIVE_CASE"
        ? { ok: true, data: caseState }
        : { ok: true, data: workState });
    const scope: Context = createContext({
      signinForm: { reset: vi.fn() }, setError: vi.fn(), signinError: {},
      showView: vi.fn(), identityGuard: {}, emailInput: { focus: vi.fn() },
      signinHandoffHint: handoff, signinExpiredHint: expired, sendToBackground,
    });
    runInContext(code(["showSignin"]), scope);
    return { scope, handoff, expired, sendToBackground };
  }
  const handoffCase = { status: "active", record: { source: "handoff", caseId: CASE_ID } };
  const pickedCase = { status: "active", record: { source: "panel", caseId: CASE_ID } };
  const liveWork = { status: "active", record: {} };

  it("A3: a handoff waiting while signed out", async () => {
    const h = signinHarness(handoffCase, { status: "none" });
    runInContext("showSignin()", h.scope);
    await vi.waitFor(() => expect(h.handoff.hidden).toBe(false));
    expect(h.expired.hidden).toBe(true);
    expect(h.sendToBackground).not.toHaveBeenCalledWith({ type: "GET_ACTIVE_WORK" });
  });

  it.each([
    ["a picked case", pickedCase, { status: "none" }],
    ["a launched case", handoffCase, { status: "none" }],
    ["a Work launch", { status: "none" }, liveWork],
  ])("A4: the session expired with %s linked", async (_label, caseState, workState) => {
    const h = signinHarness(caseState, workState);
    runInContext("showSignin(true)", h.scope);
    await vi.waitFor(() => expect(h.expired.hidden).toBe(false));
    expect(h.handoff.hidden).toBe(true);
  });

  it("an expired session with nothing linked is the plain sign-in view", async () => {
    const h = signinHarness({ status: "none" }, { status: "none" });
    runInContext("showSignin(true)", h.scope);
    await vi.waitFor(() => expect(h.sendToBackground).toHaveBeenCalledTimes(2));
    // Let the hint check settle (a macrotask outlasts its microtasks).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.expired.hidden).toBe(true);
    expect(h.handoff.hidden).toBe(true);
  });
});

describe("a dead session falls back to sign-in (A4)", () => {
  it("routes only a 401 to the expiry handler and passes every response through", async () => {
    const responses = [
      { ok: false, error: "Session expired - please sign in again.", code: 401 },
      { ok: false, error: "Forbidden", code: 403 },
      { ok: false, error: "Could not reach Minted Panel - check your connection." },
      { ok: true, data: null },
    ];
    const handleSessionExpired = vi.fn();
    const sendToWorker = vi.fn(async () => responses.shift());
    const scope = createContext({ sendToWorker, handleSessionExpired });
    runInContext(code(["sendToBackground"]), scope);

    expect(await runInContext('sendToBackground({ type: "LIST_MY_ORGS" })', scope)).toMatchObject({ code: 401 });
    expect(handleSessionExpired).toHaveBeenCalledOnce();
    await runInContext('sendToBackground({ type: "LIST_MY_ORGS" })', scope);
    await runInContext('sendToBackground({ type: "LIST_MY_ORGS" })', scope);
    expect(await runInContext('sendToBackground({ type: "LIST_MY_ORGS" })', scope)).toEqual({ ok: true, data: null });
    expect(handleSessionExpired).toHaveBeenCalledOnce();
  });

  it.each([
    [false, 1],
    [true, 0],
  ])("clears the panel and shows sign-in once (main view hidden: %s)", (mainHidden, calls) => {
    const bumpGeneration = vi.fn();
    const resetPanelSession = vi.fn();
    const showSignin = vi.fn();
    const scope = createContext({
      views: { main: { hidden: mainHidden } }, bumpGeneration, resetPanelSession, showSignin,
    });
    runInContext(code(["handleSessionExpired"]), scope);
    runInContext("handleSessionExpired()", scope);
    expect(bumpGeneration).toHaveBeenCalledTimes(calls);
    expect(resetPanelSession).toHaveBeenCalledTimes(calls);
    expect(showSignin).toHaveBeenCalledTimes(calls);
    if (calls) expect(showSignin).toHaveBeenCalledWith(true);
  });

  it("sign-out and expiry share one in-memory reset", () => {
    const signOut = MAIN.slice(MAIN.indexOf('signoutBtn.addEventListener("click"'), MAIN.indexOf("function resetPanelSession("));
    expect(signOut).toContain("resetPanelSession();");
    expect(signOut).toContain('type: "SIGN_OUT"');
  });
});

describe("opening a launch (B1)", () => {
  function openingScope(state: Record<string, unknown>) {
    const scope: Context = createContext({
      applyingHandoffKey: null, workLaunchesOpening: 0, activeWorkState: { status: "none" },
      activeCase: null, providers: [provider], cases: [], updateFillReady: vi.fn(),
      ...state,
    });
    runInContext(code(["caseOpening", "openingLine", "whileWorkOpens"]), scope);
    return scope;
  }

  it("names nothing it doesn't already hold", () => {
    const scope = openingScope({ applyingHandoffKey: "receipt", activeCase: { providerId: PROVIDER_ID, caseId: CASE_ID } });
    expect(runInContext("caseOpening()", scope)).toBe(true);
    expect(runInContext("openingLine()", scope)).toBe("Opening the case from Minted Panel…");
  });

  it("names the provider, payer and state once the panel holds them", () => {
    const scope = openingScope({
      applyingHandoffKey: "receipt", activeCase: { providerId: PROVIDER_ID, caseId: CASE_ID },
      cases: [{ id: CASE_ID, payerName: "Aetna", state: "NC" }],
    });
    expect(runInContext("openingLine()", scope)).toBe("Opening Jane Doe, Aetna NC…");
  });

  it("uses the Work launch's own provider and case", () => {
    const scope = openingScope({
      workLaunchesOpening: 1,
      activeWorkState: { status: "active", record: { tuple: { ownerKind: "case", ownerId: CASE_ID, providerId: PROVIDER_ID } } },
      cases: [{ id: CASE_ID, payerName: "Aetna", state: "NC" }],
    });
    expect(runInContext("openingLine()", scope)).toBe("Opening Jane Doe, Aetna NC…");
  });

  it("counts a live Work launch as opening only while it loads, even when the load fails", async () => {
    const scope = openingScope({
      activeWorkState: { status: "active", record: { tuple: { ownerKind: "case" } } },
    });
    let during = false;
    await runInContext("whileWorkOpens", scope)(async () => {
      during = runInContext("caseOpening()", scope);
    });
    expect(during).toBe(true);
    expect(runInContext("caseOpening()", scope)).toBe(false);
    await expect(runInContext("whileWorkOpens", scope)(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(runInContext("workLaunchesOpening", scope)).toBe(0);
  });

  it("does not call a blocked or ended link opening", async () => {
    const scope = openingScope({ activeWorkState: { status: "blocked", orgId: null } });
    let during = true;
    await runInContext("whileWorkOpens", scope)(async () => {
      during = runInContext("caseOpening()", scope);
    });
    expect(during).toBe(false);
  });

  it("keeps the queue away while opening", () => {
    const queueSection = { hidden: false };
    const loadQueue = vi.fn();
    const scope = createContext({
      queueSection, loadQueue, loadGeneration: 1, orgResolved: () => true,
      selectedProviderId: () => null, selectedCaseId: () => null, caseOpening: () => true,
    });
    runInContext(code(["syncQueueVisibility"]), scope);
    runInContext("syncQueueVisibility()", scope);
    expect(queueSection.hidden).toBe(true);
    expect(loadQueue).not.toHaveBeenCalled();
  });

  it("puts the line in the status element above the case block", () => {
    const update = MAIN.slice(MAIN.indexOf("function updateFillReady("), MAIN.indexOf("// The coverage sensor reflects"));
    expect(update).toMatch(/if \(caseOpening\(\)\) \{\s*portalStatus\.textContent = openingLine\(\);/);
  });
});

describe("the queue (B2)", () => {
  function queueScope(response: unknown) {
    const dom = new JSDOM('<div id="queue" hidden></div>');
    const queueSection = dom.window.document.querySelector<HTMLElement>("#queue")!;
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const scope = createContext({
      document: dom.window.document, queueSection, orgResolved: () => true,
      isCurrent: () => true, renderQueue: vi.fn(),
      sendToBackground: vi.fn(() => pending),
    });
    runInContext(code(["loadQueue", "searchEmptyLine"]), scope);
    return { scope, queueSection, finish: () => finish(response) };
  }

  it("says it is loading, then says plainly when it can't", async () => {
    const q = queueScope({ ok: false, error: "500 Internal Server Error", code: 500 });
    const load = runInContext("loadQueue(1)", q.scope);
    expect(q.queueSection.textContent).toBe("Loading your list…");
    q.finish();
    await load;
    expect(q.queueSection.textContent).toBe("Can't load your list right now. Use Search.");
  });
});

describe("no open cases (B11)", () => {
  function noteScope(state: Record<string, unknown>) {
    const dom = new JSDOM('<p id="note" hidden></p>');
    const caseNote = dom.window.document.querySelector<HTMLElement>("#note")!;
    const scope = createContext({
      document: dom.window.document, caseNote, providers: [provider], cases: [],
      casesLoadedFor: PROVIDER_ID, selectedProviderId: () => PROVIDER_ID, selectedCaseId: () => null,
      ...state,
    });
    runInContext(code(["renderCaseNote"]), scope);
    runInContext("renderCaseNote()", scope);
    return caseNote;
  }

  it("names the provider when the loaded list is empty", () => {
    const note = noteScope({});
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Jane Doe has no open cases. Search for another, or open Minted Panel.");
  });

  it("says nothing while the list loads or after a failed read", () => {
    expect(noteScope({ casesLoadedFor: null }).hidden).toBe(true);
  });

  it("keeps the latest note when there are cases", () => {
    const note = noteScope({
      cases: [{ id: CASE_ID, latestNote: { text: "Called payer", author: null } }],
      selectedCaseId: () => CASE_ID,
    });
    expect(note.textContent).toContain("Called payer");
    expect(note.textContent).not.toContain("no open cases");
  });
});

describe("the registry-level site access ask", () => {
  it.each([
    ["case", "On a payer form? Allow Minted on your organization's payer sites so it can fill them.", "Allow Minted on payer sites"],
    ["train", "On a payer portal? Give Minted access to this organization's portal sites so it can capture and fill their forms.", "Enable form capture & fill"],
  ])("uses the %s job's words", async (mode, copy, button) => {
    const portalAccess = { hidden: true };
    const portalAccessText = { textContent: "" };
    const portalAccessGrant = { textContent: "" };
    const rows = [{ formUrl: "https://payer.test/enroll" }];
    const scope = createContext({
      portalAccess, portalAccessText, portalAccessGrant,
      workPortalAccess: { hidden: true }, workPortalAccessCandidate: null, portalAccessPromptRevision: 0,
      panelMode: mode, activeWorkState: { status: "none" }, portal: null,
      portalRows: rows, sharedPortalRows: rows,
      portalOriginPatterns: () => ["https://payer.test/*"],
      hasOriginPermissions: async () => false,
      CASE_ACCESS_TEXT: "On a payer form? Allow Minted on your organization's payer sites so it can fill them.",
      CASE_ACCESS_BUTTON: "Allow Minted on payer sites",
      TRAIN_ACCESS_TEXT: "On a payer portal? Give Minted access to this organization's portal sites so it can capture and fill their forms.",
      TRAIN_ACCESS_BUTTON: "Enable form capture & fill",
    });
    runInContext(code(["updatePortalAccessPrompt"]), scope);
    await runInContext("updatePortalAccessPrompt()", scope);
    expect(portalAccess.hidden).toBe(false);
    expect(portalAccessText.textContent).toBe(copy);
    expect(portalAccessGrant.textContent).toBe(button);
    // The stubs above mirror the constants main.ts really declares.
    expect(MAIN).toContain(JSON.stringify(copy));
    expect(MAIN).toContain(JSON.stringify(button));
  });
});
