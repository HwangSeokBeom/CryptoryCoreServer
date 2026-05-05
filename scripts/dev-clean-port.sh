#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3002}"

PIDS="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"

if [[ -z "${PIDS}" ]]; then
  echo "No listener found on TCP:${PORT}"
  exit 0
fi

echo "Listeners on TCP:${PORT}:"
lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN || true

for PID in ${PIDS}; do
  COMMAND="$(ps -p "${PID}" -o comm= 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -z "${COMMAND}" ]]; then
    echo "PID ${PID} exited before cleanup"
    continue
  fi

  echo "Sending TERM to pid=${PID} command=${COMMAND}"
  kill -TERM "${PID}" 2>/dev/null || true
done

sleep 2

REMAINING="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
if [[ -z "${REMAINING}" ]]; then
  echo "TCP:${PORT} is free"
  exit 0
fi

echo "Listeners still present on TCP:${PORT}; sending KILL:"
lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN || true
for PID in ${REMAINING}; do
  kill -KILL "${PID}" 2>/dev/null || true
done

sleep 1

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Failed to free TCP:${PORT}" >&2
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN || true
  exit 1
fi

echo "TCP:${PORT} is free"
