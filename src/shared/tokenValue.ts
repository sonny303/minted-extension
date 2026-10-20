// The one rule for turning a profile token value into the text a fill or a
// quick card may use.
//
// The profile endpoint pushes RAW column values (`ProfileToken.value` is
// `unknown`): strings and numbers, but also booleans, arrays, and jsonb
// objects such as `facilities.hours` / `ada_compliance` (which default to
// `{}`, so even an empty facility carries an object). `String(raw)` rendered
// those objects as the literal text "[object Object]" and typed it into payer
// forms. The panel's PDF path (`mintedpanel/src/lib/entityTokens.ts`
// `formatTokenValue`) already drops objects and joins primitive arrays with
// ", "; this mirrors that half of its rule so both fill surfaces agree.
//
// Deliberately unchanged: booleans still read "true"/"false" here (the PDF
// path says Yes/No). Changing that would change checkbox semantics on the web
// fill and is a separate decision.

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** The single-line text for a token value, or null when the value has none:
 * null/undefined, "", an object, or an array holding anything but primitives.
 * A null here is a DATA gap ("no value in Minted Panel"), never a fill. */
export function tokenValueText(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw === "" ? null : raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    if (!raw.every(isPrimitive)) return null;
    const parts = raw.map((part) => String(part).trim()).filter((part) => part !== "");
    return parts.length === 0 ? null : parts.join(", ");
  }
  return null;
}
