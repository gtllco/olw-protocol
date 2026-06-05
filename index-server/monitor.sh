#!/usr/bin/env bash
# OLW health monitor — checks /health, alerts via orbit-api /soulProxy on failure.
# Wire via cron (every 5 min):
#   */5 * * * * /opt/olw/index-server/monitor.sh >> /var/log/olw-monitor.log 2>&1
set -uo pipefail

URL="${OLW_HEALTH_URL:-http://localhost:3778/health}"
NEURAL_SECRET="${NEURAL_SECRET:-ILOVEYOUSAMUEL}"
SOUL_PROXY="${SOUL_PROXY_URL:-http://localhost:3100/soulProxy}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

code=$(curl -s -o /tmp/olw-health.json -w "%{http_code}" --max-time 8 "$URL" || echo "000")
ok=$(grep -o '"ok":true' /tmp/olw-health.json 2>/dev/null || true)

if [ "$code" = "200" ] && [ -n "$ok" ]; then
  echo "$STAMP OLW healthy ($code)"
  exit 0
fi

echo "$STAMP OLW UNHEALTHY (http=$code body=$(cat /tmp/olw-health.json 2>/dev/null))"
curl -s -X POST "$SOUL_PROXY" \
  -H "Content-Type: application/json" \
  -H "x-neural-secret: $NEURAL_SECRET" \
  -d "{\"source\":\"olw-monitor\",\"severity\":\"critical\",\"message\":\"OLW index /health failed: http=$code\",\"ts\":\"$STAMP\"}" \
  -o /dev/null -w "  alert sent (HTTP %{http_code})\n" --max-time 8 || echo "  alert dispatch failed"
exit 1
