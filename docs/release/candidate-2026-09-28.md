# Workbench 0.1.3 release qualification record

Status: **local package preflight only**. This record belongs to Panel catch-up
R7 and does not authorize Chrome Web Store submission.

| Boundary             | Observed evidence                                                                                                                                                                                                                                                                            | Result                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Source               | `main` `058c4ca198ee2be2bea0a2651964fea5942db4eb`, tree `0e715641cf819e3e3d126a2a7fec9e73d73b924a`, clean build inputs `b1a904fa3a077f63cb685bbc4684da34c29845a280613a6f152b3b0a10e60ce1`                                                                                                    | Bound                                                                                                  |
| Local checks         | `npm ci --offline`; typecheck; lint; release suite, 75 tests in five files                                                                                                                                                                                                                   | PASS                                                                                                   |
| Staging package      | `release-artifacts/staging/extension.zip`, SHA-256 `16966079d7f58793d9fd0dd6b3ee1c0efdaa894bbd9ebf92c78ce16784f7f123`, bundle digest `2227b28b2782595952b093e3d212d425c0efcd387d6a4e9601f5cf69b6e73a83`, record digest `e1c305634ac61432bbbf7e14dba14e876d1b938fa6d949d5a300fd1a0bf5f556`    | Built, manual result PENDING                                                                           |
| Production package   | `release-artifacts/production/extension.zip`, SHA-256 `755e9c530bec33f900d85cd2cd41729f1e2ea12e759c061558849f0608122f86`, bundle digest `0246910bf3fb2351c83f27881b33174f4025ff62a8d101877940d11c1c40272e`, record digest `ab6acaa107cdaaeda572c11e2f2dadb0d025538e04bbcd54525f453fa85577a3` | Built, not a Store submission                                                                          |
| Public Store listing | Existing item `dppfnbikpojpgdiobckgcknmkjlfoinh` displayed version **0.1.3**, updated September 28, 2026, on the [public listing](https://chromewebstore.google.com/detail/minted-panel-workbench/dppfnbikpojpgdiobckgcknmkjlfoinh)                                                          | Published version observed; installed version and effective audience unverified                        |
| Store dashboard      | Account re-verification required when opening Developer Dashboard                                                                                                                                                                                                                            | BLOCKED for item-level/publisher-level audience, owner, review state and exact release policy readback |

Both target provenance records have `source.dirty: false`. Their public key
checks are `STRUCTURAL_ONLY`; the staging record reports
`BLOCKED_DEPLOYMENT_PROTECTION` for hosted API verification. The production
record reports `UNVERIFIED`. The ignored local ZIPs and public-key configuration
files are not committed to this PR. Package hashes are integrity references to
the local candidate, not evidence that Chrome installed it or that the Store
contains these exact bytes.

## Native staging qualification still required

1. Fix the dedicated staging site's authenticated API access for the extension
   worker and bind the actual unpacked Chrome ID to Panel's handoff/CORS setting.
2. Load the exact staging package from a stable absolute path; record Chrome's
   actual ID and the package/provenance digest in the manual-results record.
3. Run the owned synthetic staging scenarios: sign-in, tenant/role denial,
   selected case and location handoff, fill without submission, reload/worker
   refresh and sign-out. Record each outcome, including existing handoff defects.
4. Compare the exact production archive with the served Panel API and all
   declared supported installed extension versions. A public version label does
   not establish this compatibility.

## Publication decision

The public listing already advertises 0.1.3, the same version as this source.
Do not upload this same-version ZIP as a supposed update. After native PASS,
review the dashboard's exact item, publisher, effective Private/Unlisted
audience, current package version and accepted release. If code or version must
change, open a separate reviewed source/version PR, rebuild both packages and
repeat dependent qualification. If the existing 0.1.3 is already the intended
production release, verify installed bytes/behavior and close the release gap
with evidence rather than resubmitting it.
