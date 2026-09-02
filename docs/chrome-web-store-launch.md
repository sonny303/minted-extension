# Chrome Web Store launch — trusted testers

Everything I could do from code is done. Everything left lives in the Chrome
Web Store Developer Dashboard, which only you can access. This doc is the
script for that part.

## Status

| Item | State |
| --- | --- |
| Tests / lint / typecheck | 426 tests, lint, typecheck — all green |
| npm audit | 0 vulnerabilities (fixed 3 high, all dev-tooling, none shipped in the bundle) |
| Version | bumped `0.1.0` → `1.0.0` (manifest + package.json) |
| Build | `dist/` builds clean, verified locally |
| Upload package | `minted-panel-workbench-1.0.0.zip` — sent to you separately |
| Distribution | Private → **Trusted testers** (your call — not publicly listed) |
| Privacy policy | you said you already have one — paste its URL into the dashboard (see step 4) |

## Steps (dashboard side, in order)

1. **Open the dashboard** — [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole). Your $5 registration is already paid, so you should land straight on "New item."
2. **Upload** `minted-panel-workbench-1.0.0.zip`.
3. **Store listing tab** — paste the draft copy below.
4. **Privacy practices tab** — paste the permission justifications and data-use answers below, and drop in your privacy policy URL.
5. **Distribution tab** — set visibility to **Private**, choose **Trusted testers**, and add the Google account emails (personal Gmail or Workspace) for everyone who should get it. I don't have this list — it's yours to gather (limit is 20 accounts).
6. **Submit for review.** Private/trusted-tester items still go through Google's review — it's not a bypass, just a visibility restriction. Turnaround is usually hours to a few days.
7. **After approval — do this immediately, testers are blocked until you do:** the store assigns a *new* extension ID, different from your unpacked dev ID. Add `chrome-extension://<new-id>` to `API_CORS_ORIGINS` on the panel's Vercel project (same one-time step `README.md` already documents for the dev ID).

## The one thing likely to get flagged in review

`optional_host_permissions: ["https://*/*"]`. This is the broadest permission
pattern Chrome has, and reviewers scrutinize it hard — even for a
trusted-testers item, and more so alongside health-adjacent data (NPI, DOB,
SSN last 4, license numbers). It's declared *optional*, so the manifest
grants nothing on install; the extension only ever calls
`chrome.permissions.request()` for one specific portal origin the registry
names, and the user sees that exact origin in the prompt. Say that plainly in
the justification field below — reviewers reject vague "we might need any
site" answers, not narrow, specific ones.

## Draft store listing copy

- **Title:** Minted Panel Workbench
- **Summary** (132 char max): `One-click payer portal form fill from Minted Panel provider data, with the fill logged back to the case.`
- **Category:** Productivity
- **Description:**
  > Minted Panel Workbench fills payer-portal enrollment forms with provider
  > data pulled from Minted Panel, in one click — instead of retyping the
  > same provider details into dozens of portals by hand.
  >
  > Sign in with your Minted Panel account, pick the provider, location, and
  > case you're working, and click Fill this page on a supported payer
  > portal. The extension fills what it can, tells you exactly what it
  > skipped and why, and logs the fill to the case. You still review and
  > submit the form yourself — the extension never submits on your behalf.
  >
  > Requires an active Minted Panel account. Built for credentialing teams
  > using Minted Panel.

## Permission justifications (paste into Privacy practices tab)

| Permission | Justification |
| --- | --- |
| `storage` | Holds the signed-in session (`chrome.storage.session`, cleared when the browser closes) and the user's saved quick-card layout. Provider and patient field values are never written to storage — they live in memory only, for the current tab session. |
| `activeTab` | Reads the active tab's URL to detect whether it's a recognized payer portal, and scopes the fill/capture script to the tab the user is actively working in. |
| `sidePanel` | The extension's entire UI is a Chrome side panel — there is no popup. Required to open and control it. |
| `scripting` | Injects the content script that fills form fields and reports results, on demand, only on tabs where the user has granted that specific portal's origin (see host permissions). Never injected proactively. |
| `host_permissions` (mintedpanel.vercel.app, Supabase project URL) | The extension's own backend: the API that holds provider data, and the auth provider that issues sign-in tokens. Required for sign-in, provider lookup, fill data, and activity logging — every feature the extension has. |
| `optional_host_permissions: https://*/*` | Declared optional so the extension can request access to one specific payer-portal domain at a time, on user action, via `chrome.permissions.request()`. The manifest grants no site access on install. Each origin requested is named individually and shown to the user in the permission prompt, and is limited to portals in the extension's own registry of supported payer sites — this lets a new payer portal ship as a data change, not a new extension version with a hardcoded host list. |
| `externally_connectable` (mintedpanel.vercel.app) | Lets the Minted Panel web app hand a specific case to the extension (case id, provider id, portal URL only — never patient data or auth tokens) when a coordinator clicks "Work in portal." Restricted to that one app origin in the manifest, and re-checked again in the background worker. |

## Data usage disclosures

I drafted these from what the code actually does — you're the one who signs
the certification, so read them as a starting point, not gospel:

- **What user data does this extension collect?** Personally identifiable
  information (name, NPI, license numbers) and Health information (the
  extension reads provider profile fields used in credentialing, including
  fields the Store's own taxonomy treats as health-related). Authentication
  information (your Minted Panel sign-in session).
- **Is data sold to third parties?** No.
- **Is data used for purposes unrelated to the item's core functionality?**
  No — everything read is used only to fill the form you're looking at and
  log that fill to the case.
- **Is data used to determine creditworthiness or for lending?** No.
- **Privacy policy URL:** `[ADD YOUR URL HERE]` — you said one already
  exists; paste it in and it satisfies the requirement (mandatory here since
  the extension handles PII/health data and requests host permissions).

## Loose end worth planning, not doing today

Once the store listing is live, `INSTALL.md`'s git-clone-and-build flow is
harder than it needs to be for trusted testers — the Store gives them a
one-click "Add to Chrome" instead. Worth rewriting once you have the listing
URL. Flagging it now so it doesn't get lost; not written yet because there's
no URL to write it against.
