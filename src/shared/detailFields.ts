// Display labels for profile-token field keys, shared by the quick-card
// projection (src/shared/quickCards.ts), the Edit Layout picker, and the
// panel's date rendering. The customizable field VOCABULARY itself moved to
// the closed catalog in quickCards.ts (E4.3 TE-16) — this module only knows
// how to label and group a key, never which keys are selectable.

// Human labels for the well-known fields; anything else is humanized from the
// token itself.
const LABEL_OVERRIDES: Record<string, string> = {
  "license.licenseNumber": "License number",
  "license.issueDate": "License issue date",
  "license.expirationDate": "License expiration",
  "license.state": "License state",
  "provider.npi": "NPI",
  "provider.caqhId": "CAQH ID",
  "provider.dateOfBirth": "DOB",
  "group.tin": "Tax ID (TIN)",
  "group.npiType2": "Group NPI",
  "groupInsurance.insurerName": "Malpractice insurer",
  "groupInsurance.policyNumber": "Policy number",
  "groupInsurance.policyEndDate": "Policy expiration",
};

// Section headings for the layout picker, keyed by token prefix.
export const PREFIX_LABELS: Record<string, string> = {
  provider: "Provider",
  group: "Group",
  facility: "Location",
  assignment: "Location assignment",
  license: "License",
  groupInsurance: "Group insurance",
};

const ACRONYMS = new Set(["npi", "tin", "ein", "caqh", "ssn", "dob", "id", "zip", "url", "mso", "dea"]);

// "placeOfServiceCode" -> "Place of service code"; known acronyms upper-cased.
function humanizeCamel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  const first = words[0] ?? "";
  words[0] = first === first.toUpperCase() ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

export function tokenPrefix(token: string): string {
  return token.split(".")[0] ?? "";
}

export function labelForToken(token: string): string {
  const override = LABEL_OVERRIDES[token];
  if (override) return override;
  const name = token.split(".")[1] ?? token;
  return humanizeCamel(name);
}

// ISO date(-time) values render as "Jul 5, 2026" in the panel.
export function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value);
}
