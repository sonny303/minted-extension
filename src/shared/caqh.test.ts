// S6.2/S6.3 — CAQH push offer and the exception (gap) strip.
import { describe, expect, it } from "vitest";
import { attestationLine, attestedOnFor, buildCaqhPushOffer, findCaqhGaps } from "./caqh";
import type { ProfileToken } from "./apiTypes";

const TODAY = "2026-07-28";
const tokens: ProfileToken[] = [
  { token: "provider.npi", value: "1234567890" },
  { token: "provider.caqhId", value: "CAQH-1" },
  { token: "provider.deaNumber", value: null },
  { token: "provider.suffix", value: "   " },
];

// Regression cover for the panel bug these back: the attestation date used to
// come from a module variable written ONLY after a successful attestation POST,
// so every ordinary render passed null into buildCaqhPushOffer. The pure module
// was correct and fully tested; the wiring that fed it was not, so "Never
// attested" showed for every provider and deEmphasize never fired.
describe("attestedOnFor (S6.2 wiring)", () => {
  const roster = [
    { id: "p1", caqhLastAttestedDate: "2026-07-25" },
    { id: "p2", caqhLastAttestedDate: null },
  ];

  it("reads the selected provider's date off the roster row", () => {
    expect(attestedOnFor("p1", roster)).toBe("2026-07-25");
  });

  it("switching providers reports THAT provider's date, never the last one seen", () => {
    expect(attestedOnFor("p2", roster)).toBeNull();
  });

  it("is null with no provider selected, and for a provider not on the roster", () => {
    expect(attestedOnFor(null, roster)).toBeNull();
    expect(attestedOnFor(undefined, roster)).toBeNull();
    expect(attestedOnFor("nope", roster)).toBeNull();
  });

  it("feeds a real date through to the offer, so de-emphasis can actually fire", () => {
    const offer = buildCaqhPushOffer(tokens, attestedOnFor("p1", roster), TODAY);
    expect(offer.deEmphasize).toBe(true);
    expect(attestationLine(offer)).toBe("Last attested 3 days ago");
  });
});

describe("buildCaqhPushOffer (S6.2)", () => {
  it("counts only fields we actually hold a value for", () => {
    // Offering "40 fields" when 26 are blank is a lie discovered mid-fill.
    const offer = buildCaqhPushOffer(tokens, null, TODAY);
    expect(offer.fieldKeys).toEqual(["provider.npi", "provider.caqhId"]);
    expect(offer.headline).toBe("Update CAQH — 2 fields");
  });

  it("says 'field' in the singular", () => {
    const offer = buildCaqhPushOffer([tokens[0]!], null, TODAY);
    expect(offer.headline).toBe("Update CAQH — 1 field");
  });

  it("de-emphasizes when the profile was attested recently", () => {
    const recent = buildCaqhPushOffer(tokens, "2026-07-20", TODAY);
    expect(recent.daysSinceAttestation).toBe(8);
    expect(recent.deEmphasize).toBe(true);
  });

  it("does NOT de-emphasize past the window, or when never attested", () => {
    expect(buildCaqhPushOffer(tokens, "2026-01-01", TODAY).deEmphasize).toBe(false);
    expect(buildCaqhPushOffer(tokens, null, TODAY).deEmphasize).toBe(false);
  });
});

describe("attestationLine", () => {
  it("reads naturally at each age", () => {
    expect(attestationLine(buildCaqhPushOffer(tokens, null, TODAY))).toBe("Never attested");
    expect(attestationLine(buildCaqhPushOffer(tokens, TODAY, TODAY))).toBe("Attested today");
    expect(attestationLine(buildCaqhPushOffer(tokens, "2026-07-27", TODAY))).toBe(
      "Last attested 1 day ago",
    );
    expect(attestationLine(buildCaqhPushOffer(tokens, "2026-07-20", TODAY))).toBe(
      "Last attested 8 days ago",
    );
  });
});

describe("findCaqhGaps (S6.3 — exceptions only, never a sync)", () => {
  const label = (t: string) => t.split(".")[1] ?? t;

  it("reports a field CAQH holds where we are blank", () => {
    const gaps = findCaqhGaps(tokens, new Map([["provider.deaNumber", "BX1234567"]]), label);
    expect(gaps).toEqual([{ token: "provider.deaNumber", label: "deaNumber", portalValue: "BX1234567" }]);
  });

  it("does NOT report a DISAGREEMENT — that would be bidirectional sync", () => {
    // Minted Panel is the source of truth. A field where we differ from CAQH
    // is not a gap; "reconciling" it is exactly what S6.2 forbids.
    const gaps = findCaqhGaps(tokens, new Map([["provider.npi", "9999999999"]]), label);
    expect(gaps).toEqual([]);
  });

  it("ignores a blank portal value — nothing to pull", () => {
    expect(findCaqhGaps(tokens, new Map([["provider.deaNumber", "   "]]), label)).toEqual([]);
  });

  it("returns [] when there are no gaps, so the strip can be omitted entirely", () => {
    expect(findCaqhGaps(tokens, new Map(), label)).toEqual([]);
  });

  it("treats a whitespace-only value of ours as blank (a real gap)", () => {
    const gaps = findCaqhGaps(tokens, new Map([["provider.suffix", "Jr"]]), label);
    expect(gaps.map((g) => g.token)).toEqual(["provider.suffix"]);
  });
});
