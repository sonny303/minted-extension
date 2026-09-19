# P06 extension handoff work order

Status: review corrections and required local checks complete; independent
review and final-head CI remain pending. Installed Chrome acceptance remains
**PARTIAL/BLOCKED** until every H10 prerequisite and scenario is evidenced.

## Contract and ownership

| Item | Binding requirement |
| --- | --- |
| Base | `8558b4ce362b622186dc018c56b3d4238dc891af` (`main`) |
| Branch | `cursor/3m-p06-extension-handoff-6f36` |
| Web wire | Unchanged `{ type: "SET_ACTIVE_CASE", caseId, providerId, orgId, portalUrl, portalKey?, facilityId? }` |
| Receipt | Only `{ ok: true }` means the validated context was stored. It does not mean signed in, authorized, applied, filled, or opened. |
| Application | Requires the current receipt, authenticated member org, exact provider and case, successful required reads, and a strict explicit facility when supplied. |
| Writes | `chrome.storage.session` only: active case, mode, applied-receipt marker, and existing selection keys. No API write is added. |
| Reads | Existing extension-owned `/api/me/orgs`, `/api/providers`, `/api/cases?providerId=`, `/api/cases/:id/context`, and `/api/providers/:id/profile` paths. No direct table access. |
| Return | Read-only link to `${VITE_API_BASE_URL}/cases/:caseId` after application succeeds. It creates no touch and changes no task or case state. |

## Callers and state boundaries

| Surface | Responsibility |
| --- | --- |
| `src/shared/handoff.ts` | Strict wire parser, backward-compatible stored record, receipt identity, expiry/origin rules. |
| `src/background/activeCase.ts` | External receiver, serialized active-case mutations, truthful reply, portal-tab binding and restart reconciliation. |
| `src/background/index.ts` | Auth, account and org clearing; explicit member-org switch preserves the matching handoff record and its metadata. |
| `src/shared/handoffApplication.ts` | Pure decision rules for receipt, org, provider, case, required-read and explicit-facility truth. |
| `src/sidepanel/main.ts` | Authenticated reads, discriminated selection result, applied provenance, fill gate and exact return link. |
| `src/harness/chromeStub.ts` | Deterministic storage/tab failure and race controls for local tests only. |

`chrome.storage.session` survives MV3 worker restarts but dies with the browser.
Legacy active-case records without the new internal receipt identity remain readable.
The internal identity is never accepted from or returned on the web wire.

## H1-H10 acceptance map

| Requirement | P06 evidence / boundary |
| --- | --- |
| H1 intended extension | P05 owns addressed sending. P06 keeps manifest/runtime origin checks and verifies the unchanged accepted shape. |
| H2 truthful receipt | Worker-stub tests cover accepted, rejected, malformed, rejected atomic record/mode persistence, prior-state preservation and exactly-once `{ok:false}` reply. `{ok:true}` remains receipt-only. Installed receipt behavior is not evidenced here. |
| H3 gesture and recovery | P05 owns the original click and direct link. P06 worker-stub tests cover portal-tab update racing receipt persistence, sender-window active-target recovery, and nonblocking best-effort side-panel opening. No mounted or installed gesture claim is made. |
| H4 complete context | Parser and receiver tests cover real UUIDs, HTTPS, optional omission/drop behavior, portal key and explicit secondary facility preservation. No profile/token/secret fields persist. |
| H5 mounted workflow | P05 owns mounted drawer coverage. P06 source/unit compatibility tests use the settled sanitized wire fixture without adding a second launcher. |
| H6 authenticated application | Source logic keeps a signed-out receipt pending. Pure evaluator and worker-stub tests cover nonmember rejection, explicit member-org switch, provider/case/read failures, explicit unavailable facility rejection, and worker/UI denial of structured-touch writes before application. Signed-out and authenticated installed behavior remains H10 evidence. |
| H7 recovery | Org switching preserves the full handoff source/portal/facility record. Failed receipts preserve the prior valid context. Explicit facility never falls back to primary. Malformed optional fields retain base receipt compatibility. |
| H8 stale results | Worker-stub tests cover delayed A/newer B, the clear primitive used by logout/org/account paths, stale commit/rejection/org-switch completion, tab activity/removal, pre-receipt portal navigation, simulated restart reconciliation and existing expiry behavior. Source/pure tests pin pre-gate write deferral, final receipt rechecks, and the exact committed provider/case/facility tuple used for provenance, Fill, and case-work readiness. Installed restart behavior remains H10 evidence. Same-origin onUpdated ambiguity remains a documented residual. |
| H9 same-case return | A pure URL test and side-panel source assertion cover exact configured environment/case, gated after application, with no added API write. Mounted and installed UI behavior remains H10 evidence. |
| H10 installed journey | Required installed synthetic and hosted-staging matrix remains BLOCKED pending a qualified staging runtime/schema, owned fixtures, exact installed ID/config/CORS/origin alignment and worker API access. Unit, harness, build or CI evidence does not pass H10. |

## Required verification

1. Focused pure handoff/application tests.
2. Worker harness receipt, lifecycle, auth/context and facility regressions.
3. `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`.
4. Independent diff/auth review and final-head CI on the draft PR.
5. Installed `build:staging` journey using
   `release-artifacts/staging/extension`, with web SHA/deployment, extension
   SHA/package digests, installed ID, Chrome version/time, both-end context,
   return result and evidence layer per H10 scenario.

No merge, deployment, hosted mutation, production substitution, Store action,
portal submission, dependency, manifest expansion or unrelated race work is in
this work order.
