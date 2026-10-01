import { describe, expect, it } from "vitest";
import type { PortalFieldMap, PortalRegistryRow } from "./apiTypes";
import {
  assignSortOrder,
  candidatePortalKey,
  candidatePortalName,
  captureKeyAgreesWithTabUrl,
  capturePortalKeyForUrl,
  captureStateSummary,
  decideCaptureStart,
  derivePageStep,
  formCaptureState,
  recognizeForm,
  resolveTrainRecognition,
  sequencePageName,
  TRAIN_MISMATCH_HINT,
  trainMismatchRecognitionText,
} from "./trainForms";

function portal(over: Partial<PortalRegistryRow> = {}): PortalRegistryRow {
  return {
    id: "p1",
    orgId: null,
    portalKey: "national_join",
    name: "National Health Plan join",
    payerId: "payer-1",
    payerName: "National Health Plan",
    caseType: null,
    mappingGeneration: null,
    formUrl: "https://payer.example/enroll/start",
    isVerified: false,
    lastVerifiedAt: null,
    provenAt: null,
    urlChangedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function map(over: Partial<PortalFieldMap> = {}): PortalFieldMap {
  return {
    id: "m1",
    orgId: null,
    portalKey: "national_join",
    urlPattern: null,
    pageStep: "Practice details",
    mapType: "web",
    selector: "#npi",
    selectorFallbacks: null,
    source: "token",
    token: "provider.npi",
    hardcodedValue: null,
    transform: null,
    fieldType: "text",
    notes: null,
    status: "approved",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("derivePageStep", () => {
  it("prefers the heading — it is what the trainer will recognise later", () => {
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/step2",
        heading: "  Practice   details ",
        sequence: 2,
        used: [],
      }),
    ).toBe("Practice details");
  });

  it("falls back to the URL tail when there is no heading", () => {
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/credentials?session=abc#top",
        heading: null,
        sequence: 3,
        used: [],
      }),
    ).toBe("credentials");
  });

  it("falls back to the capture sequence when neither signal distinguishes", () => {
    // A single-URL wizard with no heading: the trainer walked to page 4, and
    // capture must name it rather than block or prompt.
    expect(derivePageStep({ url: "https://payer.example/enroll", heading: null, sequence: 4, used: ["enroll"] })).toBe(
      "Page 4",
    );
  });

  it("does not reuse a name already taken in this run", () => {
    // Two pages that look identical must not merge into one bucket — that
    // would silently pool their fields under one page in the editor.
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/step",
        heading: "Practice details",
        sequence: 2,
        used: ["Practice details"],
      }),
    ).toBe("step");
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/step",
        heading: "Practice details",
        sequence: 2,
        used: ["Practice details", "step"],
      }),
    ).toBe("Page 2");
  });

  it("skips past a taken sequence name rather than colliding", () => {
    expect(
      derivePageStep({ url: null, heading: null, sequence: 2, used: ["Page 2", "Page 3"] }),
    ).toBe("Page 4");
  });

  it("tolerates a malformed URL", () => {
    expect(derivePageStep({ url: "not a url", heading: null, sequence: 1, used: [] })).toBe(
      sequencePageName(1),
    );
  });
});

describe("assignSortOrder", () => {
  it("numbers rows 1..n in the order the scan produced them", () => {
    // The scan yields document order, so position IS the form's reading order.
    expect(assignSortOrder([{ selector: "#a" }, { selector: "#b" }])).toEqual([
      { selector: "#a", sortOrder: 1 },
      { selector: "#b", sortOrder: 2 },
    ]);
  });

  it("is empty-safe", () => {
    expect(assignSortOrder([])).toEqual([]);
  });
});

describe("recognizeForm", () => {
  const rows = [portal()];

  it("recognizes a page under a registered form's URL", () => {
    const result = recognizeForm("https://payer.example/enroll/start?x=1", rows, "National Health Plan");
    expect(result.kind).toBe("existing");
    if (result.kind === "existing") expect(result.portal.key).toBe("national_join");
  });

  it("reports same-URL configurations as ambiguous rather than choosing by row order", () => {
    const rows = [
      portal({ portalKey: "contract", name: "Aetna Contract", caseType: "contract" }),
      portal({ id: "p2", portalKey: "enrollment", name: "Aetna Enrollment", caseType: "enrollment" }),
    ];
    const result = recognizeForm("https://payer.example/enroll/start", rows, "National Health Plan");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.key)).toEqual(["contract", "enrollment"]);
    }
    expect(recognizeForm("https://payer.example/enroll/start", [...rows].reverse(), "National Health Plan")).toEqual(result);
  });

  it("keeps overlapping URL prefixes ambiguous even when one is more specific", () => {
    const broad = portal({ portalKey: "aetna_contract", formUrl: "https://payer.example/enroll" });
    const narrow = portal({
      id: "p2",
      portalKey: "aetna_enrollment",
      formUrl: "https://payer.example/enroll/provider",
    });
    const url = "https://payer.example/enroll/provider/start";
    const result = recognizeForm(url, [broad, narrow], "National Health Plan");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      // Specificity is display ordering only; it does not discard the broad
      // configuration whose URL rule also permits this page.
      expect(result.candidates.map((candidate) => candidate.key)).toEqual([
        "aetna_enrollment",
        "aetna_contract",
      ]);
    }
    expect(recognizeForm(url, [narrow, broad], "National Health Plan")).toEqual(result);
  });

  it("greets an unmatched page as new, with a candidate name", () => {
    const result = recognizeForm("https://other.example/apply", rows, "Example Insurance Co.");
    expect(result).toEqual({ kind: "new", candidateName: "Example Insurance Co. form" });
  });

  it("numbers the candidate when the payer already has a form", () => {
    // A payer legitimately has several forms (D15) and URL/heading often
    // cannot tell a new one from an existing row — so number it and let the
    // admin rename, never block and never overwrite.
    expect(candidatePortalName("National Health Plan", rows)).toBe("National Health Plan form 2");
    expect(candidatePortalName("National Health Plan", [portal(), portal({ id: "p2", portalKey: "national_join_2" })])).toBe(
      "National Health Plan form 3",
    );
  });

  it("still names a candidate when the payer is unknown", () => {
    expect(candidatePortalName(null, [])).toBe("Payer form");
    expect(candidatePortalName("   ", [])).toBe("Payer form");
  });

  it("derives a key in the shape the server folds to", () => {
    expect(candidatePortalKey("National Health Plan form 2")).toBe("national_health_plan_form_2");
    expect(candidatePortalKey("Regional (KS) — Enrollment")).toBe("regional_ks_enrollment");
  });

  it("treats a missing URL as unrecognized rather than guessing", () => {
    expect(recognizeForm(null, rows, "National Health Plan").kind).toBe("new");
  });
});

describe("formCaptureState", () => {
  it("counts pages, captured fields and genuinely mapped ones", () => {
    const state = formCaptureState([
      map(),
      map({ id: "m2", selector: "#tin", pageStep: "Tax ID", source: "hardcoded", token: null, hardcodedValue: "Group" }),
      map({ id: "m3", selector: "#sig", pageStep: "Tax ID", status: "proposed", source: "manual", token: null }),
    ]);
    expect(state).toEqual({ pagesSeen: 2, fieldsCaptured: 3, mapped: 2, undecided: 1 });
  });

  it("does not count an approved row that would fill nothing", () => {
    // An approved token row with no token, or a fixed row with no value,
    // reports a form as trained while filling nothing — the exact failure the
    // epic exists to remove.
    const state = formCaptureState([
      map({ id: "a", token: null }),
      map({ id: "b", selector: "#x", source: "hardcoded", token: null, hardcodedValue: "  " }),
    ]);
    expect(state.mapped).toBe(0);
    expect(state.fieldsCaptured).toBe(2);
  });

  it("counts a human-fill decision as decided but not mapped", () => {
    const state = formCaptureState([map({ source: "manual", token: null })]);
    expect(state).toMatchObject({ mapped: 0, undecided: 0, fieldsCaptured: 1 });
  });

  it("ignores retired rows entirely", () => {
    expect(formCaptureState([map({ status: "retired" })])).toEqual({
      pagesSeen: 0,
      fieldsCaptured: 0,
      mapped: 0,
      undecided: 0,
    });
  });

  it("summarizes honestly when no page was ever recorded", () => {
    const state = formCaptureState([map({ pageStep: null })]);
    expect(captureStateSummary(state)).toBe("no pages recorded · 1 captured · 1 mapped");
  });

  it("summarizes a multi-page form", () => {
    expect(captureStateSummary({ pagesSeen: 5, fieldsCaptured: 23, mapped: 4, undecided: 19 })).toBe(
      "5 pages seen · 23 captured · 4 mapped",
    );
  });
});

describe("resolveTrainRecognition — TRAIN-DUAL D-TD.1 C amended + D-TD.3 C1", () => {
  const rows = [portal()];

  it("binds capture to the URL-matched portal", () => {
    const view = resolveTrainRecognition({
      url: "https://payer.example/enroll/start?x=1",
      rows,
      payerName: "National Health Plan",
      selectedPortalKey: "",
    });
    expect(view.status).toBe("matched");
    if (view.status === "matched") expect(view.portal.key).toBe("national_join");
  });

  it("keeps sticky selection messaging on mismatch — never claims a new form", () => {
    const view = resolveTrainRecognition({
      url: "https://login.example/sso",
      rows,
      payerName: "National Health Plan",
      selectedPortalKey: "national_join",
    });
    expect(view).toMatchObject({
      status: "mismatch",
      portal: null,
      selectedName: "National Health Plan join · Unclassified · national_join",
    });
    if (view.status !== "mismatch") throw new Error("expected mismatch");
    expect(view.recognitionText).toBe(trainMismatchRecognitionText(view.selectedName));
    expect(view.recognitionText).not.toMatch(/New form/i);
    expect(view.recognitionText).not.toMatch(/form 2/i);
    expect(view.hintText).toBe(TRAIN_MISMATCH_HINT);
  });

  it("only greets a page as new when no form is selected", () => {
    const view = resolveTrainRecognition({
      url: "https://other.example/apply",
      rows,
      payerName: "National Health Plan",
      selectedPortalKey: "",
    });
    expect(view.status).toBe("new");
    if (view.status === "new") {
      expect(view.candidateName).toBe("National Health Plan form 2");
      expect(view.recognitionText).toContain("New form");
      expect(view.portal).toBeNull();
    }
  });

  it("requires a choice for same-URL candidates and allows the exact selection in any order", () => {
    const contract = portal({ portalKey: "aetna_contract", name: "Aetna Contract", caseType: "contract" });
    const enrollment = portal({
      id: "p2",
      portalKey: "aetna_enrollment",
      name: "Aetna Enrollment",
      caseType: "enrollment",
      mappingGeneration: 4,
    });
    const url = "https://payer.example/enroll/start";
    const ambiguous = resolveTrainRecognition({ url, rows: [contract, enrollment], payerName: null, selectedPortalKey: "" });
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") expect(ambiguous.candidates).toHaveLength(2);

    const selected = resolveTrainRecognition({ url, rows: [enrollment, contract], payerName: null, selectedPortalKey: "aetna_contract" });
    expect(selected).toMatchObject({ status: "matched", selected: true, portal: { key: "aetna_contract", caseType: "contract", mappingGeneration: 1 } });

    const invalid = resolveTrainRecognition({
      url: "https://payer.example/enrollment/start",
      rows: [contract, enrollment],
      payerName: null,
      selectedPortalKey: "aetna_contract",
    });
    expect(invalid.status).toBe("mismatch");
  });

  it("requires an exact choice for overlapping paths but accepts either eligible key", () => {
    const broad = portal({
      portalKey: "aetna_contract",
      name: "Aetna Contract",
      caseType: "contract",
      formUrl: "https://payer.example/enroll",
    });
    const narrow = portal({
      id: "p2",
      portalKey: "aetna_enrollment",
      name: "Aetna Enrollment",
      caseType: "enrollment",
      formUrl: "https://payer.example/enroll/provider",
    });
    const url = "https://payer.example/enroll/provider/start";
    const ambiguous = resolveTrainRecognition({
      url,
      rows: [broad, narrow],
      payerName: null,
      selectedPortalKey: "",
    });
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.candidates.map((candidate) => candidate.key)).toEqual([
        "aetna_enrollment",
        "aetna_contract",
      ]);
    }

    const selectedBroad = resolveTrainRecognition({
      url,
      rows: [narrow, broad],
      payerName: null,
      selectedPortalKey: "aetna_contract",
    });
    expect(selectedBroad).toMatchObject({
      status: "matched",
      selected: true,
      portal: { key: "aetna_contract", caseType: "contract" },
    });
    const selectedNarrow = resolveTrainRecognition({
      url,
      rows: [broad, narrow],
      payerName: null,
      selectedPortalKey: "aetna_enrollment",
    });
    expect(selectedNarrow).toMatchObject({
      status: "matched",
      selected: true,
      portal: { key: "aetna_enrollment", caseType: "enrollment" },
    });
  });

  it("limits unselected URL candidates to the selected payer", () => {
    const national = portal({ portalKey: "national_join", payerName: "National Health Plan" });
    const aetna = portal({
      id: "p2",
      portalKey: "aetna_join",
      payerName: "Aetna",
      caseType: "enrollment",
    });
    const view = resolveTrainRecognition({
      url: "https://payer.example/enroll/start",
      rows: [aetna, national],
      payerName: "Aetna",
      selectedPortalKey: "",
    });
    expect(view).toMatchObject({ status: "matched", portal: { key: "aetna_join" } });
  });

  it("asks for a tab when there is no URL", () => {
    const view = resolveTrainRecognition({
      url: null,
      rows,
      payerName: "National Health Plan",
      selectedPortalKey: "national_join",
    });
    expect(view.status).toBe("no-tab");
    if (view.status === "no-tab") expect(view.portal).toBeNull();
  });
});

describe("captureKeyAgreesWithTabUrl — shared-library invariant", () => {
  const rows = [portal()];

  it("allows capture only under the URL-matched key", () => {
    const url = "https://payer.example/enroll/start";
    expect(capturePortalKeyForUrl(url, rows)).toBe("national_join");
    expect(captureKeyAgreesWithTabUrl("national_join", url, rows)).toBe(true);
  });

  it("rejects a dropdown key that disagrees with the active tab", () => {
    // Login wall / redirect: selection may still say national_join, but the tab
    // does not match — capture must not send that key.
    expect(captureKeyAgreesWithTabUrl("national_join", "https://login.example/sso", rows)).toBe(
      false,
    );
    expect(capturePortalKeyForUrl("https://login.example/sso", rows)).toBeNull();
  });

  it("rejects a wrong key even when some other portal matches the URL", () => {
    const two = [
      portal(),
      portal({
        id: "p2",
        portalKey: "national_other",
        name: "National Health Plan other",
        formUrl: "https://other.example/apply",
      }),
    ];
    expect(
      captureKeyAgreesWithTabUrl("national_other", "https://payer.example/enroll/start", two),
    ).toBe(false);
  });

  it("requires explicit selection when URL prefixes overlap, while allowing either selected key", () => {
    const two = [
      portal({ portalKey: "host", formUrl: "https://payer.example/" }),
      portal({ id: "p2", portalKey: "specific", formUrl: "https://payer.example/enroll" }),
    ];
    expect(captureKeyAgreesWithTabUrl("host", "https://payer.example/enroll/start", two)).toBe(true);
    expect(captureKeyAgreesWithTabUrl("specific", "https://payer.example/enroll/start", two)).toBe(true);
    expect(capturePortalKeyForUrl("https://payer.example/enroll/start", two)).toBeNull();
  });
});

describe("decideCaptureStart — click-time START_CAPTURE gate", () => {
  const rows = [portal()];

  it("allows START_CAPTURE only when the fresh tab id+url agree with the key", () => {
    expect(
      decideCaptureStart({
        portalKey: "national_join",
        tabId: 42,
        tabUrl: "https://payer.example/enroll/start",
        rows,
      }),
    ).toEqual({ ok: true, tabId: 42, portalKey: "national_join", mappingGeneration: 1 });
  });

  it("rejects a mismatched tab without authorizing START_CAPTURE", () => {
    // Stale portal pointer + login wall / switched tab: must not call
    // START_CAPTURE (shared-library poison / wrong content-script target).
    expect(
      decideCaptureStart({
        portalKey: "national_join",
        tabId: 99,
        tabUrl: "https://login.example/sso",
        rows,
      }),
    ).toEqual({ ok: false, reason: "key-mismatch" });
  });

  it("rejects a missing active tab id even if the key would match a URL", () => {
    expect(
      decideCaptureStart({
        portalKey: "national_join",
        tabId: null,
        tabUrl: "https://payer.example/enroll/start",
        rows,
      }),
    ).toEqual({ ok: false, reason: "no-tab" });
  });
});
