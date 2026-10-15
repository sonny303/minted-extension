# BCBSKS Network Enrollment Form vs. panel template "BCBS - KS"

Read-only comparison, 2026-10-14. Nothing in the panel was edited, approved or
saved. Capture: [`bcbs-ks-enrollment-1514e1bd8cbc.capture.json`](bcbs-ks-enrollment-1514e1bd8cbc.capture.json).

## What the template is

| | |
|---|---|
| Template | **BCBS - KS** v1 — `/admin/templates/301b189f-6e50-458b-8eb1-97e0b292efc5` |
| Tier | Global (inherited by every org without an override) |
| Match key | Case type **Enrollment** · payer **BCBS** · state **KS** · group **Any group** |
| Actions | 1 — "Fill online form", day +0, Auto-fill on, mode **Portal** |
| Form configuration | `bcbs-ks · bcbs-ks-enrollment-1514e1bd8cbc · Global` |
| Portal | name `bcbs-ks` (the Review step's "Portal: bcbs-ks" renders `portal.name`), portal_key **`bcbs-ks-enrollment-1514e1bd8cbc`**, form_url = this form's URL |
| Form setup | **Registered · no fields** — "0 of 0 mapped overall" |
| Required documents / turnaround / follow-up | none set |
| payerId | not shown on the template page (Payer reads "BCBS"), so the trainer link `/admin/payer-admin/setup/{payerId}?tab=templates` is still unknown |

The portal_key comes from the Form configuration label (name · key · tier), not
from an API row. Confirm it before importing.

## Fields on the form that the template lacks

**All of them.** The portal is registered with no field maps, so all 110
captured rows plus the one uncapturable list are new. Nothing in the template
conflicts with the suggestions, because it has no mappings yet.

| Section | Rows | Suggested |
|---|---|---|
| Office contact information | 5 | `credentialingContact.firstName / lastName / title / phoneOffice / email` (medium — the payer sends follow-up paperwork to this person) |
| New provider information | 53 | `provider.firstName / lastName / middleInitial / dateOfBirth / npi / caqhId / taxonomyCode` (high), `provider.gender` (medium), `provider.degree` (low — payer codes), `facility.street / suite / city / state / appointmentPhone` (high), `facility.zip` (medium, 5-digit mask), `group.npiType2` for billing NPI and `group.tin` for tax id (medium), `assignment.startDate` (medium), `facility.acceptingNewPatients` (medium), 24/7 → fixed "No" |
| New group contract | 47 | `group.tin`, `group.npiType2`, `facility.phone`, `facility.fax` (high); `group.name` (legal W-9 name), the service-location block → `facility.*` (medium); directory display name → `facility.name` (low); group taxonomy → `provider.taxonomyCode` (low); 24/7 → fixed "No" |
| Submitter information | 5 | `user.name / title / email` (high); phone → `credentialingContact.phoneOffice` (low, no `user.phone` token) |

Rows a person has to decide (68):

- **Office hours (56 rows)**: provider and group, Sunday–Saturday, from/to as
  `HH:MM` plus an AM/PM select. `facility.hours` is one free-text value, so this
  needs a per-day transform or stays manual. Checking 24/7 disables them, and
  "ONLY telemedicine" hides them.
- **Telemedicine (4)**: provider and group, "telemedicine?" and "ONLY
  telemedicine?". No catalog token exists for either.
- **Group Specialty**: one of BCBSKS's 74 provider-type categories (`A7` =
  PHYSICAL THERAPIST, `BM` = CLINIC OR PROVIDER GROUP). Probably one fixed answer
  per group.
- **Group start date**: "Date patients will begin receiving services through
  this group". Case-specific; `facility.effectiveDate` is the nearest token.
- **ZIP+4 (2)**: optional, and no catalog token exists.
- **Human (4)**: owners/partners/investors, supervising physician NPI and name
  (required only when Degree is PA or LAT), and comments.

## What the template needs

1. **Field maps for portal `bcbs-ks-enrollment-1514e1bd8cbc`.** Import this
   capture through Train forms, then approve the suggestions. Only approved maps
   fill.
2. **The option cap raised first.** Taxonomy (855 options, ×2), Specialty (74)
   and Degree (58) exceed the current cap of 50 and are rejected until panel
   PR #518 and extension PR #99 deploy. State has exactly 50 options, so it
   already fits.
3. **A Degree value map.** The payer uses its own codes (`LPT`, `MD`, `PA`, …).
   A stored `provider.degree` like `PT`/`DPT` matches none of them.
4. **Digits-only transforms** for both tax-id fields (mask `999999999`), and a
   5-digit ZIP (mask `99999`).
5. **Check the required provider attributes.** The editor offers CAQH ID, CAQH
   attestation on file, NPI, Date of birth and SSN (last 4). This form asks for
   NPI, DOB and CAQH ID (marked "required for credentialing"), and needs a
   taxonomy and degree. It never asks for an SSN, so requiring SSN (last 4)
   would block generation for nothing. Which boxes are currently checked was not
   verified.
6. **Case type.** The template is "Enrollment (adding a provider to an existing
   group contract)", but the form always shows a required **New group
   contract** block next to the provider block. Whether an existing-group
   request may leave that block empty is unknown without submitting.
7. **Scanner and fill support for PrimeFaces SelectManyMenu**, for the
   behavioral-health list below. Until then a person fills it.

## Behavioral health areas of expertise (not capturable yet)

`#networkEnrollmentForm\:BehavioralAreasOfExpertise_input` is a required
`<select multiple>` labelled "select up to 10 areas". It appears only when
Degree is APRN, CNS, LCPC, LCP, LMFT, LMLP, LMSW or LPC. Its options (value =
code; label = `<code> - <text>`):

| Code | Area | Code | Area |
|---|---|---|---|
| A01 | ATTENTION DEFICIT DISORDER (ADD/ADHD) | A21 | HIV/AIDS RELATED ISSUES |
| A02 | ADOPTION | A22 | INFERTILITY |
| A03 | ANXIETY AND PANIC DISORDERS | A23 | MEDICATION MANAGEMENT |
| A04 | AUTISM SPECTRUM DISORDERS (AUTISM/PDD/ASPERGERS) | A24 | MENS ISSUES |
| A05 | BARIATRIC ASSESSMENT (add'l form here) | A25 | NEUROPSYCHOLOGICAL TESTING |
| A06 | BEHAVIOR MODIFICATION | A26 | OBSESSIVE COMPULSIVIE DISORDERS |
| A07 | BIPOLAR DISORDERS/MANIC DEPRESSIVE ILLINESS | A27 | PAIN MANAGEMENT |
| A08 | CHEMICAL DEPENDENCY/CHEMICAL DEPENDENCY ASSESSMENT | A28 | PERSONALITY DISORDERS |
| A09 | CHRISTIAN COUNSELING | A29 | PSYCHOLOGICAL TESTING |
| A10 | COMPULSIVE GAMBLING | A30 | SCHIZOPHRENIC DISORDERS |
| A11 | CULTURAL/ETHNIC ISSUES | A31 | TRANSGENDER ISSUES |
| A12 | DEPRESSION | A32 | SEXUAL DISORDERS |
| A13 | DIALECTICAL BEHAVIORAL THERAPY (DBT) | A33 | ABUSE, ASSAULT AND TRAUMA (PTSD) |
| A14 | DIVORCE/BLENDED FAMILY ISSUES | A34 | PRENATAL ISSUES |
| A15 | BEHAVIORAL THERAPY FOR AUTISM SPECTRUM DISORDERS | A35 | WOMENS ISSUES |
| A16 | EATING DISORDERS | A36 | POSTPARTUM ISSUES |
| A17 | ELECTROCONVULSIVE THERPAY (ECT) | A37 | BRIEF SOLUTION FOCUSED |
| A18 | FAMILY THERAPY | A38 | END OF LIFE ISSUES |
| A19 | GAY/LESBIAN/BISEXUAL ISSUES | A39 | GERIATRICS |
| A20 | GROUP THERAPY | A40 | COGNITIVE BEHAVIORAL THERAPY (CBT) |

(Spellings are the payer's.)
