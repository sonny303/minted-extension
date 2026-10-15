# Humana Military (TRICARE) PT certification: capture vs template

- **Capture:** [`humana-tricare.capture.json`](humana-tricare.capture.json): 4 steps, 71 rows, walked 2026-10-14 to the Attestation step (not submitted).
- **Template:** `e842e237-3577-47d4-ab6e-9eee2785caba`, **"Humana Tricare" v3**. Global template, payer **Tricare**, state **NC**, any group. Case type is not set; the editor warns that a new published version needs one. Required provider attributes: CAQH ID, CAQH attestation, NPI, DOB, SSN (last 4).
- **Portal:** Action 1, "Fill online form on Humana Tricare website", fills the global portal **`humana-tricare`**. Its form URL is `…/providercertification/home/index?ProviderType=PT`, the same PT form this capture walked. Form setup reads "Trained", 49 of 60 mapped, 1 page captured, 7 to decide. Action 2, "Check Status on Humana Tricare Website", uses `humana-tricare-status-check` (Captured, 2 to decide) and is out of scope here.
- **payerId:** not shown in the template editor. Only the payer name ("Tricare") appears.
- Read-only: Basics → Next → the "Form setup" panel was expanded. Nothing was edited, approved or saved, and the only network traffic was reads.

The template's library is the extension's one-scan capture of the same 60 controls, all on page_step `Page 2`. The extension sees every accordion step at once, which works for a fill. This capture splits them into the portal's four steps, with gates and routes.

## Fix first: these would file wrong answers or fail Continue

| Field | Template now | Problem | Suggested |
|---|---|---|---|
| `#LicAnyDiscplinaryAction` "Any disciplinary action" | **fixed "Yes"** (approved) | Declares disciplinary action on every application, and "Yes" reveals a comments box and the license upload. | `human` (a per-provider disclosure). |
| `#dob`, `#LicenseEffDate`, `#LicenseExpDate` | shaped **Date → MM/DD/YYYY** | Humana's `isValiddate` only accepts `^\d{1,2}-\d{1,2}-\d{4}$` (dashes) and refuses slashes with "Invalid date: MM-DD-YYYY". | Shape **Date → MM-DD-YYYY**. |
| `#NoLocfax_cd` "I do not have a fax number" (checkbox) | token `group.billingFax` | A fax number mapped onto a checkbox. The fill only ticks on a truthy word, so a location with no fax never gets ticked, and Continue is refused: "You must either provide a fax number or indicate that you do not have one". | `human`: tick only when the location has no fax. |
| Point-of-contact address | street `group.billingStreet`, city `group.billingCity`, ZIP **`group.credentialingZip`**, apt human, state undecided | One address assembled from two different source addresses. Humana also checks the ZIP against the state server-side. | Use one source for the whole block (capture suggests `credentialingContact.*`, alternatively `group.correspondence*`). |
| Option lists stored at the 50 cap | `#MaxAge` 50 of 99, `#MinAge` 50 of 99, `#PractBillingState` 50 of 51, `#CorrespondenceState` 50 of 51, `#providertype` 50 of 77 | The scanner keeps the first 50. `#MaxAge` can't hold any age above 50, so "all ages" (99) is impossible, and WYOMING is missing from both full-state lists. | Re-send the full lists from this capture once mintedpanel#518 deploys. |

## On the portal, missing from the template

| Field | Step | Why it's missing | Capture suggestion |
|---|---|---|---|
| `#Selectedspecialty` "Select primary specialty *" | Demographic information | It's a select2 widget: the native `<select>` is `aria-hidden` and 1×0, so the scanner skips it and the fill would skip it as hidden. It is **required to leave step 2** ("Please select Primary specialty."). | `provider.taxonomyCode`. The option values are NUCC codes (225100000X Physical Therapist, …). Needs select2 support in the scanner and fill; until then a person picks it. |
| `#monstartddl` … `#friendddl` (10 time pickers) | Location… | They're only shown once a day is set to Open, and the extension's scan ran with every day Closed. | Undecided. The template fixes Mon–Fri Open, and Humana then prefills 08:00/18:00. That's fine if those are the hours; otherwise add these rows. |
| `#LicComments`, `#UploadLicense` | Location… | Revealed or enabled only by disciplinary = Yes (not walked). The upload is a file input. | Comments are human; the upload is listed under `uncapturedQuestions`. |

## Mapped differently from the capture's suggestion

| Field | Template | Capture suggests | Note |
|---|---|---|---|
| `#emailaddress` "Email address" (provider's block) | `group.credentialingEmail` | `provider.email` (high) | Defensible if the org routes Humana's mail to its credentialing inbox. Confirm it's intentional. |
| `#CorrespondenceName` "Point of contact name" | `user.name` | `credentialingContact.fullName` (medium) | The coordinator filling the form vs the org's credentialing contact. Either works if they're the same person. |
| `#CorrespondenceEmail` | `group.credentialingEmail` | `credentialingContact.email` (medium) | Same intent, group-level vs org-default contact. |
| `#CorrespondencePhone` | `group.billingPhone` | `credentialingContact.phoneOffice` (medium) | The billing phone for the application's point of contact looks unintended. |
| `#CorrespondenceAddress` / `#CorrespondenceCity` | `group.billingStreet` / `group.billingCity` | `credentialingContact.addressLine1` / `.city` | See "Fix first": the ZIP comes from a different address. |
| `#CorrespondenceZip` | `group.credentialingZip` | `credentialingContact.postalCode` | Same block. |
| `#PracticePhone` "Location phone number" | `facility.appointmentPhone` | `facility.phone` (high) | Fine if the appointment line is what should be listed. |
| `#PracticeFax` "Location fax" | `group.billingFax` | `facility.fax` (high) | The location's fax, not the billing fax. A fax is needed for the directory listing. |
| `#PractitionerName` "Name of group practice (DBA Name)" | `group.name` | `facility.name` (medium) | `group.name` also fills the legal-name field, so DBA = legal name. Fine when the org has no separate DBA. |
| `#Suffix` | human | `provider.suffix` (medium) | Only Jr/Sr/I/II/III match. |
| `#CorrespondenceAddress2` | human | `credentialingContact.addressLine2` (medium) | |
| `#MinAge` | fixed "1" | undecided | "1" excludes infants. An all-ages practice would use 0–99 (99 needs the full `#MaxAge` list). |
| Day status `#sunddl` … `#saturddl` | fixed Closed / Open×5 / Closed | undecided (per location) | Hours differ by location. A fixed Mon–Fri schedule is an org decision. |

## The template's 7 "to decide" rows

| Field | Capture suggestion |
|---|---|
| `#mi` Middle initial | `provider.middleInitial` (high) |
| `#ssn` | human: the full 9-digit SSN, and the catalog only has `provider.ssnLast4`. Humana runs an active-duty check on it. (The template's required attribute "SSN (last 4)" doesn't cover this field.) |
| `#CorrespondenceState` | `credentialingContact.state` (medium), with the full 51-option list |
| `#TelehealthCapabilities` | undecided: a yes/no practice fact with no token, likely fixed per org |
| `#MedicareNumber` | human: optional, format-checked only when filled |
| `#MaxAge` | undecided: needs the full 1–99 list first |
| `#AcceptingNewPatients` | `facility.acceptingNewPatients` (medium) |

## Agrees with the capture

`#providertype` fixed PT · the four step-1 questions fixed "No" (`#ConflictofInterest`, `#IsSalaried`, `#IsinTraining`, `#IsTeaching`; the page refuses any "Yes") · `#firstname`, `#lastname`, `#npi`, `#gender`, `#dob` (token; the shaping is wrong, see above) · `#PractPhysicalState` → `facility.state` · `#PractitionerTin` → `group.tin` · `#PractitionerNPI` → `group.npiType2` · `#PracticeLegalName` → `group.name` · `facility.street/suite/city/zip` · `group.billingStreet/Suite/City/State/Zip` · `#IsBillAddSameasPhysical` fixed No · `#LicenseState` → `license.state` · `#Licensenum` → `license.licenseNumber` · `#LicenseEffDate` → `license.issueDate` · `#LicenseExpDate` → `license.expirationDate` · `#RestrictedLic` fixed No · `#Electronicsignature` and `#AttestedDate` human (Humana requires the attested date to be **today**).

## What the trainer needs to do

1. Fix the five "Fix first" rows: disciplinary-action answer, date shaping, no-fax checkbox, point-of-contact source, and the truncated lists.
2. Decide the 7 open rows and settle the "mapped differently" rows. Most are judgment calls; the point-of-contact phone and location fax look like slips.
3. Add `#Selectedspecialty` once select2 support lands in the extension. Until then the fill can't get past step 2 without a person.
4. Import: Train forms → Import file with this capture sends it under the registered key `humana-tricare`. Propose is idempotent on (portal_key, selector): existing rows keep their decisions and page_step, and only the new rows (`#Selectedspecialty` and the 10 time pickers) arrive as proposals. Option lists over 50 need mintedpanel#518.
5. Before marking the portal proven, check that a fill writes all four steps from step 1, that each Continue passes, and that step 3's Continue posts the location (`/Home/AddLocation`) only after the address-verification popup is answered.
