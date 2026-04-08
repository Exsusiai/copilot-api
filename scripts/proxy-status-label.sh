#!/bin/bash
# proxy-status-label.sh
# Outputs a JSON label for Claude HUD --extra-cmd
# Usage: --extra-cmd "bash /path/to/proxy-status-label.sh"

PROXY_URL="${COPILOT_API_URL:-http://localhost:4141}"

response=$(curl -s --max-time 2 "${PROXY_URL}/proxy-status" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$response" ]; then
  echo '{"label": "[Proxy] Offline"}'
  exit 0
fi

# Parse JSON with built-in tools (no jq dependency)
backend=$(echo "$response" | grep -o '"currentBackend":"[^"]*"' | head -1 | cut -d'"' -f4)
primary_count=$(echo "$response" | grep -o '"primaryRequestCount":[0-9]*' | head -1 | cut -d: -f2)
copilot_count=$(echo "$response" | grep -o '"copilotRequestCount":[0-9]*' | head -1 | cut -d: -f2)
is_limited=$(echo "$response" | grep -o '"isPrimaryRateLimited":[a-z]*' | head -1 | cut -d: -f2)

if [ "$backend" = "primary" ]; then
  label="[Anthropic] ${primary_count:-0}r"
else
  label="[Copilot] ${copilot_count:-0}r"
fi

if [ "$is_limited" = "true" ]; then
  label="${label} RL"
fi

echo "{\"label\": \"${label}\"}"
