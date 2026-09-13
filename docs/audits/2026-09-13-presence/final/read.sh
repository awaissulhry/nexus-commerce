#!/bin/bash
set -u
name="$1"
shift
root=/Users/awais/nexus-commerce/docs/audits/2026-09-13-presence/final/logs
log="$root/$name.log"
{
  echo "HOST=$(hostname)"
  echo "CWD=$PWD"
  echo "START=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  uptime
  printf 'COMMAND:'
  printf ' %q' "$@"
  printf '\n'
  "$@"
  result=$?
  echo "EXIT=$result"
  echo "FINISH=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  uptime
} > "$log" 2>&1
cat "$log"
exit "$result"
