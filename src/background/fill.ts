// Fill orchestration: fetch the portal's field maps and the provider's
// resolved token values, plan per-field instructions, hand them to the
// content script in the portal tab, then log the attempt via
// POST /api/fill-events (idempotency id = crypto.randomUUID per attempt).
//
// Planning rules (v0):
//   file fields            never attempted — listed for the user
//   source "manual"        never attempted — not tracked in Minted Panel
//   source "hardcoded"     fill with hardcoded_value
//   source "token"         fill with the profile value; null/empty = listed
//   source "manual_partial" fill the token value AND flag for manual review
//   status "retired"       ignored; "proposed"/"approved" both fill in v0
import type { PortalFieldMap, ProviderProfileResponse } from "../shared/apiTypes";
import type { FillInstruction, FillPageResult, FillSummary, ReportedField } from "../shared/fill";
import { getPortalFieldMaps, getProviderProfile, postFillEvent } from "./api";

const STATE_ABBREVS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

// yyyy-mm-dd (or a full ISO timestamp) → mm/dd/yyyy, without timezone math.
function toMmDdYyyy(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

export function applyTransform(value: string, transform: string | null): string {
  switch (transform) {
    case null:
      return value;
    case "date_mmddyyyy":
      return toMmDdYyyy(value);
    case "state_abbrev": {
      const trimmed = value.trim();
      if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
      return STATE_ABBREVS[trimmed.toLowerCase()] ?? value;
    }
    default:
      // Unknown transform: fill the raw value rather than dropping the field.
      return value;
  }
}

function humanLabel(map: PortalFieldMap): string {
  return map.selector.startsWith("label:") ? map.selector.slice("label:".length) : map.selector;
}

export interface FillPlan {
  instructions: FillInstruction[];
  manual: ReportedField[];
}

export function planFill(maps: PortalFieldMap[], profile: ProviderProfileResponse): FillPlan {
  const tokenValues = new Map<string, unknown>(profile.tokens.map((t) => [t.token, t.value]));
  const unresolvedReasons = new Map<string, string>(
    profile.unresolved.map((u) => [u.token, u.reason]),
  );

  const instructions: FillInstruction[] = [];
  const manual: ReportedField[] = [];

  for (const map of maps) {
    if (map.mapType !== "web" || map.status === "retired") continue;
    const label = humanLabel(map);

    if (map.fieldType === "file") {
      manual.push({ label, reason: "file upload — attach manually" });
      continue;
    }
    if (map.source === "manual") {
      manual.push({ label, reason: map.notes ?? "not tracked in Minted Panel — enter manually" });
      continue;
    }

    let raw: unknown;
    if (map.source === "hardcoded") {
      raw = map.hardcodedValue;
    } else if (map.token != null) {
      raw = tokenValues.get(map.token) ?? null;
    } else {
      manual.push({ label, reason: "field map has no token — enter manually" });
      continue;
    }
    if (raw == null || raw === "") {
      const reason =
        (map.token != null ? unresolvedReasons.get(map.token) : null) ??
        "no value in Minted Panel";
      manual.push({ label, reason });
      continue;
    }

    instructions.push({
      mapId: map.id,
      label,
      selector: map.selector,
      selectorFallbacks: map.selectorFallbacks ?? [],
      fieldType: map.fieldType,
      value: applyTransform(String(raw), map.transform),
    });
    if (map.source === "manual_partial") {
      manual.push({ label, reason: map.notes ?? "prefilled — review and complete manually" });
    }
  }

  return { instructions, manual };
}

export interface FillRequest {
  tabId: number;
  providerId: string;
  caseId: string;
  portalKey: string;
  state: string;
}

export async function fillPortal(request: FillRequest): Promise<FillSummary> {
  const startedAt = new Date().toISOString();
  // The attempt's idempotency id doubles as the fill_sessions row PK; the
  // popup passes it back as fill_session_id when the human marks the
  // submission, tying the business log to this machine log.
  const fillSessionId = crypto.randomUUID();
  const [maps, profile] = await Promise.all([
    getPortalFieldMaps(request.portalKey),
    getProviderProfile(request.providerId, request.state),
  ]);
  const { instructions, manual } = planFill(maps, profile);

  let pageResult: FillPageResult;
  try {
    const response = (await chrome.tabs.sendMessage(request.tabId, {
      type: "APPLY_FILL",
      instructions,
    })) as { ok: boolean; data?: FillPageResult; error?: string } | undefined;
    if (!response?.ok || !response.data) {
      throw new Error(response?.error ?? "The page reported no result");
    }
    pageResult = response.data;
  } catch (error) {
    throw new Error(
      error instanceof Error && !error.message.includes("Receiving end does not exist")
        ? `Fill failed on the page: ${error.message}`
        : "Could not reach the enrollment form — open the BCBS KS enrollment page in the current tab and reload it.",
      { cause: error },
    );
  }
  const completedAt = new Date().toISOString();

  // Log the attempt. A logging failure must not un-report a successful fill,
  // so it degrades to a warning in the summary instead of throwing.
  let eventRecorded = true;
  let eventError: string | null = null;
  try {
    await postFillEvent({
      id: fillSessionId,
      caseId: request.caseId,
      providerId: request.providerId,
      portalKey: request.portalKey,
      fillMode: "web",
      startedAt,
      completedAt,
      fieldsFilled: pageResult.filled.length,
      fieldsSkipped: [
        ...pageResult.skipped.map((f) => ({ ...f, kind: "skipped" })),
        ...manual.map((f) => ({ ...f, kind: "manual" })),
      ],
    });
  } catch (error) {
    eventRecorded = false;
    eventError = error instanceof Error ? error.message : "Failed to record the fill event";
  }

  return {
    filled: pageResult.filled.length,
    filledLabels: pageResult.filled,
    skipped: pageResult.skipped,
    manual,
    eventRecorded,
    eventError,
    // Only reference the session when the server actually stored it — the
    // touches route validates fill_session_id and 404s an unknown id.
    fillSessionId: eventRecorded ? fillSessionId : null,
  };
}
