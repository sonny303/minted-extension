// The provider detail card's customizable field vocabulary: which profile
// tokens can appear as rows, their display labels, and the default set shown
// when the user has saved no view preference. Shared by the background (which
// projects tokens into rows) and the panel (which renders the customize UI).

// One selectable field: a bare catalog token key plus its display label.
export interface DetailFieldOption {
  token: string;
  label: string;
}

// A rendered detail row: the option plus its resolved value (null = "Not on
// file"). Values are display strings only — the panel never sees raw tokens.
export interface ProviderDetailRow {
  token: string;
  label: string;
  value: string | null;
}

// Token prefixes that can never resolve on the profile endpoint (case-scoped
// sources — the server always returns them null with an "unresolved" reason),
// so they are not offered in the customize list.
const CASE_SCOPED_PREFIXES = new Set(["payer", "mso", "contract"]);

// Rendered separately in the card header, not as a row.
const HEADER_TOKENS = new Set(["provider.dateOfBirth"]);

// The out-of-the-box field set (Story 4's card), used when the user has not
// saved a view preference.
export const DEFAULT_DETAIL_TOKENS: string[] = [
  "license.licenseNumber",
  "license.issueDate",
  "license.expirationDate",
  "provider.npi",
  "provider.caqhId",
  "group.tin",
  "group.npiType2",
];

// Human labels for the well-known fields; anything else is humanized from the
// token itself.
const LABEL_OVERRIDES: Record<string, string> = {
  "license.licenseNumber": "License number",
  "license.issueDate": "License issue date",
  "license.expirationDate": "License Expiration Date",
  "provider.npi": "NPI number",
  "provider.caqhId": "CAQH #",
  "group.tin": "TIN / EIN",
  "group.npiType2": "Group NPI",
};

// Section headings for the customize list, keyed by token prefix.
export const PREFIX_LABELS: Record<string, string> = {
  provider: "Provider",
  group: "Group",
  facility: "Location",
  assignment: "Location assignment",
  license: "License",
  groupInsurance: "Group insurance",
  user: "User",
};

const ACRONYMS = new Set(["npi", "tin", "ein", "caqh", "ssn", "dob", "id", "zip", "url", "mso"]);

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

// The customize list: every profile token that could resolve, in the server's
// catalog order, minus case-scoped tokens and header-rendered ones.
export function availableDetailFields(tokens: Array<{ token: string }>): DetailFieldOption[] {
  const seen = new Set<string>();
  const options: DetailFieldOption[] = [];
  for (const { token } of tokens) {
    if (seen.has(token) || HEADER_TOKENS.has(token)) continue;
    if (CASE_SCOPED_PREFIXES.has(tokenPrefix(token))) continue;
    seen.add(token);
    options.push({ token, label: labelForToken(token) });
  }
  return options;
}

// ISO date(-time) values render as "Jul 5, 2026" in the panel.
export function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value);
}
