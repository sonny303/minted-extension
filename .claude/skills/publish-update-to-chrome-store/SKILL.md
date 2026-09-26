---
name: publish-update-to-chrome-store
description: >-
  Repeatable procedure to package, verify, and publish updates to the Chrome Web Store
  for Minted Panel Workbench upon completing a deployment to main. Use whenever releasing a
  new extension version, synchronizing backend CORS on Vercel, or uploading an update to the
  Chrome Developer Console.
---

# Publish Update to Chrome Web Store

This skill provides a standardized, verified workflow for deploying updates to the **Minted Panel Workbench** Chrome Extension (`dppfnbikpojpgdiobckgcknmkjlfoinh`) after merging changes into `main`.

---

## Quick Reference Constants

| Resource                  | Value                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chrome Extension ID**   | `dppfnbikpojpgdiobckgcknmkjlfoinh`                                                                                                                                           |
| **Developer Console URL** | [CWS Dev Console — Minted Panel Workbench](https://chrome.google.com/webstore/devconsole/a3a3168e-c898-4404-985d-d230825fcf00/dppfnbikpojpgdiobckgcknmkjlfoinh/edit/package) |
| **Public Store Listing**  | [Minted Panel Workbench on Chrome Web Store](https://chromewebstore.google.com/detail/minted-panel-workbench/dppfnbikpojpgdiobckgcknmkjlfoinh?authuser=0&hl=en)              |
| **Vercel Project**        | `mintedpanel` (`prj_ILhPJbkyaiptdVA8DtsmNyw3tiub`) in team `team_230fpJ9MgCj9ssW3LiIckfyA`                                                                                   |
| **Canonical Web Host**    | `https://mintedpanel.com` (`www` redirects to apex)                                                                                                                          |
| **Packaging Helper**      | [`scripts/package-extension.sh`](scripts/package-extension.sh)                                                                                                               |

---

## Release Procedure

Follow these phases sequentially:

### Phase 1: Working Tree & Sync Check

Ensure you are operating against the latest code on `main` in the `minted-extension` directory:

```bash
# In the minted-extension repository:
git checkout main
git pull origin main
git status -s
```

### Phase 2: Version Bump & Manifest Invariants

The Chrome Web Store **strictly rejects re-uploading an existing version**.

1. **Increment Version:**
   Bump the version in **BOTH** files:
   - [`package.json`](package.json): `"version": "x.y.z"`
   - [`public/manifest.json`](public/manifest.json): `"version": "x.y.z"`
2. **Verify Manifest Invariants:**
   - `"manifest_version": 3`
   - `externally_connectable.matches` must include:
     - `"https://mintedpanel.com/*"`
     - `"https://mintedpanel.vercel.app/*"`
   - `host_permissions` must include:
     - `"https://mintedpanel.com/*"`
     - `"https://mintedpanel.vercel.app/*"`
     - `"https://fkvuhfsqcmujywzgczmc.supabase.co/*"`
   - `icons` must refer only to real PNG files matching their declared pixel dimensions (`icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`).

### Phase 3: Run Validation & Contract Tests

Run the test suite to ensure that neither unit tests nor release contracts are broken:

```bash
npm test
npm run typecheck
```

_Note:_ The contract test suite [`scripts/release/contract.test.mjs`](scripts/release/contract.test.mjs) verifies that environment targets and manifest boundaries match the release specification.

### Phase 4: Clean Manifest V3 Packaging

> [!IMPORTANT]
> The ZIP package must contain `manifest.json` at the **root of the archive**, never nested inside a `dist/` subfolder.
> All macOS metadata files (`__MACOSX`, `.DS_Store`) must be excluded, or CWS automated intake may reject the upload.

Run the helper script:

```bash
./scripts/package-extension.sh
```

Or run manually:

```bash
npm run build
cd dist && zip -qr "../minted-panel-workbench-v$(node -p "require('./manifest.json').version").zip" . -x '.*' -x '__MACOSX*'
```

Verify archive structure:

```bash
unzip -l ../minted-panel-workbench-v*.zip | grep " manifest.json$"
```

### Phase 5: Backend Vercel CORS & Extension ID Sync

Whenever releasing an extension, confirm that the Vercel backend permits requests from the published extension ID:

1. **CORS Allowlist (`API_CORS_ORIGINS`):**
   Must include `chrome-extension://dppfnbikpojpgdiobckgcknmkjlfoinh` along with `https://mintedpanel.com`, `https://www.mintedpanel.com`, and `https://mintedpanel.vercel.app`.
2. **Extension ID Variable (`VITE_MINTED_EXTENSION_ID`):**
   Must be set to `dppfnbikpojpgdiobckgcknmkjlfoinh` for Preview and Production.
3. **Redeploy Vercel:**
   If environment variables were modified, trigger a production redeployment so API preflight (`OPTIONS`) requests receive the proper `Access-Control-Allow-Origin` header.

### Phase 6: Chrome Web Store Upload & Submission

Use `/browser` or the Chrome Web Store Developer Console:

1. Open the **Package** tab:
   `https://chrome.google.com/webstore/devconsole/a3a3168e-c898-4404-985d-d230825fcf00/dppfnbikpojpgdiobckgcknmkjlfoinh/edit/package`
2. Click **"Upload new package"** and supply `minted-panel-workbench-v<version>.zip`.
3. Wait for package processing and ensure the new version is recognized with 0 validation errors.
4. Open the **Distribution** tab:
   - Ensure visibility is set to **Unlisted** (recommended for organizational tools) or **Public**.
5. Click **"Submit for review"**:
   - Enable **automatic publishing** upon approval.
   - Enter concise review notes describing changes (e.g., _"Bug fixes, case handoff performance enhancements, and domain alignment"_).

### Phase 7: Post-Submission Verification

1. Ensure the item status transitions to **Pending review**.
2. Once approved, verify the update by loading the unlisted store link or updating the extension in `chrome://extensions/` with Developer Mode enabled.
3. Commit and push any bumped version files back to `main`:
   ```bash
   git add package.json public/manifest.json scripts/release/contract.test.mjs
   git commit -m "chore: release v<version>"
   git push origin main
   ```
