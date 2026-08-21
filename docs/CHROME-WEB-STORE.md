# Chrome Web Store submission

Everything needed to publish **Minted Panel Workbench**, plus the parts only a
human with the developer account can do. Rebuild the package with
`npm run build` and zip `dist/` (see [Packaging](#packaging)).

---

## Publish it UNLISTED, not Public

This is business software for Minted Panel customers' credentialing staff. It
is useless without a Minted Panel account, and its whole surface is one
organization's provider data.

**Unlisted** means: anyone with the link can install, it does not appear in
search or category browsing, and review is materially simpler because the
listing is not making a claim to the general public. Public visibility buys
nothing here and invites review questions about why a general-audience
extension reads payer portals.

Set this under **Store listing → Visibility → Unlisted** before the first
submit. It can be changed later.

---

## Why this extension needs the permissions it asks for

Reviewers read these against the manifest. Every line below is checkable in
the code — do not soften them, and do not add a permission without adding its
row here.

| Permission                                              | Why                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                               | Remembers the signed-in user's quick-card layout and the in-progress form-training session. No form values are ever stored (`src/shared/capture.ts` header comment).                                                                  |
| `activeTab`                                             | Lets the panel see whether the tab the user is _looking at_ is a payer portal we recognize, without standing access to the page.                                                                                                      |
| `sidePanel`                                             | The entire UI is a Chrome side panel.                                                                                                                                                                                                 |
| `scripting`                                             | Injects the content script into a payer portal the user has granted access to, when there is no static match (`src/background/inject.ts`). This is what lets one build serve many payer portals instead of shipping a hardcoded list. |
| `host_permissions` → `mintedpanel.vercel.app`           | The extension's own backend. All provider data comes from here.                                                                                                                                                                       |
| `host_permissions` → `fkvuhfsqcmujywzgczmc.supabase.co` | Sign-in only. Supabase issues the JWT; the extension never queries database tables and never holds a service key.                                                                                                                     |
| `host_permissions` → `provider.bcbsks.com`              | The one payer portal shipped with static access, so the first-run experience needs no permission prompt.                                                                                                                              |
| `optional_host_permissions` → `https://*/*`             | **Read the note below — this is the line most likely to draw a review question.**                                                                                                                                                     |

### The `https://*/*` optional permission, explained

**It is optional, and it is never requested as a wildcard.**

Minted Panel supports many insurance payer portals, and which ones an
organization uses is data in our backend, not a constant we can compile in. A
static `content_scripts` list would mean shipping a new extension version every
time a customer starts working with a new payer.

So the extension declares the broad pattern as **optional** and then requests
only specific origins at runtime:

- `portalOriginPatterns` (`src/shared/portals.ts`) turns the portal registry
  rows into concrete `https://host/*` patterns — one per registered payer
  portal.
- `chrome.permissions.request({ origins })` is called with **that specific
  list**, inside a user gesture, from the panel's "Grant access" prompt
  (`src/sidepanel/main.ts`, `#portal-access`).
- The literal string `https://*/*` is never passed to
  `chrome.permissions.request`. Grepping the source for it finds only the
  manifest.

The user therefore sees Chrome's own permission prompt naming the actual payer
portal, and can decline. Nothing is read from any site the user has not
approved.

**Suggested wording for the "Permission justification" fields in the dashboard**
(paste, do not paraphrase — these match the code):

> **scripting:** Injects our content script into the payer enrollment form the
> user is working on, after the user has granted access to that specific site.
> Used to fill form fields with the user's own organization's provider data.
>
> **Host permissions:** The extension fills insurance payer enrollment forms.
> The list of supported payer portals lives in our backend because it differs
> per customer and changes without an extension release, so the broad pattern
> is declared as an _optional_ permission and specific portal origins are
> requested individually at runtime via `chrome.permissions.request`, in
> response to a user click. The extension never requests `https://*/*` itself.
>
> **Remote code:** None. All code is bundled in the package. No `eval`, no
> remotely-loaded scripts, no CDN. Fonts are self-hosted in the package.

---

## Data-use disclosures

The dashboard's **Privacy practices** tab asks you to check what the extension
collects. Answer:

| Category                            | Collected? | Note                                                                                                                                                                            |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information | **Yes**    | Provider names, professional identifiers (NPI/CAQH/license), dates of birth, addresses. This is the user's own organization's business data, entered by them into Minted Panel. |
| Health information                  | **No**     | Provider _credentialing_ records, not patient records. No patient medical data exists anywhere in the product.                                                                  |
| Financial and payment information   | **No**     |                                                                                                                                                                                 |
| Authentication information          | **Yes**    | Email + password are sent to Supabase to obtain a session token.                                                                                                                |
| Personal communications             | **No**     |                                                                                                                                                                                 |
| Location                            | **No**     |                                                                                                                                                                                 |
| Web history                         | **No**     |                                                                                                                                                                                 |
| User activity                       | **No**     | We log which forms _our own product_ filled, to the user's own audit trail. We do not track browsing.                                                                           |
| Website content                     | **No**     | Training reads a payer form's _structure_ (field names/types/layout), never the values in fields.                                                                               |

Then check all three certification boxes — they are all true:

- Not being sold to third parties ✓
- Not being used for purposes unrelated to the item's core functionality ✓
- Not being used to determine creditworthiness or for lending ✓

**Privacy policy URL:** `https://mintedpanel.vercel.app/privacy`
(source of truth: `mintedpanel/docs/privacy-policy.md`; the route mirrors it).

---

## Listing copy

**Name:** Minted Panel Workbench

**Short description** (132 char max):

> Fill payer enrollment forms with your organization's provider data from
> Minted Panel — one click, no retyping, full audit trail.

**Detailed description:**

> Minted Panel Workbench is for credentialing staff at healthcare
> organizations that use Minted Panel.
>
> Credentialing a provider means entering the same forty facts — NPI, CAQH ID,
> license numbers, taxonomy, practice addresses — into one insurance payer's
> enrollment portal after another. This extension fills those forms from the
> provider record you already maintain in Minted Panel.
>
> **How it works**
>
> - Sign in with your Minted Panel account and open the side panel.
> - Pick the provider and the case you are working.
> - Open the payer's enrollment form and click Fill.
> - Review what was filled, correct anything the payer wants differently, and
>   submit the form yourself.
>
> **What it does not do**
>
> - It never submits a form. Every application is reviewed and submitted by a
>   person.
> - It does not read what you type on web pages, and does not track browsing.
> - It only works on insurance payer portals your organization has set up, and
>   asks for access to each one individually.
>
> **Requires a Minted Panel account.** The extension has no standalone
> functionality.

**Category:** Workflow & Planning
**Language:** English

---

## Screenshots

Three states are generated from the built panel against synthetic fixture data
(no real organization, provider, or payer names) at the store's 1280×800 size.
The generator lives outside the repo — see the session scratchpad
`gen-store-shots.mjs` — and drives `dist/` in a real browser.

Submit **01-search** and **02-provider-quickcards**. The Train-forms capture
state is deliberately _not_ submitted: it is an admin-only internal tool and
the densest, least legible screen in the product.

At least one screenshot is required; 1280×800 is the size to use.

---

## Packaging

```sh
npm ci
npm run build
cd dist && zip -qr ../minted-panel-workbench-v$(node -p "require('./manifest.json').version").zip . -x '.*'
```

The zip must have `manifest.json` at its **root**, not inside a folder — the
`cd dist` above is what guarantees that. Current package: 21 files, ~195 KB, no
source maps.

**Bump `version` in BOTH `public/manifest.json` and `package.json` before every
upload.** The Web Store rejects a re-upload at an existing version, and the two
files drifting apart makes it impossible to tell later which source built a
published package.

---

## Human-only steps, in order

These need the developer account and cannot be done from a coding session.

1. **Register the developer account** at
   <https://chrome.google.com/webstore/devconsole> — one-time US$5 fee.
2. **Verify a contact email** on the account. Publishing is blocked until this
   is done, and the error message does not say so clearly.
3. **Upload the zip**, fill the listing from the copy above, set visibility to
   **Unlisted**, complete the Privacy practices tab, and submit.
4. **After it is approved, get the extension's permanent ID** from the
   dashboard.
5. **Add that ID to the API's CORS allowlist.** On the panel's Vercel project,
   `API_CORS_ORIGINS` must include `chrome-extension://<the-published-id>`.
   **Until this is done the published extension signs in and then fails every
   data call**, because the ID changes when the extension is packed — the
   unpacked-development ID that works today is not the published one. This is
   the single most likely launch-day failure.
6. Redeploy the panel so the new env var takes effect.
7. Install from the unlisted link and confirm one real fill end to end before
   sending the link to anyone.

---

## Known review risks, honestly

- **The broad optional host permission** is the one a reviewer is most likely
  to ask about. The justification above is accurate; the code backs it. If
  review pushes back, the fallback is to enumerate the currently-registered
  payer origins in `optional_host_permissions` explicitly and accept that
  adding a payer portal then requires an extension release.
- **`mintedpanel.vercel.app` is a `vercel.app` subdomain.** Reviewers
  occasionally treat these as less established than a custom domain. Moving the
  backend to a Minted Panel-owned domain before submitting would remove the
  question, and is worth doing anyway.
- **The extension is useless without an account**, which is allowed, but the
  listing must say so plainly (the description above does) or it reads as a
  broken install to a reviewer who cannot sign in.
