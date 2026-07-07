#!/usr/bin/env bash
#
# Minted Panel Workbench — setup / rebuild helper (macOS / Linux)
# ----------------------------------------------------------
# Downloads (or updates) the extension in Desktop/cowork/minted-extension and
# builds the loadable version into dist/.
#
# FIRST-TIME SETUP: this script lives inside the repo, so it can't be run before
# the repo is downloaded. For a brand-new machine, use the self-contained paste
# block in INSTALL.md (Step 1) instead. This script is for rebuilding once you
# already have the repo, and it is safe to run in an empty target folder too.
#
# This script is the TERMINAL half. After it finishes, load dist/ into Chrome
# using the steps it prints at the end (also in INSTALL.md).
#
set -euo pipefail

REPO_URL="https://github.com/sonny303/minted-extension.git"
DEST_DIR="$HOME/Desktop/cowork/minted-extension"

say()  { printf "\n\033[1;32m==>\033[0m %s\n" "$1"; }
die()  { printf "\n\033[1;31mXX\033[0m  %s\n" "$1" >&2; exit 1; }

# --- 1. Prerequisites -------------------------------------------------------
say "Checking prerequisites (git, node, npm)"
command -v git  >/dev/null 2>&1 || die "git is not installed. Install it, then re-run.  macOS: 'xcode-select --install'  |  Linux: your package manager."
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 20+ from https://nodejs.org, then re-run."
command -v npm  >/dev/null 2>&1 || die "npm is not installed (comes with Node.js). Install Node 20+, then re-run."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ is required (found $(node -v)). Upgrade at https://nodejs.org, then re-run."
say "git $(git --version | awk '{print $3}'), node $(node -v), npm $(npm -v) — OK"

# --- 2. Download (or update) ------------------------------------------------
printf "    (private repo — if prompted, sign in to a GitHub account with access)\n"
if [ -d "$DEST_DIR/.git" ]; then
  say "Folder already has the code — pulling the latest into $DEST_DIR"
  git -C "$DEST_DIR" pull --ff-only
else
  # Not a clone yet. Allow an empty / placeholder folder (Finder leaves a
  # .DS_Store), but never clobber a folder with real contents.
  if [ -d "$DEST_DIR" ] && [ -n "$(find "$DEST_DIR" -mindepth 1 ! -name '.DS_Store' -print -quit)" ]; then
    die "$DEST_DIR isn't empty and isn't a clone of this repo. Move/rename it, then re-run."
  fi
  say "Downloading into $DEST_DIR"
  rm -rf "$DEST_DIR"
  mkdir -p "$(dirname "$DEST_DIR")"
  git clone "$REPO_URL" "$DEST_DIR"
fi

# --- 3. Install deps + build ------------------------------------------------
cd "$DEST_DIR"
say "Installing dependencies (npm ci)"
npm ci

say "Building the extension (npm run build)"
npm run build
[ -d "$DEST_DIR/dist" ] || die "Build finished but dist/ is missing — check the output above."

# --- 4. Done — tell them the Chrome half ------------------------------------
cat <<EOF

============================================================
  Terminal part done. The loadable extension is at:

    $DEST_DIR/dist

  NOW DO THIS IN CHROME (one time):
    1. Open           chrome://extensions
    2. Turn on        "Developer mode"  (top-right toggle)
    3. Click          "Load unpacked"
    4. Select the     dist  folder above  ->  Open
    5. Click the Minted Panel Workbench toolbar icon to open the side panel,
       then sign in with your Minted Panel email + password.
============================================================

EOF
