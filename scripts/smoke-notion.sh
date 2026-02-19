#!/usr/bin/env bash
# Smoke test for Notion integration via Portero MCP gateway.
# Usage: BEARER_TOKEN=<token> [PORTERO_URL=http://127.0.0.1:3055] [DB_ID=<uuid>] ./scripts/smoke-notion.sh
#
# Tests:
#  1. notion/API-retrieve-a-database  (via child MCP)
#  2. notion/query-database           (Portero virtual tool, direct API)

set -euo pipefail

PORTERO_URL="${PORTERO_URL:-http://127.0.0.1:3055}"
DB_ID="${DB_ID:-30bb309e-958d-80a1-a338-cdc3f8e3d0fb}"
MCP_ENDPOINT="${PORTERO_URL}/mcp/message"

if [ -z "${BEARER_TOKEN:-}" ]; then
  echo "ERROR: BEARER_TOKEN is required"
  exit 1
fi

call_mcp() {
  local tool_name="$1"
  local args="$2"
  local id="${3:-1}"

  curl -sf -X POST "${MCP_ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${BEARER_TOKEN}" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": ${id},
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"${tool_name}\",
        \"arguments\": ${args}
      }
    }"
}

echo "=== Smoke Test: Notion Integration ==="
echo "Gateway: ${PORTERO_URL}"
echo "Database: ${DB_ID}"
echo ""

# Test 1: Retrieve database metadata
echo "--- Test 1: notion/API-retrieve-a-database ---"
RESULT1=$(call_mcp "notion/API-retrieve-a-database" "{\"database_id\": \"${DB_ID}\"}" 1) || {
  echo "FAIL: retrieve-a-database returned non-zero"
  echo "$RESULT1"
  exit 1
}

if echo "$RESULT1" | grep -q '"error"'; then
  echo "FAIL: retrieve-a-database returned error"
  echo "$RESULT1" | python3 -m json.tool 2>/dev/null || echo "$RESULT1"
  exit 1
fi

echo "PASS: retrieve-a-database succeeded"
# Extract DB title if available
DB_TITLE=$(echo "$RESULT1" | python3 -c "
import json, sys
r = json.load(sys.stdin)
for c in r.get('result',{}).get('content',[]):
  if c.get('type')=='text':
    d = json.loads(c['text'])
    titles = d.get('title',[])
    if titles:
      print(titles[0].get('plain_text','(untitled)'))
      break
" 2>/dev/null || echo "(could not parse title)")
echo "  DB Title: ${DB_TITLE}"
echo ""

# Test 2: Query database (Portero virtual tool)
echo "--- Test 2: notion/query-database ---"
RESULT2=$(call_mcp "notion/query-database" "{\"database_id\": \"${DB_ID}\", \"page_size\": 5}" 2) || {
  echo "FAIL: query-database returned non-zero"
  echo "$RESULT2"
  exit 1
}

if echo "$RESULT2" | grep -q '"error"'; then
  ERROR_MSG=$(echo "$RESULT2" | python3 -c "
import json, sys
r = json.load(sys.stdin)
err = r.get('error',{})
print(err.get('message','unknown'))
" 2>/dev/null || echo "unknown")
  echo "FAIL: query-database returned error: ${ERROR_MSG}"
  echo "$RESULT2" | python3 -m json.tool 2>/dev/null || echo "$RESULT2"
  exit 1
fi

# Count results
RESULT_COUNT=$(echo "$RESULT2" | python3 -c "
import json, sys
r = json.load(sys.stdin)
for c in r.get('result',{}).get('content',[]):
  if c.get('type')=='text':
    d = json.loads(c['text'])
    print(len(d.get('results',[])))
    break
" 2>/dev/null || echo "?")

echo "PASS: query-database returned ${RESULT_COUNT} results"
echo ""

echo "=== All smoke tests passed ==="
