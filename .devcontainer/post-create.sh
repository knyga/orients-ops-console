#!/usr/bin/env bash
# Runs once after the devcontainer is created.
set -euo pipefail

echo "[post-create] node: $(node --version)  npm: $(npm --version)"

# Install the Claude Code CLI globally (dev convenience; harmless if unused).
npm install -g @anthropic-ai/claude-code || echo "[post-create] claude-code install skipped"

# Install project deps only if the app has already been scaffolded.
if [ -f package.json ]; then
  echo "[post-create] package.json found, installing deps"
  npm install
else
  echo "[post-create] no package.json yet; skipping npm install (app not scaffolded)"
fi

echo "[post-create] done"
