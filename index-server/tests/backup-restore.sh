#!/usr/bin/env bash
# Phase 2 · task 2-04 — Supabase key-backup + disk-loss restore cycle.
# Issues a key via the signed webhook path, confirms it mirrors to Supabase,
# deletes the local keys file, restarts the service, and confirms restore.
# Requires: olw-index running, SUPABASE_* in /etc/gtll/olw-secrets.env.
set -euo pipefail
cd "$(dirname "$0")/.."

SR=$(grep '^SUPABASE_SERVICE_KEY=' /etc/gtll/olw-secrets.env | cut -d= -f2-)
SB=$(grep '^SUPABASE_URL=' /etc/gtll/olw-secrets.env | cut -d= -f2-)
pass=0; fail=0
ok(){ echo -e "  \033[32m✓\033[0m $1"; pass=$((pass+1)); }
bad(){ echo -e "  \033[31m✗ $1\033[0m"; fail=$((fail+1)); }

echo -e "\n\033[1mOLW Supabase Backup + Restore\033[0m\n"

echo "§1 issue a key (e2e payment flow)"
node tests/e2e-payment.mjs >/dev/null 2>&1 && ok "e2e payment flow green" || bad "e2e payment failed"
KEY=$(node -e "const k=require('./api-keys.json');console.log(Object.keys(k.keys).find(x=>k.keys[x].email.includes('olw-test.dev'))||'')")
[ -n "$KEY" ] && ok "key issued locally: ${KEY:0:20}…" || bad "no test key found locally"

echo -e "\n§2 mirrored to Supabase"
ROW=$(curl -s "$SB/rest/v1/olw_api_keys?api_key=eq.$KEY" -H "apikey: $SR" -H "Authorization: Bearer $SR")
echo "$ROW" | grep -q "$KEY" && ok "row present in Supabase" || bad "row missing in Supabase"

echo -e "\n§3 disk loss → restore on boot"
rm -f api-keys.json
[ ! -f api-keys.json ] && ok "local keys file deleted" || bad "delete failed"
systemctl restart olw-index; sleep 2
journalctl -u olw-index -n 10 --no-pager | grep -q "Restored.*from Supabase" && ok "boot log shows restore" || bad "no restore log line"
VERIFY=$(curl -s "http://localhost:3778/verify?api_key=$KEY")
echo "$VERIFY" | grep -q '"valid":true' && ok "restored key verifies valid" || bad "restored key invalid: $VERIFY"

echo -e "\n§4 cleanup"
curl -s -X DELETE "$SB/rest/v1/olw_api_keys?email=like.*olw-test.dev" -H "apikey: $SR" -H "Authorization: Bearer $SR" -o /dev/null -w "  supabase rows deleted (HTTP %{http_code})\n"
node -e "const fs=require('fs');if(fs.existsSync('api-keys.json')){const k=require('./api-keys.json');for(const x of Object.keys(k.keys))if(k.keys[x].email.includes('olw-test.dev'))delete k.keys[x];for(const s of Object.keys(k.by_session||{}))if((k.by_session[s].email||'').includes('olw-test.dev'))delete k.by_session[s];fs.writeFileSync('api-keys.json',JSON.stringify(k,null,2))}"
ok "local test keys removed"
systemctl restart olw-index; sleep 1

echo -e "\n\033[1mResult: $pass passed, $fail failed\033[0m\n"
[ "$fail" -eq 0 ] || exit 1
