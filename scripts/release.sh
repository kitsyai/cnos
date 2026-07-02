#!/usr/bin/env bash
# release.sh — bump all runtimes, run checks, commit, push, and tag.
#
# Usage:
#   ./scripts/release.sh 1.12.4
#   ./scripts/release.sh --skip-tests 1.12.4
#   ./scripts/release.sh --no-tag 1.12.4   # commit+push only, tag separately

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── helpers ───────────────────────────────────────────────────────────────────

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  → $*"; }
step() { echo; echo "▸ $*"; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] <new-version>

Bumps all runtime versions, runs tests, commits, pushes to main, and tags.

Options:
  --skip-tests    Skip pnpm test (use when already verified on this branch)
  --no-tag        Push the version bump commit but do not create/push the tag
  -h, --help      Show this help

Examples:
  ./scripts/release.sh 1.12.4
  ./scripts/release.sh --skip-tests 1.12.4
  ./scripts/release.sh --no-tag 1.12.4
EOF
  exit 0
}

# ── args ──────────────────────────────────────────────────────────────────────

SKIP_TESTS=false
NO_TAG=false
NEW_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=true; shift ;;
    --no-tag)     NO_TAG=true;     shift ;;
    -h|--help)    usage ;;
    -*)           die "Unknown option: $1" ;;
    *)
      [[ -z "$NEW_VERSION" ]] || die "Unexpected argument: $1"
      NEW_VERSION="$1"; shift ;;
  esac
done

[[ -n "$NEW_VERSION" ]] || usage
[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "Version must be X.Y.Z (got: '$NEW_VERSION')"

# ── detect current version ────────────────────────────────────────────────────

OLD_VERSION=$(grep '"version"' packages/cnos/package.json \
  | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
[[ -n "$OLD_VERSION" ]] \
  || die "Could not detect current version from packages/cnos/package.json"
[[ "$OLD_VERSION" != "$NEW_VERSION" ]] \
  || die "Already at $NEW_VERSION — nothing to do"

echo
echo "Release: $OLD_VERSION → $NEW_VERSION"

# ── pre-flight ────────────────────────────────────────────────────────────────

step "Pre-flight checks"

BRANCH=$(git branch --show-current)
[[ "$BRANCH" == "main" ]] \
  || die "Must be on main (currently on '$BRANCH')"
info "Branch: main ✓"

[[ -z "$(git status --porcelain)" ]] \
  || die "Working tree is dirty — commit or stash changes first"
info "Working tree: clean ✓"

info "Fetching origin/main..."
git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[[ "$LOCAL" == "$REMOTE" ]] \
  || die "Local main is behind origin/main — run: git pull origin main"
info "Up to date with origin/main ✓"

# ── tests ─────────────────────────────────────────────────────────────────────

step "Tests"

if [[ "$SKIP_TESTS" == false ]]; then
  info "Running pnpm test..."
  pnpm test
  info "Tests passed ✓"

  info "Compiling Java (compile check)..."
  mvn --quiet --batch-mode --no-transfer-progress clean compile \
    -f packages/java/pom.xml \
    -Drevision="${OLD_VERSION}"
  info "Java compile ✓"

  info "Compiling Kotlin (compile check)..."
  mvn --quiet --batch-mode --no-transfer-progress clean compile \
    -f packages/kotlin/pom.xml \
    -Drevision="${OLD_VERSION}"
  info "Kotlin compile ✓"
else
  info "Skipped (--skip-tests)"
fi

# ── version bumps ─────────────────────────────────────────────────────────────

step "Bumping versions ($OLD_VERSION → $NEW_VERSION)"

OLD="$OLD_VERSION"
NEW="$NEW_VERSION"

# Node.js: version field + inter-package peer dep constraints
while IFS= read -r f; do
  sed -i "s/\"version\": \"${OLD}\"/\"version\": \"${NEW}\"/g" "$f"
  sed -i "s/\"\^${OLD}\"/\"\^${NEW}\"/g" "$f"
done < <(find packages -name "package.json" -not -path "*/node_modules/*")
info "Node.js ✓"

# Python: version + intra-monorepo dep lower-bounds
while IFS= read -r f; do
  sed -i "s/version = \"${OLD}\"/version = \"${NEW}\"/g" "$f"
  sed -i "s/kitsy-cnos>=${OLD}/kitsy-cnos>=${NEW}/g" "$f"
  sed -i "s/kitsy-cnos-gcp>=${OLD}/kitsy-cnos-gcp>=${NEW}/g" "$f"
done < <(find packages/python -name "pyproject.toml")
info "Python ✓"

# Rust: crate Cargo.toml files only (mindepth 2 skips the workspace Cargo.toml)
while IFS= read -r f; do
  sed -i "s/version = \"${OLD}\"/version = \"${NEW}\"/g" "$f"
done < <(find packages/rust -mindepth 2 -name "Cargo.toml" -not -path "*/target/*")
info "Rust ✓"

# Java + Kotlin: <revision> property in parent POMs only.
# Child module POMs use \${revision} and are updated by Maven in CI.
sed -i "s/<revision>${OLD}<\/revision>/<revision>${NEW}<\/revision>/g" \
  packages/java/pom.xml packages/kotlin/pom.xml
info "Java / Kotlin ✓"

# C#: <Version> element and PackageReference Version= attribute
while IFS= read -r f; do
  sed -i "s/<Version>${OLD}<\/Version>/<Version>${NEW}<\/Version>/g" "$f"
  sed -i "s/Version=\"${OLD}\"/Version=\"${NEW}\"/g" "$f"
done < <(find packages/csharp -name "*.csproj")
info "C# ✓"

# PHP: composer.json has no version field — Packagist reads versions from git
# tags, so nothing to bump here.
info "PHP ✓ (no version field in composer.json)"

# ── commit ────────────────────────────────────────────────────────────────────

step "Committing"

git add -A
git commit -m "chore(release): bump all runtimes to ${NEW_VERSION}

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
info "Committed ✓"

# ── push ──────────────────────────────────────────────────────────────────────

step "Pushing to origin/main"

git push origin main
info "Pushed ✓"

# ── tag ───────────────────────────────────────────────────────────────────────

if [[ "$NO_TAG" == false ]]; then
  step "Tagging v${NEW_VERSION}"
  git tag "v${NEW_VERSION}"
  git push origin "v${NEW_VERSION}"
  info "Tag v${NEW_VERSION} pushed ✓"
  echo
  echo "Done. CI will now publish v${NEW_VERSION} to all registries."
else
  echo
  echo "Done. Version bump pushed to main."
  echo "When ready to release, run:"
  echo "  git tag v${NEW_VERSION} && git push origin v${NEW_VERSION}"
fi
