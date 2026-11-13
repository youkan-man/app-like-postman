#!/usr/bin/env bash
set -euo pipefail

browser_status_file=.local_relay/output/browser-cross-vm-e2e.exit-code

if [[ $# == 1 && $1 == --check ]]; then
  if [[ ! -f "$browser_status_file" ]]; then
    echo 'Browser verification did not record an exit code.' >&2
    exit 2
  fi
  browser_exit_code=$(cat "$browser_status_file")
  if [[ ! "$browser_exit_code" =~ ^(0|[1-9][0-9]{0,2})$ ]] || ((browser_exit_code > 255)); then
    echo 'Browser verification exit code is incomplete or invalid.' >&2
    exit 2
  fi
  if ((browser_exit_code != 0)); then
    echo "Browser verification failed (exit $browser_exit_code); preceding step retained its artifacts." >&2
  else
    echo 'Browser verification passed (exit 0).'
  fi
  exit "$browser_exit_code"
fi

if (($# != 0)); then
  echo 'Usage: relay_2vm_collect_browser.sh [--check]' >&2
  exit 2
fi

mkdir -p .local_relay/output
# Invalidate any prior success before starting; an interrupted run cannot pass.
printf 'running\n' >"$browser_status_file"
if bash ci/relay_2vm_verify_browser.sh; then
  browser_exit_code=0
else
  browser_exit_code=$?
fi
printf '%s\n' "$browser_exit_code" >"$browser_status_file"

# Relay downloads artifacts only after a successful Sandbox build step. This
# step records the result so it can collect failure screenshots and logs too.
# The required dependent --check step returns the original verification status.
echo "Browser verification finished (exit $browser_exit_code); artifacts are ready for collection."
