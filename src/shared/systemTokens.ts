// Tokens the DEVICE resolves at fill time. The profile endpoint never returns
// them: the panel's catalog offers the key (BITE-DYN-TODAY-01) and the planner
// injects the value right before the field-map → token join, so a map carrying
// one shapes through the ordinary `transform` path like any profile date.

/** The coordinator's local calendar date, for signature and attestation dates. */
export const SYSTEM_TODAY_TOKEN = "system.today";

/**
 * Today as canonical `yyyy-mm-dd` from the LOCAL year, month and day.
 * `toISOString()` is deliberately not used: it renders UTC, which is already
 * tomorrow for a coordinator signing a form after 7 pm Eastern.
 */
export function localIsoToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A device-resolved value that was WRITTEN to the page, for the fill log. A
 * date is not PHI, so it rides the fill event for audit. */
export interface DeviceResolvedWrite {
  mapId: string;
  selector: string;
  token: typeof SYSTEM_TODAY_TOKEN;
  /** The canonical `yyyy-mm-dd` the token resolved to — the panel's write
   * boundary validates exactly that shape (`isCalendarDateString`). The
   * spelling that reached the page follows from the map's own `transform`. */
  value: string;
}
