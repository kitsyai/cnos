#!/bin/bash
# setup-agent-links.sh
# Run once from repo root to create vendor entry point symlinks.

set -e

# Claude Code
ln -sf .agents/AGENTS.md CLAUDE.md

# Codex / generic
ln -sf .agents/AGENTS.md AGENTS.md

# GitHub Copilot (if used)
mkdir -p .github
ln -sf ../.agents/AGENTS.md .github/copilot-instructions.md

echo "Agent symlinks created: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md"
echo "All point to .agents/AGENTS.md"
