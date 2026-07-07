# Installing Minted Panel Workbench (one-time setup)

This extension is **not on the Chrome Web Store** — it's built from source and
loaded "unpacked" from a folder. Setup has two halves, done once:

1. **Terminal** — download the code into `Desktop/cowork/minted-extension` and
   build it into a `dist/` folder.
2. **Chrome** — load that `dist/` folder as an unpacked extension, then sign in.

Steps are marked **[TERMINAL]** or **[CHROME]**.

> **Why paste raw commands instead of running a script?** `install.sh` lives
> *inside* the repo, so it can't exist on your machine until you've already
> downloaded the repo — and this repo is private, so it can't be fetched without
> signing in. The block below is self-contained: it needs no pre-existing file.

---

## Before you start

- **Git** — macOS: `xcode-select --install` · Windows: <https://git-scm.com>
- **Node.js 20 or newer** (includes npm) — <https://nodejs.org> (the "LTS" build).
  Check with `node -v`.
- **GitHub access** to the private repo `sonny303/minted-extension`. When git
  asks you to sign in during download, use a GitHub account that has access.

---

## Step 1 — Terminal

### macOS / Linux
**[TERMINAL]** Open Terminal and paste the whole block:

```sh
mkdir -p ~/Desktop/cowork && cd ~/Desktop/cowork
rm -rf minted-extension
git clone https://github.com/sonny303/minted-extension.git
cd minted-extension
npm ci
npm run build
```

### Windows
**[TERMINAL]** Open **PowerShell** and paste the whole block:

```powershell
New-Item -ItemType Directory -Force $HOME\Desktop\cowork | Out-Null
cd $HOME\Desktop\cowork
if (Test-Path minted-extension) { Remove-Item -Recurse -Force minted-extension }
git clone https://github.com/sonny303/minted-extension.git
cd minted-extension
npm ci
npm run build
```

`rm -rf` / `Remove-Item` just clears the empty placeholder folder so the download
lands cleanly — safe because it's empty. When it finishes, the folder Chrome
loads is **`Desktop/cowork/minted-extension/dist`**.

> Already have the repo and just want to rebuild? From inside
> `Desktop/cowork/minted-extension`, run `./install.sh` (macOS/Linux) or
> `.\install.ps1` (Windows) — they pull the latest and rebuild `dist/`.

---

## Step 2 — Chrome

**[CHROME]**

1. Open a new tab and go to **`chrome://extensions`**.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select the **`dist`** folder at `Desktop/cowork/minted-extension/dist` → **Open**.
5. The "Minted Panel Workbench" card appears — pin it if you like.
6. Click the **Minted Panel Workbench toolbar icon** (puzzle-piece menu → Minted
   Panel Workbench) to open the side panel, then **sign in** with your Minted
   Panel email + password.

Done. To use it: open a supported payer portal, open the side panel, pick the
provider / location / case, and click **Fill this page**.

---

## If something goes wrong

- **`chmod: install.sh: No such file or directory`** — you're trying to run the
  script before downloading the repo (or in an empty folder). Use the paste
  block in Step 1 instead; it does the download for you.
- **Download asks for a password / "repository not found"** — the repo is
  private. Sign in with a GitHub account that has access, or ask the owner.
- **`npm ci` or `npm run build` fails** — confirm Node 20+ (`node -v`). If it
  still fails, delete the `node_modules` folder and re-run `npm ci`.
- **Extension loads but sign-in / data fails** — the extension's Chrome ID
  (shown on its `chrome://extensions` card) must be added to the API's
  `API_CORS_ORIGINS` on the Vercel backend as `chrome-extension://<that-id>`.
  This is a **one-time owner task** (see `README.md`), and the new user can't do
  it themselves.
- **"No portal detected"** — normal on any page that isn't a supported payer
  portal. Go to the portal form first.
