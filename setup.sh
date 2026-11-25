#!/usr/bin/env bash
# Quick Setup Script for macOS / Linux / WSL
# Run this script whenever you clone this project onto a new machine:
#   chmod +x setup.sh && ./setup.sh

set -e

echo "============================================================"
echo "🎛️  Agent Mission Control — Portable Setup (macOS/Linux/WSL)"
echo "============================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is required (>= 18). Please install Node.js first."
  exit 1
fi

echo "✅ Node.js detected: $(node -v)"
chmod +x ./bin/amc.js ./hooks/claude-hook.js

echo "🔗 Installing Claude Code Lifecycle Hooks into ~/.claude/settings.json ..."
node ./bin/amc.js install-hooks

echo "📦 Linking 'amc' CLI globally (optional)..."
npm link >/dev/null 2>&1 || true

echo ""
echo "🎉 Setup Complete! Run:"
echo "   npm start        (Launch Mission Control Dashboard at http://127.0.0.1:4310)"
echo "   npm run status   (Print live multi-room status in terminal)"
echo "============================================================"
