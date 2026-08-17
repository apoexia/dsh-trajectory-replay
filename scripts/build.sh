#!/bin/bash
# Build dsh-trajectory-replay: compile the host half with the dsh checkout's
# tsc; the client half is built separately by tsdown (npm run build:client).
# Requires DSH_CHECKOUT pointing at a dsh source checkout (for tsc) and
# DSH_CORDIS_ROOT pointing at an installed @deepseek-ai tree (defaults to the
# checkout's own node_modules when present, else the npm npx cache).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

CORDIS_ROOT="${DSH_CORDIS_ROOT:-}"
if [ -z "$CORDIS_ROOT" ]; then
  if [ -d "$CHECKOUT/node_modules/@deepseek-ai" ]; then
    CORDIS_ROOT="$CHECKOUT/node_modules/@deepseek-ai"
  else
    CORDIS_ROOT="$(node -e "const c=require('node:child_process');const p=c.execSync('npm config get cache').toString().trim();const fs=require('node:fs');const path=require('node:path');const base=path.join(p,'_npx');let hit='';for(const d of fs.readdirSync(base)){const cand=path.join(base,d,'node_modules','@deepseek-ai');if(fs.existsSync(path.join(cand,'cordis','lib','types','index.d.ts'))){hit=cand;break}}console.log(hit)")"
  fi
fi
if [ -z "$CORDIS_ROOT" ] || [ ! -d "$CORDIS_ROOT/cordis" ]; then
  echo "build: cannot locate an installed @deepseek-ai tree (set DSH_CORDIS_ROOT)" >&2
  exit 1
fi

link_pkg() {
  local target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (cordis root: $CORDIS_ROOT) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg cordis "$CORDIS_ROOT/cordis"
link_pkg cosmokit "$CORDIS_ROOT/cosmokit"
link_pkg schemastery "$CORDIS_ROOT/schemastery"

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null
