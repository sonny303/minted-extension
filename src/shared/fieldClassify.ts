// E6.9 — the shared field-map decision classifier.
//
// Keep this in lockstep with mintedpanel/src/lib/fieldRegistry.ts. In
// particular, proposed rows are classified before source: capture produces
// proposed + manual, and that combination is still undecided.

import type { PortalFieldMap } from "./apiTypes";

export type FieldDecision =
  | "undecided"
  | "token"
  | "fixed"
  | "human"
  | "stale"
  | "invalid";

export interface FieldClassification {
  decision: FieldDecision;
  mapped: boolean;
  autofillable: boolean;
  needsDecision: boolean;
  reason: string;
}

export interface ClassifiableFieldMap {
  status: PortalFieldMap["status"];
  source: PortalFieldMap["source"];
  token: string | null;
  hardcodedValue?: string | null;
}

const result = (
  decision: FieldDecision,
  mapped: boolean,
  autofillable: boolean,
  needsDecision: boolean,
  reason: string,
): FieldClassification => ({ decision, mapped, autofillable, needsDecision, reason });

const nonEmpty = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

export function classifyFieldMap(
  map: ClassifiableFieldMap,
  options: { stale?: boolean } = {},
): FieldClassification {
  if (map.status === "retired") {
    return result("stale", false, false, false, "Retired");
  }
  if (options.stale) {
    return result("stale", false, false, false, "Not found in the latest fill");
  }
  if (map.status === "proposed") {
    return result("undecided", false, false, true, "Needs a decision");
  }
  if (map.status === "approved") {
    switch (map.source) {
      case "token":
      case "manual_partial":
        return nonEmpty(map.token)
          ? result("token", true, true, false, `Fills from ${map.token}`)
          : result("invalid", false, false, true, "Mapped to a token but no token is set");
      case "hardcoded":
        return nonEmpty(map.hardcodedValue)
          ? result("fixed", true, true, false, `Fills the fixed value “${map.hardcodedValue}”`)
          : result("invalid", false, false, true, "Fixed value is empty");
      case "manual":
        return result("human", false, false, false, "A person fills this");
      default:
        return result("invalid", false, false, true, "Unrecognized source");
    }
  }
  return result("invalid", false, false, true, "Unrecognized status");
}
