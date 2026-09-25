#!/usr/bin/env bash
# Adds the two loyalty fields to an existing commercetools cart/order Type, idempotently:
# loyaltyRedemptionId (String) and loyaltyRedemption (Set<String>), the fields whose values unlock
# the loyalty-D* CartDiscounts. A cart can carry only one custom Type, and the storefront already
# puts its own Type (key `ingrid-session`, shared with the Briqpay connector's fields) on every
# cart, so the loyalty fields must live on that Type rather than on the connector's default
# `pierce-loyalty-cart`.
#
# This mirrors what the connector's post-deploy hook does when the deployment sets
# LOYALTY_CART_TYPE_KEY=<type key>; use the hook for Connect deployments and this script for a
# project where the deployed connector was provisioned with the wrong key, or for a manual check.
#
# TODO: move this into ecom-sync-engine, which owns the commercetools project provisioning
# (Types, stores, channels), so the Type is extended where it is defined instead of here.
#
# Usage: processor/scripts/extend-cart-type.sh <path to processor/.env> [type key, default ingrid-session]
# The .env must provide CTP_PROJECT_KEY, CTP_CLIENT_ID, CTP_CLIENT_SECRET, CTP_AUTH_URL, CTP_API_URL;
# LOYALTY_REDEMPTION_ID_FIELD / LOYALTY_DENOMINATIONS_FIELD override the field names like the connector.
set -euo pipefail

ENV_FILE="${1:?path to processor/.env}"
TYPE_KEY="${2:-ingrid-session}"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ID_FIELD="${LOYALTY_REDEMPTION_ID_FIELD:-loyaltyRedemptionId}"
SET_FIELD="${LOYALTY_DENOMINATIONS_FIELD:-loyaltyRedemption}"

token="$(curl -sf -u "$CTP_CLIENT_ID:$CTP_CLIENT_SECRET" -X POST \
  "$CTP_AUTH_URL/oauth/token?grant_type=client_credentials" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
base="$CTP_API_URL/$CTP_PROJECT_KEY"

type_json="$(curl -sf -H "Authorization: Bearer $token" "$base/types/key=$TYPE_KEY")"

# Build only the addFieldDefinition actions for fields the Type does not have yet.
actions="$(ID_FIELD="$ID_FIELD" SET_FIELD="$SET_FIELD" python3 - "$type_json" <<'PY'
import json, os, sys
t = json.loads(sys.argv[1])
present = {f["name"]: f for f in t.get("fieldDefinitions", [])}
wanted = [
    {"name": os.environ["ID_FIELD"], "label": {"en": "Loyalty redemption id"}, "required": False,
     "type": {"name": "String"}, "inputHint": "SingleLine"},
    {"name": os.environ["SET_FIELD"], "label": {"en": "Loyalty discount denominations"}, "required": False,
     "type": {"name": "Set", "elementType": {"name": "String"}}},
]
actions = []
for f in wanted:
    found = present.get(f["name"])
    if found is None:
        actions.append({"action": "addFieldDefinition", "fieldDefinition": f})
    elif found["type"] != f["type"]:
        sys.exit(f"Type already defines {f['name']} as {found['type']}, expected {f['type']}")
print(json.dumps({"version": t["version"], "actions": actions}))
PY
)"

if [ "$(printf '%s' "$actions" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["actions"]))')" = "0" ]; then
  echo "Type $TYPE_KEY already has $ID_FIELD and $SET_FIELD - nothing to do"
  exit 0
fi

curl -sf -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -X POST -d "$actions" "$base/types/key=$TYPE_KEY" \
  | python3 -c 'import sys,json;t=json.load(sys.stdin);print("Type", t["key"], "version", t["version"], "fields:", [f["name"] for f in t["fieldDefinitions"]])'
