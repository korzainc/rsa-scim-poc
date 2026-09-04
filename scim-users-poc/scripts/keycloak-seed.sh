#!/usr/bin/env bash
# Seeds the POC Keycloak (started by `make kc-up`) with:
#   - realm `poc` (with the experimental SCIM server available at /realms/poc/scim/v2)
#   - confidential client `scim-puller` (service account) granted the
#     realm-management roles the SCIM API requires (manage-users, view-realm)
#   - a handful of test users
# Idempotent: safe to re-run.
set -euo pipefail

KC=${KC_BASE:-http://localhost:8090}
REALM=poc
CLIENT_ID=scim-puller

say() { printf '\033[1;34m[kc-seed]\033[0m %s\n' "$*"; }

say "waiting for Keycloak at $KC ..."
for i in $(seq 1 60); do
  curl -sf "$KC/realms/master/.well-known/openid-configuration" > /dev/null && break
  sleep 2
  [ "$i" = 60 ] && { echo "Keycloak did not come up"; exit 1; }
done

TOKEN=$(curl -sf "$KC/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# --- realm -------------------------------------------------------------------
# scimApiEnabled is the per-realm switch for the experimental SCIM Realm API —
# the server-wide feature flag (--features=scim-api) alone is not enough.
if ! curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM" > /dev/null 2>&1; then
  say "creating realm $REALM (scimApiEnabled)"
  curl -sf "${AUTH[@]}" -X POST "$KC/admin/realms" -d "{\"realm\":\"$REALM\",\"enabled\":true,\"scimApiEnabled\":true}" > /dev/null
else
  say "realm $REALM exists — ensuring scimApiEnabled"
  curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); r['scimApiEnabled']=True; print(json.dumps(r))" \
    | curl -sf "${AUTH[@]}" -X PUT "$KC/admin/realms/$REALM" --data @- > /dev/null
fi

# --- service-account client ---------------------------------------------------
CID=$(curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients?clientId=$CLIENT_ID" | python3 -c "import json,sys; l=json.load(sys.stdin); print(l[0]['id'] if l else '')")
if [ -z "$CID" ]; then
  say "creating client $CLIENT_ID"
  curl -sf "${AUTH[@]}" -X POST "$KC/admin/realms/$REALM/clients" -d "{
    \"clientId\": \"$CLIENT_ID\", \"protocol\": \"openid-connect\", \"publicClient\": false,
    \"serviceAccountsEnabled\": true, \"standardFlowEnabled\": false, \"enabled\": true
  }" > /dev/null
  CID=$(curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients?clientId=$CLIENT_ID" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
fi
SECRET=$(curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients/$CID/client-secret" | python3 -c "import json,sys; print(json.load(sys.stdin)['value'])")

# Grant realm-management roles the SCIM Realm API requires.
SA_UID=$(curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients/$CID/service-account-user" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
RM_CID=$(curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients?clientId=realm-management" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
ROLES=$(curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients/$RM_CID/roles" | python3 -c "
import json,sys
roles=[r for r in json.load(sys.stdin) if r['name'] in ('manage-users','view-realm','view-users')]
print(json.dumps(roles))")
curl -sf "${AUTH[@]}" -X POST "$KC/admin/realms/$REALM/users/$SA_UID/role-mappings/clients/$RM_CID" -d "$ROLES" > /dev/null

# The SCIM Realm API validates the token's audience against "{realm URL}/scim/v2",
# so the client-credentials token needs an audience mapper carrying exactly that.
if ! curl -sf "${AUTH[@]}" "$KC/admin/realms/$REALM/clients/$CID/protocol-mappers/models" | grep -q '"scim-audience"'; then
  say "adding scim-audience protocol mapper"
  curl -sf "${AUTH[@]}" -X POST "$KC/admin/realms/$REALM/clients/$CID/protocol-mappers/models" -d "{
    \"name\": \"scim-audience\", \"protocol\": \"openid-connect\", \"protocolMapper\": \"oidc-audience-mapper\",
    \"config\": {\"included.custom.audience\": \"$KC/realms/$REALM/scim/v2\", \"access.token.claim\": \"true\", \"id.token.claim\": \"false\"}
  }" > /dev/null
fi
say "client $CLIENT_ID ready (roles + audience granted)"

# --- test users ----------------------------------------------------------------
create_user() { # username first last email enabled
  local payload="{\"username\":\"$1\",\"firstName\":\"$2\",\"lastName\":\"$3\",\"email\":\"$4\",\"enabled\":$5,\"emailVerified\":true,\"attributes\":{\"department\":[\"$6\"]}}"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$KC/admin/realms/$REALM/users" -d "$payload")
  case "$code" in
    201) say "  created $1";;
    409) say "  exists  $1";;
    *)   say "  FAILED  $1 (http $code)"; exit 1;;
  esac
}

say "seeding users"
create_user maya.varghese  Maya  Varghese  maya.varghese@poc.local  true  Engineering
create_user rohit.menon    Rohit Menon     rohit.menon@poc.local    true  Engineering
create_user sara.thomas    Sara  Thomas    sara.thomas@poc.local    true  Security
create_user dev.krishnan   Dev   Krishnan  dev.krishnan@poc.local   true  Product
create_user anita.pillai   Anita Pillai    anita.pillai@poc.local   false Finance
create_user jacob.mathew   Jacob Mathew    jacob.mathew@poc.local   true  Sales

cat <<EOF

Keycloak SCIM source ready:
  SOURCE_SCIM_BASE=$KC/realms/$REALM/scim/v2
  SOURCE_TOKEN_URL=$KC/realms/$REALM/protocol/openid-connect/token
  SOURCE_CLIENT_ID=$CLIENT_ID
  SOURCE_CLIENT_SECRET=$SECRET

Run: make kc-sync   (pulls these users over SCIM into the POC store)
EOF

# Persist connection details for scim-sync.mjs
cat > "$(dirname "$0")/../.kc-source.env" <<EOF
SOURCE_SCIM_BASE=$KC/realms/$REALM/scim/v2
SOURCE_TOKEN_URL=$KC/realms/$REALM/protocol/openid-connect/token
SOURCE_CLIENT_ID=$CLIENT_ID
SOURCE_CLIENT_SECRET=$SECRET
EOF
say "wrote .kc-source.env"
