#!/usr/bin/env bash
# Stage watcher for Claude's Monitor tool: prints one line per stage change of an orchestrate run,
# a heartbeat line after 10 quiet minutes, and exits on a terminal stage.
# Usage: bash watch.sh <card.md>
card="$1"
orch="$(dirname "$0")/orchestrate.py"
prev=""; last=$(date +%s)
while true; do
  s=$(python "$orch" status "$card" 2>&1 | tr -d '\r')
  stage=$(printf '%s' "$s" | awk -F' · ' '{print $2}')
  now=$(date +%s)
  if [ "$stage" != "$prev" ]; then
    echo "$s"; prev="$stage"; last=$now
    case "$stage" in
      complete*|fail*|quota*|timeout*|error*|blocked*|"plan needs"*) exit 0 ;;
    esac
  elif [ $((now - last)) -ge 600 ]; then
    echo "still running: $s"; last=$now
  fi
  sleep 10
done
