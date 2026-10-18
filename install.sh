#!/bin/sh
set -eu
if [ "${HERDR_ENV:-}" != 1 ] || [ -z "${HERDR_SOCKET_PATH:-}" ]; then
  printf '%s\n' 'Open a Herdr-managed pane, then run this installer there. Nothing was installed.' >&2
  exit 1
fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
for tool in node pi claude opencode herdr; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing required CLI: %s\n' "$tool" >&2; exit 1; }
done
node --test "$ROOT"/tests/*.test.mjs
"${HERDR_BIN_PATH:-herdr}" plugin link "$ROOT"
"${HERDR_BIN_PATH:-herdr}" plugin action list --plugin personal.orchestrator
printf '\nInstalled locally. In a project shell inside Herdr, run in the same pane:\n  sh "%s/start.sh"\nFor a new coordinator tab instead:\n  herdr plugin action invoke personal.orchestrator.start\n' "$ROOT"
