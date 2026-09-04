# SCIM IdP Users POC (GTW-179 v2)

Proof of concept for receiving **all users registered in a tenant's bounded IdP** via the
**SCIM 2.0 protocol** (RFC 7643/7644), shown in a UI styled like `rsa-unified-ui` under an
**IdP Users** sidebar entry.

## The model (and how it differs from the Graph POC)

Direction is flipped: **we are the SCIM server, the IdP is the SCIM client.**

```
Entra provisioning engine ──HTTPS+Bearer──▶  ngrok  ──▶  this SCIM server  ──▶  local user store  ──▶  UI
(pushes on its ~40-min cycle)                             /scim/v2/Users            data/store.json
```

- The SCIM server piece is **IdP-agnostic**: Entra, Okta, OneLogin, and PingOne/PingFederate all
  ship provisioning clients that push to any RFC-compliant SCIM endpoint. Per-IdP effort is only
  the admin configuring their provisioning client (URL + bearer token).
- Caveat from the GTW-179 research: Auth0, Google Workspace, and stock Keycloak **cannot** push
  SCIM to arbitrary endpoints — those IdPs would still need pull adapters in the real product.
- No Graph permission, no app registration with `User.Read.All` — the trade is that data arrives
  on the **IdP's schedule** (Entra: initial sync + ~40-minute cycles; "Provision on demand" pushes
  a single user instantly), not on ours.

Pieces, fully self-contained in this folder:

- `server/` — Express **SCIM 2.0 server**: bearer-token auth, `/scim/v2/ServiceProviderConfig`,
  `/ResourceTypes`, `/Schemas`, full `/Users` CRUD (`GET` with `filter=userName eq "…"` +
  `startIndex`/`count` paging, `POST`, `PUT`, `PATCH` with Entra's quirks handled — capitalized
  ops, `"False"` string booleans, URN-prefixed enterprise-extension paths — and `DELETE` as a
  tombstone), plus minimal `/Groups`. Users persist to `data/store.json`.
- `web/` — Vite + React + Tailwind UI cloning the unified-ui shell: the provisioned-user table
  (search, Active/Inactive/Deprovisioned pills, sortable columns) and a **live SCIM activity
  feed** showing every request the IdP makes.
- `scripts/simulate-idp.mjs` — an IdP-shaped SCIM client (lookup → create → patch → deactivate →
  delete → group push) for demos and testing without waiting for Entra.

## 1. Run it locally

```bash
cd scim-users-poc
make install
cp .env.example .env
make token          # prints a SCIM_TOKEN=... line — put it in .env
make dev            # SCIM+API on :5175, UI on http://localhost:5173
```

Instant demo without Entra: `make simulate` (in a second terminal) replays a provisioning cycle
against the real SCIM endpoints — users appear in the UI and the activity feed live.

## 2. Wire up Entra (one time, ~5 minutes)

1. Expose the server: `make tunnel` (ngrok; `make tunnel-cf` for a Cloudflare quick tunnel
   instead). Copy the https URL it prints. **The Tenant URL must include the path**:
   `https://<host>/scim/v2` — the single most common mistake is entering the bare domain, which
   makes every SCIM request 404 with a hint pointing here. (Free-tier ngrok shows browsers a
   one-time warning page — click through once; server-side SCIM clients pass straight through.)
2. [Entra admin center](https://entra.microsoft.com) → **Enterprise applications** → **New
   application** → **Create your own application** → "Integrate any other application you don't
   find in the gallery (Non-gallery)".
3. In the new app: **Provisioning** → Get started → Mode = **Automatic**:
   - **Tenant URL** = `https://<your-ngrok-host>/scim/v2`  (no trailing slash)
   - **Secret Token** = the `SCIM_TOKEN` value from your `.env`
   - Click **Test Connection** — you'll see the GET hit the activity feed in the UI.
4. (Optional) **Mappings**: the default user attribute mappings are fine for this POC.
5. **Settings** → Scope = **Sync all users and groups** → set Provisioning Status = **On** → Save.
6. Wait for the initial cycle (minutes for a small tenant), or push one user instantly:
   **Provision on demand** → pick a user → Provision.

Users appear in the IdP Users tab as Entra pushes them; disables arrive as `PATCH active=false`,
deletes as `DELETE` (shown as **Deprovisioned**).

## Testing with Keycloak (pull direction)

Keycloak has **no outbound SCIM client** (it can't push like Entra), but Keycloak 26.6+ ships an
experimental **SCIM server** (`--features=scim-api`) exposing `/realms/{realm}/scim/v2`. So the
Keycloak demo runs SCIM in the *pull* direction — a prototype of the research doc's "generic
SCIM-client connector" — using `scripts/scim-sync.mjs`, a generic SCIM→SCIM copier (nothing in it
is Keycloak-specific):

```bash
make kc-up      # separate Keycloak 26.7 container on :8090 (monorepo stack untouched)
make kc-seed    # realm `poc` + scim-puller service account + 6 test users (idempotent)
make kc-sync    # pulls all users over SCIM into this POC's store -> Owners UI
```

Create/change users in Keycloak (http://localhost:8090, admin/admin, realm `poc`) and re-run
`make kc-sync` — it upserts by `userName`. `make kc-down` removes the container.

Two non-obvious things the seed script handles (found the hard way):
- The server-wide feature flag isn't enough — the realm needs top-level `scimApiEnabled: true`.
- The SCIM API rejects tokens whose `aud` doesn't include `{realm URL}/scim/v2`, so the client
  gets an audience protocol mapper for exactly that value.

## Endpoints

| Route | Auth | What |
|---|---|---|
| `/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Bearer | SCIM discovery |
| `/scim/v2/Users` (+`/{id}`) — GET/POST/PUT/PATCH/DELETE | Bearer | the provisioning surface |
| `/scim/v2/Groups` (+`/{id}`) | Bearer | minimal groups support |
| `GET /api/users`, `/api/status`, `/api/activity` | none (local UI) | what the frontend reads |

## Troubleshooting

| Symptom | Cause |
|---|---|
| Entra Test Connection fails | Wrong Tenant URL (must end `/scim/v2`, https, no trailing slash), wrong Secret Token, or tunnel down |
| 401 in activity feed | Secret Token in Entra ≠ `SCIM_TOKEN` in `.env` |
| 503 from SCIM endpoints | `SCIM_TOKEN` not set in `.env` |
| Nothing arrives after enabling | Initial cycle takes a few minutes; check the app's Provisioning logs in Entra; try Provision on demand |
| Users created but attributes missing | Check Entra attribute mappings; unmapped attributes are simply absent |

## Deliberately out of scope

Gateway RBAC, persistence beyond a JSON file, SCIM `/Bulk`, sorting/etag, and the pull adapters
(Graph/Okta API) that Auth0/Google/Keycloak-bound tenants would need — all covered in
`../GTW-179-idp-user-fetching-research.md`.
