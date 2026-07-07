# Minted Panel Workbench - setup / rebuild helper (Windows / PowerShell)
# -----------------------------------------------------------------
# Downloads (or updates) the extension in Desktop\cowork\minted-extension and
# builds the loadable version into dist\.
#
# FIRST-TIME SETUP: this script lives inside the repo, so it can't be run before
# the repo is downloaded. For a brand-new machine, use the self-contained paste
# block in INSTALL.md (Step 1) instead. This script is for rebuilding once you
# already have the repo, and it is safe to run in an empty target folder too.
#
# This script is the TERMINAL half. After it finishes, load dist\ into Chrome
# using the steps it prints at the end (also in INSTALL.md).
#
# If you get a script-execution error, run this once first:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/sonny303/minted-extension.git"
$DestDir = Join-Path ([Environment]::GetFolderPath("Desktop")) "cowork\minted-extension"

function Say ($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Die ($m) { Write-Host "`nXX  $m" -ForegroundColor Red; exit 1 }

# --- 1. Prerequisites ---
Say "Checking prerequisites (git, node, npm)"
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Die "git is not installed. Install from https://git-scm.com, then re-run." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is not installed. Install Node 20+ from https://nodejs.org, then re-run." }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Die "npm is not installed (comes with Node.js). Install Node 20+, then re-run." }

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Die "Node 20+ is required (found $(node -v)). Upgrade at https://nodejs.org, then re-run." }
Say "git, node $(node -v), npm $(npm -v) - OK"

# --- 2. Download (or update) ---
Write-Host "    (private repo - if prompted, sign in to a GitHub account with access)"
if (Test-Path (Join-Path $DestDir ".git")) {
  Say "Folder already has the code - pulling the latest into $DestDir"
  git -C $DestDir pull --ff-only
} else {
  # Not a clone yet. Allow an empty / placeholder folder (ignore junk files),
  # but never clobber a folder with real contents.
  if (Test-Path $DestDir) {
    $junk = @('.DS_Store', 'desktop.ini', 'Thumbs.db')
    $real = Get-ChildItem -Force $DestDir | Where-Object { $junk -notcontains $_.Name }
    if ($real) { Die "$DestDir isn't empty and isn't a clone of this repo. Move/rename it, then re-run." }
  }
  Say "Downloading into $DestDir"
  if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
  New-Item -ItemType Directory -Force -Path (Split-Path $DestDir) | Out-Null
  git clone $RepoUrl $DestDir
}

# --- 3. Install deps + build ---
Set-Location $DestDir
Say "Installing dependencies (npm ci)"
npm ci

Say "Building the extension (npm run build)"
npm run build
if (-not (Test-Path (Join-Path $DestDir "dist"))) { Die "Build finished but dist\ is missing - check the output above." }

# --- 4. Done ---
Write-Host @"

============================================================
  Terminal part done. The loadable extension is at:

    $DestDir\dist

  NOW DO THIS IN CHROME (one time):
    1. Open           chrome://extensions
    2. Turn on        "Developer mode"  (top-right toggle)
    3. Click          "Load unpacked"
    4. Select the     dist  folder above  ->  Select Folder
    5. Click the Minted Panel Workbench toolbar icon to open the side panel,
       then sign in with your Minted Panel email + password.
============================================================

"@
