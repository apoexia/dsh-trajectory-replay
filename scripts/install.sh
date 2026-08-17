#!/usr/bin/env bash
# One-click install for @dsh-external/dsh-trajectory-replay.
#   builds host (tsc) + client (tsdown), then wires the bundle into a dsh
#   profile: node_modules junction + package.json link:/bundles entry +
#   official ui-trajectory disable. All steps are idempotent.
#
# Usage: bash scripts/install.sh [profile]   (profile defaults to "web")
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="@dsh-external/dsh-trajectory-replay"

echo "=== [1/3] build host (tsc) ==="
TSC="$ROOT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "install: tsc not found at $TSC — run 'npm install' first" >&2
  exit 1
fi
"$TSC" -p "$ROOT/tsconfig.json"

echo "=== [2/3] build client (tsdown) ==="
if [ -x "$ROOT/node_modules/.bin/tsdown" ]; then
  (cd "$ROOT" && "$ROOT/node_modules/.bin/tsdown")
else
  echo "install: tsdown not found — skipping client bundle (npm install first)" >&2
fi

echo "=== [3/3] wire into profile '$PROFILE' ==="
if [ ! -d "$PROFILE_DIR" ]; then
  echo "install: profile '$PROFILE' not found at $PROFILE_DIR" >&2
  exit 1
fi

node - "$ROOT" "$PROFILE_DIR" "$PKG" <<'NODE'
const fs = require('fs')
const path = require('path')
const [root, profileDir, pkg] = process.argv.slice(2)

// 1) node_modules junction -> plugin dir (re-point when dangling/wrong)
const linkDir = path.join(profileDir, 'node_modules', ...pkg.split('/'))
const linkTarget = root
let linked = false
try {
  const stat = fs.lstatSync(linkDir)
  if (stat.isSymbolicLink() || stat.isDirectory()) {
    if (fs.existsSync(linkDir)) {
      linked = true // healthy (or a real dir the harness manages)
    } else {
      fs.unlinkSync(linkDir) // dangling link -> recreate below
    }
  }
} catch { /* missing -> create below */ }
if (!linked) {
  fs.rmSync(linkDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(linkDir), { recursive: true })
  fs.symlinkSync(linkTarget, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`junction: ${linkDir} -> ${linkTarget}`)
} else {
  console.log(`junction ok: ${linkDir}`)
}

// 2) profile package.json: link: dependency + dsh.profile.bundles entry
const manifestPath = path.join(profileDir, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const target = linkTarget.replace(/\\/g, '/')
manifest.dependencies = manifest.dependencies ?? {}
if (manifest.dependencies[pkg] !== `link:${target}`) {
  manifest.dependencies[pkg] = `link:${target}`
  console.log(`dependency: ${pkg} -> link:${target}`)
}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []
if (!manifest.dsh.profile.bundles.includes(pkg)) {
  manifest.dsh.profile.bundles.push(pkg)
  console.log(`bundles += ${pkg}`)
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// 3) cordis.patch.yml: disable the official ui-trajectory entry (idempotent)
const block = `- id: ui-trajectory
  name: '@deepseek-ai/dsh-client-ui-trajectory'
  disabled: true`
const patchPath = path.join(profileDir, 'cordis.patch.yml')
let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
if (!patch.includes('id: ui-trajectory')) {
  const bareArray = /^\s*\[\s*\]\s*$/.test(patch)
  patch = bareArray || patch.trim() === ''
    ? block
    : patch.replace(/\s*$/, '\n') + '\n' + block + '\n'
  fs.writeFileSync(patchPath, patch)
  console.log('patch: disabled official ui-trajectory')
} else {
  console.log('patch ok: ui-trajectory already disabled')
}
NODE

echo "=== done ==="
echo "plugin built and wired into profile '$PROFILE' (takes effect after a dsh restart)."
echo "for the running harness without a restart: dev_inject_plugin <plugin dir>"
echo "refresh the browser page after loading."
