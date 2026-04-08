#!/usr/bin/env bash
###
 # @Author: Jingsheng cjingsheng01@163.com
 # @Date: 2026-03-27 21:55:22
 # @LastEditors: Jingsheng cjingsheng01@163.com
 # @LastEditTime: 2026-03-27 22:13:11
 # @FilePath: /copilot-api/run-claude-with-proxy.sh
 # @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
### 

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${COPILOT_API_PORT:-4141}"
BASE_URL="${ANTHROPIC_BASE_URL:-http://127.0.0.1:${PORT}}"
LOG_FILE="${TMPDIR:-/tmp}/copilot-api-claude.log"

proxy_pid=""
started_proxy=0

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_proxy_ready() {
  curl -fsS --max-time 2 "${BASE_URL}/" >/dev/null 2>&1
}

cleanup() {
  if [[ "${started_proxy}" -eq 1 && -n "${proxy_pid}" ]] && kill -0 "${proxy_pid}" 2>/dev/null; then
    kill "${proxy_pid}" 2>/dev/null || true
    wait "${proxy_pid}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

require_command bun
require_command claude
require_command curl

if is_proxy_ready; then
  echo "Using existing proxy at ${BASE_URL}"
else
  echo "Starting proxy at ${BASE_URL}"
  (
    cd "${ROOT_DIR}"
    bun run start start -v
  ) >"${LOG_FILE}" 2>&1 &
  proxy_pid="$!"
  started_proxy=1

  for _ in {1..30}; do
    if ! kill -0 "${proxy_pid}" 2>/dev/null; then
      echo "Proxy exited before becoming ready. Recent log output:" >&2
      tail -n 40 "${LOG_FILE}" >&2 || true
      exit 1
    fi

    if is_proxy_ready; then
      break
    fi

    sleep 1
  done

  if ! is_proxy_ready; then
    echo "Proxy did not become ready within 30 seconds. Recent log output:" >&2
    tail -n 40 "${LOG_FILE}" >&2 || true
    exit 1
  fi

  echo "Proxy is ready at ${BASE_URL}"
  echo "Proxy log: ${LOG_FILE}"
fi

open "${BASE_URL}/usage-viewer" 2>/dev/null || true

export ANTHROPIC_BASE_URL="${BASE_URL}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-opus-4.6}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-claude-sonnet-4.6}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-claude-haiku-4-5-20251001}"
export DISABLE_NON_ESSENTIAL_MODEL_CALLS="${DISABLE_NON_ESSENTIAL_MODEL_CALLS:-1}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export CLAUDE_CODE_ATTRIBUTION_HEADER="${CLAUDE_CODE_ATTRIBUTION_HEADER:-0}"
export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION="${CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION:-false}"

claude "$@"
