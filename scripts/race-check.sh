#!/usr/bin/env bash
# Run the Go race detector across both Go modules. Requires cgo (gcc).
# Usage (from repo root, on Linux/macOS or WSL):  bash scripts/race-check.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CGO_ENABLED=1

# Non-login shells (e.g. `wsl -- bash script.sh`) may not have Go on PATH.
if ! command -v go >/dev/null 2>&1; then
  for candidate in /usr/local/go/bin /usr/lib/go/bin "$HOME/go/bin" /opt/homebrew/bin; do
    [ -x "${candidate}/go" ] && export PATH="${candidate}:${PATH}" && break
  done
fi
command -v go >/dev/null 2>&1 || { echo "go not found on PATH"; exit 127; }
command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1 || {
  echo "no C compiler found — the race detector requires cgo (install gcc or clang)"; exit 127; }

overall=0

for mod in packages/go packages/go/varrpc; do
  echo "=============================================================="
  echo "race: ${mod}"
  echo "=============================================================="
  ( cd "${REPO_ROOT}/${mod}" && go test -race -count=1 ./... 2>&1 )
  status=$?
  if [ $status -ne 0 ]; then
    echo ">>> FAILED (${mod}) exit=${status}"
    overall=$status
  else
    echo ">>> ok (${mod})"
  fi
  echo
done

echo "=============================================================="
if [ $overall -eq 0 ]; then
  echo "RACE CHECK: PASS (no data races detected)"
else
  echo "RACE CHECK: FAIL"
fi
exit $overall
