# Holista Nano synthetic pilot

## Decision and scope

Demonstrate the merged generic Nano fill path on Holista's [provider network
form](https://therapy.holistahealth.com/provider-network-form/) with a synthetic
Minted organization, case, and single facility. Leave the populated page and
Workbench review visible to the user. Do not search a real NPI, attach files,
click **Submit Application**, click **Mark submitted**, or create learned maps.
This pilot provides a visible draft, not a completed application or payer proof.

The form was read without entering values on 2026-09-27. Its two forms contain
31 visible text inputs, four hidden Material UI dropdown backing inputs, and
two file inputs. The dropdown widgets cover office state, billing state,
languages, and services. The file inputs require a W-9 and staff roster for
submission. The browser fixture in `src/content/holistaPilot.test.ts` preserves
the observed control IDs and these boundaries, but cannot prove live behavior.

## Preconditions

| Check | Required evidence |
| --- | --- |
| Source | Installed staging extension includes merged Nano PR #69; note version, source SHA, and actual extension ID. |
| Model | `LanguageModel.availability()` reports `available` in the extension panel on this device. An unavailable model is a reported pilot blocker. |
| Data | Dedicated synthetic org, case, group, provider, and exactly one chosen facility; no customer identifiers or documents. |
| API | Extension worker can read the staging API, including case-bound profile and portal registry; hosted migration for learning is checked separately and is not needed for this no-submission run. |
| Portal | A visible registry entry has a stable key and the exact `https://therapy.holistahealth.com/provider-network-form/` URL; Chrome grants that origin only. Do not create a hosted row under this PR. |

The proposed registry key is `holista_therapy_network`, subject to a live
collision check. Leave its payer association unset until the specific product
and network are confirmed. Form URL matching uses the origin and path, not
query parameters.

## Run and review

1. Open the live Holista form and the Workbench side panel in Chrome. Select
   the synthetic org, provider, case, and facility; verify the displayed tuple.
2. Capture the page's public field metadata and compare it with the fixture.
   Record the number of visible, mapped, AI-suggested, manual, and skipped
   controls. Every visible target must have an outcome.
3. Treat both NPI boxes as manual until Holista's **Office NPI** semantics are
   confirmed. The search NPI and application NPI are different controls; do not
   assume `provider.npi` or `group.npiType2` for either. Verify every other
   suggested token against its section before allowing a write.
4. Click **Fill this page** once. Inspect green static writes and amber Nano
   writes on the page and in the side panel. Check readback for office,
   billing, medical-record, and credentialing contacts separately. Report any
   field where the page reverts or changes a value.
5. Complete custom dropdowns manually with synthetic selections if needed for
   the visible draft. Record site-native **Same as Office/Billing** copies as
   manual/site actions, not Nano fills. Leave W-9 and roster unselected.
6. Leave the populated page open for user review. Record a value-free coverage
   table and an optional screenshot containing synthetic values only. Do not
   submit or log a submission touch.

## Pass and follow-up

The pilot passes only if Chrome runs Nano, the chosen context remains stable,
every attempted write survives page readback, and the user can see the filled
draft with all manual and required-file gaps identified. A no-match result,
unavailable model, inaccessible staging API, missing portal registration, or
unreviewed NPI suggestion is an honest partial/blocked result.

If the live trial exposes a reproducible generic scanner or fill defect, add
the narrow fix and its regression to this draft PR. If the required value is
absent from the panel's token catalog or profile, scope a separate panel-first
PR with tenant-isolation verification. Merge, hosted registry changes,
extension installation/release, and any real application remain separate
owner decisions.
