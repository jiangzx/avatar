#!/usr/bin/env bash
# Local gateway process control (bare Node; not Docker Compose / systemd).
#   ./scripts/gateway.sh start   # idempotent restart in background; wait for /healthz
#   ./scripts/gateway.sh stop
#   ./scripts/gateway.sh status
set -euo pipefail
cd "$(dirname "$0")/.."

readonly LOG_DIR="gateway/logs"
readonly LOG_FILE="${LOG_DIR}/gateway.out.log"
readonly START_HEALTH_TIMEOUT_SEC=10
readonly STOP_WAIT_TIMEOUT_SEC=5

usage() {
  cat <<'EOF' >&2
usage: ./scripts/gateway.sh start|stop|status
EOF
  exit 2
}

# Read PORT from gateway/.env without sourcing secrets into the shell.
gateway_port() {
  local raw
  raw="$(grep -sE '^PORT=' gateway/.env | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$raw"
  else
    printf '8787\n'
  fi
}

listening_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

healthz_ok() {
  local port="$1"
  local body
  body="$(curl -sS --max-time 1 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"
  [[ "$body" == *'"ok":true'* || "$body" == *'"ok": true'* ]]
}

cmd_stop() {
  local port pids elapsed
  port="$(gateway_port)"
  pids="$(listening_pids "$port")"
  if [[ -z "$pids" ]]; then
    echo "gateway already stopped (port ${port})"
    return 0
  fi

  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true

  elapsed=0
  while (( elapsed < STOP_WAIT_TIMEOUT_SEC )); do
    pids="$(listening_pids "$port")"
    [[ -z "$pids" ]] && break
    sleep 1
    elapsed=$((elapsed + 1))
  done

  pids="$(listening_pids "$port")"
  if [[ -n "$pids" ]]; then
    # soft stop timed out; force
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi

  pids="$(listening_pids "$port")"
  if [[ -n "$pids" ]]; then
    echo "failed to stop gateway on port ${port}" >&2
    return 1
  fi
  echo "gateway stopped (port ${port})"
}

cmd_start() {
  local port start_at bg_pid
  port="$(gateway_port)"

  cmd_stop

  mkdir -p "$LOG_DIR"
  # Append process stdout/stderr only; do not write conversation content here.
  nohup npm start -w gateway >>"$LOG_FILE" 2>&1 &
  bg_pid=$!
  disown "$bg_pid" 2>/dev/null || true

  start_at=$SECONDS
  while (( SECONDS - start_at < START_HEALTH_TIMEOUT_SEC )); do
    if ! kill -0 "$bg_pid" 2>/dev/null; then
      echo "gateway start process exited early (port ${port}); see ${LOG_FILE}" >&2
      echo "hint: another supervisor may have rebound the port (e.g. launchd)" >&2
      return 1
    fi
    if healthz_ok "$port"; then
      echo "gateway started (port ${port}, log ${LOG_FILE})"
      return 0
    fi
    sleep 0.25
  done

  echo "gateway failed to become healthy within ${START_HEALTH_TIMEOUT_SEC}s (port ${port}); see ${LOG_FILE}" >&2
  return 1
}

cmd_status() {
  local port
  port="$(gateway_port)"
  if [[ -n "$(listening_pids "$port")" ]] && healthz_ok "$port"; then
    echo "up port=${port}"
    return 0
  fi
  echo "down port=${port}"
  return 1
}

main() {
  if [[ $# -ne 1 ]]; then
    usage
  fi
  case "$1" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    *) usage ;;
  esac
}

main "$@"
