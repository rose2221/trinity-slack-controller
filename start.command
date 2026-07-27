#!/bin/zsh

set -e
cd "${0:A:h}"

restore_terminal() {
  stty echo 2>/dev/null || true
}
trap restore_terminal EXIT INT TERM

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  printf "Paste your Slack bot token (input stays hidden): "
  stty -echo
  IFS= read -r SLACK_BOT_TOKEN
  stty echo
  printf "\n"
  export SLACK_BOT_TOKEN
fi

if [[ "$SLACK_BOT_TOKEN" != xoxb-* ]]; then
  printf "That does not look like a Slack bot token.\n"
  printf "Press Return to close."
  read -r
  exit 1
fi

node server.mjs &
server_pid=$!

stop_server() {
  restore_terminal
  kill "$server_pid" 2>/dev/null || true
}
trap stop_server EXIT INT TERM

sleep 1
open "http://127.0.0.1:${PORT:-3847}"
wait "$server_pid"
