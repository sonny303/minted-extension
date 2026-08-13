// E6.9 — synthetic profile for the Train-forms mock dry run.
//
// This module must stay in lockstep with mintedpanel/src/lib/mockFillProfile.ts.
// It is deliberately values-only: the worker resolves these values before
// sending instructions to the content script, and no provider PHI is read.

export const MOCK_FILL_PROFILE_VERSION = 1;

export const MOCK_FILL_VALUES: Readonly<Record<string, string>> = {
  "provider.firstName": "Sample",
  "provider.lastName": "Provider",
  "provider.email": "sample.provider@example.com",
  "provider.phone": "5555550100",
  "provider.npi": "1999999984",
  "provider.caqhId": "12345678",
  "provider.caqhLastAttestedDate": "2026-01-15",
  "provider.taxonomyCode": "225100000X",
  "provider.deaNumber": "AB1234563",
  "provider.specialty": "Physical Therapy",
  "provider.credentials": "PT, DPT",
  "provider.dateOfBirth": "1980-01-15",
  "provider.ssnLast4": "0000",
  "provider.homeStreet": "123 Sample St",
  "provider.homeCity": "Sampleville",
  "provider.homeState": "NC",
  "provider.homeZip": "27601",
  "provider.startDate": "2026-01-15",
  "provider.licenseNumber": "SAMPLE-12345",
  "license.licenseNumber": "SAMPLE-12345",
  "license.state": "NC",
  "license.licenseType": "PT",
  "license.issueDate": "2020-01-15",
  "license.expirationDate": "2027-01-15",
  "group.name": "Sample Provider Group",
  "group.tin": "123456789",
  "group.npi": "1999999984",
  "facility.name": "Sample Clinic",
  "facility.street": "456 Sample Ave",
  "facility.city": "Sampleville",
  "facility.state": "NC",
  "facility.zip": "27601",
  "user.name": "Sample Operator",
  "user.email": "sample.operator@example.com",
};

export function mockValueForToken(token: string): string {
  const curated = MOCK_FILL_VALUES[token];
  if (curated) return curated;
  const field = token.slice(token.lastIndexOf(".") + 1);
  const lower = field.toLowerCase();
  if (lower.includes("date")) return "2026-01-15";
  if (lower.includes("email")) return "sample@example.com";
  if (lower.includes("phone") || lower.includes("fax")) return "5555550100";
  if (lower === "state" || lower.endsWith("state")) return "NC";
  if (lower.includes("zip")) return "27601";
  if (lower.includes("npi")) return "1999999984";
  const words = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `Sample ${words}`;
}

export function buildMockTokenMap(
  tokens: Iterable<string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of tokens) {
    const token = value?.trim();
    if (!token || out[token]) continue;
    out[token] = mockValueForToken(token);
  }
  return out;
}
