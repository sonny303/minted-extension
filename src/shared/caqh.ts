// S6.2/S6.3 — the CAQH surfaces. Pure: the caller supplies the profile tokens,
// what the page holds, and `today`.
//
// PUSH ONLY, in one direction, forever (S6.2's own criterion: "No
// bidirectional sync anywhere"). Minted Panel is the source of truth; CAQH is
// a form we fill. The one exception is S6.3's EXCEPTION strip — a value CAQH
// holds where we are blank — and even that is a human-confirmed pull of a
// single field, never a sync.
import type { ProfileToken } from "./apiTypes";

/** Days after which the push offer de-emphasizes (matches the panel's
 * CAQH_CURRENT_DAYS; the server is authoritative and sends it back on
 * attestation, so this is only the pre-response default). */
export const CAQH_FRESH_DAYS = 120;

export interface CaqhPushOffer {
  /** Token keys we hold a value for and would carry into CAQH. */
  fieldKeys: string[];
  /** The offer headline: "Update CAQH — 14 fields". */
  headline: string;
  /** Days since the last attestation, or null when never attested. */
  daysSinceAttestation: number | null;
  /** True when a recent attestation makes this offer low-priority (S6.2:
   * "recently-attested state de-emphasizes the offer"). */
  deEmphasize: boolean;
}

function daysBetween(fromIso: string | null, today: string): number | null {
  if (!fromIso) return null;
  const from = fromIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const ms =
    Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) -
    Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  return Math.floor(ms / 86_400_000);
}

/** The attestation date to show for the selected provider.
 *
 * Lives here, in the tested pure module, because the panel originally decided
 * it with a module variable that was only ever assigned after a successful
 * attestation POST. On every ordinary render that variable was still null, so
 * a provider attested last week read "Never attested", the S6.2 de-emphasis
 * never fired, and a stale value outlived a provider switch. The roster row
 * carries `caqhLastAttestedDate`; it is the source of truth. */
export function attestedOnFor(
  providerId: string | null | undefined,
  providers: readonly { id: string; caqhLastAttestedDate: string | null }[],
): string | null {
  if (!providerId) return null;
  return providers.find((p) => p.id === providerId)?.caqhLastAttestedDate ?? null;
}

/** Build the push offer from the profile. Only tokens with a non-empty value
 * count: offering to "update 40 fields" when 26 are blank would be a lie the
 * user discovers mid-fill. */
export function buildCaqhPushOffer(
  tokens: readonly ProfileToken[],
  lastAttestedOn: string | null,
  today: string,
  freshDays: number = CAQH_FRESH_DAYS,
): CaqhPushOffer {
  const fieldKeys = tokens
    .filter((t) => t.value != null && String(t.value).trim() !== "")
    .map((t) => t.token);
  const daysSinceAttestation = daysBetween(lastAttestedOn, today);
  return {
    fieldKeys,
    headline: `Update CAQH — ${fieldKeys.length} ${fieldKeys.length === 1 ? "field" : "fields"}`,
    daysSinceAttestation,
    deEmphasize: daysSinceAttestation != null && daysSinceAttestation <= freshDays,
  };
}

/** The attestation subtitle: "Last attested 8 days ago" / "Never attested". */
export function attestationLine(offer: CaqhPushOffer): string {
  if (offer.daysSinceAttestation == null) return "Never attested";
  if (offer.daysSinceAttestation === 0) return "Attested today";
  const unit = offer.daysSinceAttestation === 1 ? "day" : "days";
  return `Last attested ${offer.daysSinceAttestation} ${unit} ago`;
}

/** One field CAQH holds a value for that Minted Panel does not (S6.3). */
export interface CaqhGap {
  token: string;
  label: string;
  /** What CAQH shows. Held in memory for the length of the review only —
   * never persisted (the standing PHI rule for values). */
  portalValue: string;
}

/** Find the EXCEPTIONS: fields where the portal holds something and we hold
 * nothing. Strictly one-directional — a field where we differ from CAQH is
 * NOT a gap, because Minted Panel is the source of truth and "reconciling"
 * a disagreement is the bidirectional sync this feature refuses to be. */
export function findCaqhGaps(
  tokens: readonly ProfileToken[],
  portalValues: ReadonlyMap<string, string>,
  labelFor: (token: string) => string,
): CaqhGap[] {
  const ours = new Map(tokens.map((t) => [t.token, t.value]));
  const gaps: CaqhGap[] = [];
  for (const [token, portalValue] of portalValues) {
    const value = portalValue.trim();
    if (!value) continue;
    const mine = ours.get(token);
    const haveMine = mine != null && String(mine).trim() !== "";
    if (haveMine) continue;
    gaps.push({ token, label: labelFor(token), portalValue: value });
  }
  return gaps.sort((a, b) => a.label.localeCompare(b.label));
}
