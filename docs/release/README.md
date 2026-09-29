# Local staging extension and restricted production release

The [September 28 candidate record](candidate-2026-09-28.md) captures the
current v0.1.3 local packages, public Store version and open native checks.

The user clones, builds and manually tests staging locally. Production uses a
separate restricted Chrome Web Store item/release decision. These scripts prepare
and inspect packages; they do not access a browser, change a listing, upload or
publish anything. Web/database production approval remains its own single GitHub
approval and does not publish an extension.

## Clone and load staging

Use Node 22, Git, and the system `zip`/`unzip` commands. Get the reviewed extension
commit SHA from the merged PR/release handoff before the checkout step. The token
`REVIEWED_EXTENSION_COMMIT_SHA` below must be replaced by that actual SHA.

```sh
git clone https://github.com/sonny303/minted-extension.git minted-extension-staging
cd minted-extension-staging
git checkout --detach REVIEWED_EXTENSION_COMMIT_SHA
npm ci
cp docs/release/staging-public.example.json staging-public.local
```

Replace only the public key placeholder in `staging-public.local` with the
verified browser-safe key for `vmznysvietfaddakkegt`. The file contains exactly the
three named VITE values; unknown fields and missing values fail. It is JSON,
despite the `.local` extension, and is ignored by Git. Never put a server key,
Vercel bypass, Store token, account password or refresh token into it.

```sh
npm run typecheck
npm run lint
npm run test
npm run build:staging -- --config staging-public.local
```

Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and
choose `release-artifacts/staging/extension`. Its name is **Minted Panel Workbench
— STAGING (Local)**. Record the actual extension ID shown by Chrome. The build
does not invent an ID or embed the production Store ID. Keep the clone/output
path stable; confirm the ID again whenever the path, manifest or installation
changes.

For another reviewed revision, check it out, run `npm ci` and the checks, then
repeat the same staging build. On `chrome://extensions`, reload this staging
extension; reopen/reload test tabs so old content scripts are replaced. Do not
load the production output or the legacy `dist/` directory for staging.

For intentional local uncommitted changes, add `--allow-dirty`. The provenance
records both the real HEAD and a digest of actual build inputs, and marks source
dirty. This permits local testing, but the Store check rejects that package.
Commit/review and rebuild clean before a production extension release. PM owns
PR merges; these commands do not merge or push anything.

## Reviewed staging candidate origin (local testing only)

When the stable staging aliases are blocked by hosting protection, an owner may
prepare a staging-only package for one exact Vercel Preview deployment. The
builder performs authenticated, read-only Vercel API checks using `VERCEL_TOKEN`
from the process environment. It verifies the deployment is `READY`, belongs to
project `prj_1t7NkRJMkjTuFXEBEP4GjfN4B6Ch` and team
`team_230fpJ9MgCj9ssW3LiIckfyA`, matches the supplied panel SHA and the
`sonny303/mintedpanel` `staging` source, and is attached to the supplied origin.
It also records a provider configuration digest derived from project and
environment metadata without copying environment values.

```sh
VERCEL_TOKEN='provided-by-the-owner-session' npm run build:staging -- \
  --config staging-public.local \
  --candidate-origin https://mintedpanel-staging-candidate.vercel.app \
  --candidate-deployment-id dpl_REVIEWED_CANDIDATE \
  --candidate-panel-sha PANEL_COMMIT_SHA
```

The candidate origin must be one canonical HTTPS origin with no path, query,
fragment, port or user information. The provider readback, candidate origin,
deployment ID, panel SHA, fixed project/team IDs, deployment release digest,
source tree SHA, positive source file count and observed project configuration
digest are retained in `provenance.json`. The observed project configuration is
read at verification time; deployment-time configuration binding and receipt
binding remain **UNVERIFIED**, and candidate `releaseAdmission` remains
**BLOCKED**. The package keeps both stable staging origins and
adds the candidate origin to the generated API base, host permissions and
external handoff allowlist. Production builds reject all candidate inputs, and
Store prerequisite checks reject candidate provenance.

Load the generated package from the same absolute unpacked path used for the
staging installation, reload that extension after rebuilding, then reload test
tabs so content scripts are replaced. Record the actual Chrome extension ID and
compare it with the web sender/CORS configuration during the later owner-managed
cutover. Candidate packaging and provider readback do not establish a native
browser PASS, hosted runtime PASS, or Store qualification. Keep the manual
record pending or blocked until the exact installation, reload, ID comparison,
authenticated staging account, tenant/role, handoff, fill/human-submit, and
sign-out/reload scenarios are actually run; do not claim native PASS from this
build.

## What is ready to test

Package compilation and static environment checks can pass independently of
hosted access. **The current staging Vercel protection blocks the extension's
unchanged worker API fetch.** A user signing into the website does not establish
that this worker can pass the hosting gate. The package record therefore retains
`BLOCKED_DEPLOYMENT_PROTECTION` for staging hosted API verification. These builds
do not perform a new network probe.

Do not embed a bypass token, weaken protection, switch to production data or
claim an HTTP/build test is a browser pass. A separate local-loopback web/API
option has not been selected or implemented. The staging API access decision
must be resolved before the dependent manual scenarios can pass.

The local ID also needs to match the web sender and owner-managed
`API_CORS_ORIGINS` entry `chrome-extension://<actual-id>`. Report the actual ID to
the release owner; the build makes no hosted configuration change. The known web
handoff signature/product defect remains separate product work. Correct origin
configuration alone does not repair or prove that handoff.

Copy [manual-results.example.json](manual-results.example.json) to
`staging-manual-results.local`. Fill in source SHA, build-input and package digests, version, actual local
ID, Chrome version and test time. Keep statuses as PENDING/BLOCKED until actually
performed; report PASS/FAIL honestly and without credentials or provider values.

1. Confirm the local extension loads, has the staging label, and its record
   matches the package you loaded.
2. Confirm requests use staging Supabase and staging app origins. Stop on a
   production destination or a hosting sign-in response; record the blocker.
3. Once access is resolved, sign in with owned synthetic staging accounts. Check
   the correct organization, roles and denied cross-organization access.
4. Verify case handoff targets this actual local extension ID and preserves the
   selected case/location. Mark the existing sender defect as failed/blocked.
5. On an approved synthetic portal/form, check fill and capture behavior; the
   extension must leave submission to the human. Do not use customer submissions
   to test the release machinery.
6. Check reload/worker refresh and sign-out clear or restore the documented
   session state. Record the result of each scenario, not just overall success.

Manual records are **user-reported evidence**. A release owner must review the
completed report and its exact package bindings before recording an overall
PASS. Pending, skipped or blocked scenarios cannot support that PASS. This setup
does not authenticate the report or assert a native browser pass or a supported
production extension-version set.

## Package targets and guarantees

| Target     | API                               | Database               | Permitted web handoff origins                                  | Distribution                        |
| ---------- | --------------------------------- | ---------------------- | -------------------------------------------------------------- | ----------------------------------- |
| staging    | `https://staging.mintedpanel.com` | `vmznysvietfaddakkegt` | canonical staging and `https://mintedpanel-staging.vercel.app` | Local unpacked only                 |
| production | `https://mintedpanel.vercel.app`  | `fkvuhfsqcmujywzgczmc` | existing Vercel URL and `https://www.mintedpanel.com`          | Separate restricted Store candidate |

The guarded builder ignores `.env` files and ambient VITE values, then explicitly
injects the validated public values and fixed handoff list. It runs the existing
main build **and** IIFE content build. Generated manifests align host permissions
and external sender origins with the same target. Existing optional portal
permissions and the wire/product behavior stay unchanged.

Each successful target has its own folder:

```text
release-artifacts/staging/extension/      load this locally
release-artifacts/staging/extension.zip   staging artifact; never upload to production
release-artifacts/staging/provenance.json
release-artifacts/production/extension/
release-artifacts/production/extension.zip
release-artifacts/production/provenance.json
```

The record pins repository, real Git SHA/tree, source cleanliness, actual build
input digest, package version, Node version, configuration/key digests, exact
file sizes/hashes, bundle digest and ZIP digest. The CLI also prints the canonical
record digest. Object keys are sorted for hashing; array order is preserved.
The ZIP's exact bytes are bound, but ZIP timestamps can vary across rebuilds.
This is provenance and integrity, not a promise of byte-identical future ZIPs.
The build returns `localPrerequisitesSatisfied: false`; packaging alone does not
satisfy the later release prerequisites. Keep the record immutable: its manual
result stays PENDING and key validation stays STRUCTURAL_ONLY. Later test reports
are separate evidence bound to that record, not edits that turn a build into a
claim of successful authentication or manual testing.

Builds use a target-specific local lock and a temporary directory, switching the
target folder only after both passes and inspection pass. A failed build keeps
the previous completed target output. If a process crashes and leaves a lock,
confirm its recorded PID is no longer building before removing that task-owned
lock; do not run overlapping builders against the same target folder.

Inspection rejects missing worker/content/manifest/panel entries, unexpected
package files, source changes during the build, broad/foreign manifest settings,
known server/bypass/Store credential patterns, unexpected embedded JWTs and
opposite-environment URLs/refs. Tests also inject a synthetic ambient secret and
check it does not survive. The scanner is bounded pattern detection, not a
general secret detector or proof that arbitrary hostile code is safe.

The existing VITE variable name `VITE_SUPABASE_ANON_KEY` accepts a public
`sb_publishable_...` key or a compatible legacy anon JWT. Publishable keys are
opaque; project association must be verified independently. Legacy JWT checks
inspect role/ref/expiry without authenticating the signature. Neither branch
proves the key works. [Supabase's key documentation](https://supabase.com/docs/guides/getting-started/api-keys)
distinguishes browser-safe keys from privileged server keys. Synthetic test keys
have no valid signature and are never live credentials.

## Restricted production Store procedure

The actual publisher, intended item ID, effective permitted users/groups and
supported production web/API versions are **unknown**. No item is created or
changed by this setup. Confirm the intended existing item before proposing any
new one, and obtain the separate exact release decision before submission.

1. Confirm publisher and exact 32-character Store item ID. Inventory current item
   state/version and the complete effective audience. Use **Private** visibility;
   Unlisted allows anyone with the link. Private items still undergo review.
   Publisher-level trusted testers also affect the item's access, including when
   item-level groups are used. Include both in the approved audience; do not
   silently remove or broaden an account-wide tester list. [Chrome distribution
   documentation](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
2. Confirm a reviewed, clean source and version. For an existing published item,
   update package and manifest versions together through review before rebuilding.
   Do not infer an unknown current version is an unpublished item.
3. Copy `production-public.example.json` to `production-public.local`, fill the
   verified public key, run the repository checks and build:

   ```sh
   npm run build:production -- --config production-public.local
   ```

4. Complete private local copies of `store-policy.example.json` and
   `store-observed.example.json`. The empty templates deliberately fail. Policy
   is the user's approved destination, complete audience, exact ZIP digest and
   supported web/API set; observations come from fresh independent dashboard and
   release-owner readbacks. Do not copy policy into observations as evidence.
   Preserve both actual target packages in `release-artifacts/`; their clean
   source SHA, tree, build-input digest and package version must match. Review
   the user's staging report and bind `stagingManual` to its actual local Chrome
   ID, canonical staging record digest, bundle/ZIP digests, source SHA and
   build-input digest. `artifactDigest` is the SHA-256 of that completed report;
   `reportedAt` records the report completion time. The local ID must be distinct
   from the production Store item. Do not fill PASS while hosted access or a
   required manual scenario is still blocked.
   Separately verify the exact production public key's project, Auth and API
   behavior through the authorized test process. `productionVerification`
   requires PASS for each of `publicKeyProject`, `auth` and `api`, an evidence
   artifact digest, completion time, and
   `subjectDigest = canonicalDigest({archiveSha256, configurationDigest,
publicKeyDigest, supabaseRef, apiOrigin})` using the production record's values.
   The key's structural classification is insufficient. This CLI does not run
   those checks or collect credentials.
5. Prove this exact production archive remains compatible with the served and
   declared supported web revisions/API contract. `supportedWebVersions` contains
   explicit Git SHAs; `apiContractDigest` identifies the reviewed contract. The
   compatibility proof has PASS, artifact digest, completion time and
   `subjectDigest = canonicalDigest({archiveSha256, supportedWebVersions,
apiContractDigest})`. Compatibility, staging report and production verification
   must be no older than 24 hours and cannot predate their package build.
   Dashboard/release observations must be no older than five minutes and follow
   both builds. No evidence can be future-dated. Verify real artifacts/provenance
   independently and repeat the readback/check immediately before the authorized
   upload. Rebuilding changes record/archive identity; repeat the dependent
   evidence instead of carrying an old PASS to a new package.
6. Run the local check using the record digest printed by the build:

   ```sh
   npm run check:store -- --policy store-policy.local --observed store-observed.local --record-digest THE_REVIEWED_RECORD_DIGEST
   ```

   The command rehashes both actual target packages' files/ZIPs, checks their fixed
   targets, matching clean source, bound staging report and production verification,
   exact intended/observed item and publisher, effective Private audience, version
   increase and compatibility proof. Audience
   lists use lowercase Google account/group emails, in stable sorted order;
   `domainPublishing` must be false. For an explicitly verified unpublished item,
   use `itemState: "unpublished"` with `currentVersion: null`. Otherwise use
   `published` and its observed version. Unknown is a blocker. Success reports
   `localPrerequisitesSatisfied: true`; Store submission remains
   NOT_PERFORMED_BY_THIS_TOOL, while Google acceptance, Store installation and
   native behavior remain UNVERIFIED.

7. Following the separate release authorization, the publisher manually uploads
   only the verified `production/extension.zip` to that exact item, rechecks
   audience, and submits it for review. Record submission, acceptance, installation
   under the actual Store ID and tested behavior as separate states. A successful
   local check is not Google approval, an upload, or release authorization.

The policy, observations and proof metadata are trusted inputs, not authenticated
by this CLI. A trusted collector/reviewer must inspect the real report and test
artifacts, bind their digests and check source review and provider readbacks. The
CLI validates metadata and package integrity; it does not open or authenticate
the external evidence artifacts. No Store or provider credentials are accepted.
A party controlling these inputs can forge a PASS; the owner must verify them
before acting. Existing extension
installations update independently of the web. Feed the actual supported
installed extension versions and compatibility evidence into the web release
contract, including its rollback checks. Never assume only the newest extension
is installed. No additional extension approval is added to web releases.

## Verification and rollback

`npm run test:release` exercises malformed public configuration, wrong targets,
manifest origin/permission drift, secret patterns, both actual two-pass builds,
archive/file integrity, CLI errors, receiver-origin behavior and Store destination,
audience, version, manual/prod-proof binding and compatibility rejection. Its keys, publishers, item IDs,
versions and evidence are synthetic. The normal `npm run test` also runs these
checks. No native browser is controlled by these tests.

To roll back packaging changes, revert the guardrail scripts/docs and the small
configuration/handoff-list changes through review. The user can unload the local
staging extension or rebuild a previously reviewed compatible staging revision.
Keep the production Store item unchanged during setup. A later production Store
incident needs its own supported-version/roll-forward decision; this setup does
not promise an instant Store rollback.
