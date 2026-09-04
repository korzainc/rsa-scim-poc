# GTW-179 — Fetching Users from the Bounded IdP: Research Synthesis

**Scope:** Research only (implementation out of scope). Answers the three ticket questions: (1) Entra first + is there a common protocol, (2) what permissions the gateway needs, (3) incremental fetching. Goal: an admin persona in the gateway can fetch **all** users registered in the tenant's IdP (read-only), for the UI's Discover and Secure sections.

---

## 1. Executive Summary / TL;DR

**Verdict on a generic protocol: No.** There is no pull protocol that works across major IdPs. SCIM 2.0 is the only candidate standard and it fails on *direction*: commercial IdPs implement the SCIM **client** (push into apps), not a queryable SCIM **server** over their own directory. Entra, Okta, Auth0 (tenant-wide), OneLogin, and Google Workspace expose **no** queryable SCIM server. Every credible multi-IdP product (WorkOS, ConductorOne Baton, SailPoint, Steampipe) ships **per-vendor connectors over native APIs**, normalized to a SCIM-shaped model.

**Recommended architecture in 5 bullets:**

- **Per-IdP adapters behind a domain SPI**, mirroring the existing `UpstreamIdp` / `UpstreamIdpFactory` pattern (`modules/authn/authn-domain/.../upstream/UpstreamIdp.java:9`, `.../upstream/UpstreamIdpFactory.java:20-27`): a new `IdpUserDirectory` port in `authn-domain`, vendor impls in `authn-adapters/upstream/<vendor>/`, reusing `GraphApiClient` for Entra.
- **SCIM Core User (RFC 7643) as the canonical schema, not the transport**: normalize every vendor payload to `{externalId, userName, name, emails[], active, groups, raw_attributes}` — the WorkOS/Baton pattern.
- **Entra first via Microsoft Graph** `GET /v1.0/users` + `/users/delta`, application permission **`User.Read.All`**, admin-consent URL flow, client-credentials tokens minted per customer tenant.
- **Credentials in Vault via the existing `SecretsVault` vault-ref pattern** (`modules/authn/authn-adapters/.../secrets/VaultBackedSecretsVault.java:29`), new context e.g. `idp/directory_credential`; DB stores refs only, exactly like today's broker/registrar secrets (`IdpConfigService.java:53-54`).
- **Gateway RBAC**: new `IDP_USERS_READ` permission in `AdminPermission.java` + `AdminRolePermissions.MATRIX`, enforced by the house pattern `authz.requireCluster(p, clusterId, AdminPermission.IDP_USERS_READ)` as first line of the controller (canonical example: `services/gateway/.../gatewayadmin/idp/IdpConfigController.java:39-44`).

---

## 2. Is There a Common Protocol?

**SCIM 2.0 is the only standard shaped like this feature** — core User/Group schema ([RFC 7643](https://datatracker.ietf.org/doc/html/rfc7643)), REST protocol with `GET /Users`, filters, `startIndex`/`count` pagination, discovery endpoints ([RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644)).

**The direction problem is decisive.** In commercial deployments the IdP is the SCIM *client* pushing users into the SCIM *server* implemented by each downstream app:

- **Entra**: Microsoft's SCIM doc is a tutorial for apps to build a SCIM endpoint Entra pushes into ([learn.microsoft.com](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups)); the inbound [`/bulkUpload` API](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/inbound-provisioning-api-concepts) is write-only. Reading = Graph.
- **Okta**: SCIM client only ([SCIM concepts](https://developer.okta.com/docs/concepts/scim/)); no SCIM server over Universal Directory. Reading = `/api/v1/users`.
- **Auth0**: inbound SCIM server exists but is scoped **per enterprise connection**, not the tenant user store ([Configure Inbound SCIM](https://auth0.com/docs/authenticate/protocols/scim/configure-inbound-scim)). Reading = Management API.
- **OneLogin**: SCIM client only ([developers.onelogin.com/scim](https://developers.onelogin.com/scim)). **Google Workspace**: no SCIM server; Admin SDK only.
- **Exceptions**: **PingOne** exposes a real SCIM server (`https://scim-api.pingone.com/environments/{envID}/v2/`) but with no pagination, ≤200 results, no Groups ([PingOne SCIM](https://developer.pingidentity.com/pingone-api/platform/scim.html)); **PingDirectory** has a full SCIM API; **Keycloak 26.6+** ships an experimental→preview SCIM Realm API at `{realm}/scim/v2` behind feature flag `scim-api` ([announcement](https://www.keycloak.org/2026/04/scim-as-experimental-feature)).

**Prior art confirms the connector pattern**: WorkOS Directory Sync normalizes per-provider connectors (Google pull, SCIM push for Okta/Entra, HRIS APIs) into a Directory User with `raw_attributes` passthrough ([workos.com/blog/directory-sync-beyond-scim](https://workos.com/blog/directory-sync-beyond-scim)); ConductorOne [Baton](https://github.com/conductorone/baton-sdk) is the best open-source blueprint (standardized model + per-app connectors; [baton-okta](https://github.com/ConductorOne/baton-okta) calls the Okta API, not SCIM). OIDC is irrelevant here — UserInfo returns claims about a single token-holder only ([OIDC Core §5.3](https://openid.net/specs/openid-connect-core-1_0.html)); no listing endpoint exists.

**Verdict:** SCIM wins as the **normalization schema**, loses as the **transport**. Build per-IdP adapters; optionally add a generic SCIM-*client* connector (covers PingOne/PingDirectory/Keycloak 26.6+/self-hosted) and a generic LDAP(S) connector (on-prem AD, [Google Secure LDAP](https://support.google.com/a/answer/9048516), [Okta LDAP Interface](https://help.okta.com/en-us/content/topics/directory/ldap-interface-main.htm)) later — cheap once the schema is already SCIM.

---

## 3. Entra ID Deep-Dive

**API:** `GET https://graph.microsoft.com/v1.0/users` ([List users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0)). Cursor pagination only via `@odata.nextLink` (**no `$skip`**); page size default 100, max **999** (`$top=999`; drops to 500 with `signInActivity`). Without `$select` you get only the 11 default properties — `accountEnabled`, `userType`, `createdDateTime`, `identities`, `onPremises*` all **require `$select`**. Advanced queries (`$search`, `$count`, `not`/`ne`) need `ConsistencyLevel: eventual` + `$count=true` ([advanced queries](https://learn.microsoft.com/en-us/graph/aad-advanced-queries)). Group membership is a navigation (`GET /users/{id}/memberOf`), not a property.

**Permissions (application, all require admin consent):**

| Permission | ID | Unlocks |
|---|---|---|
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` | Full profiles; **documented least-privileged app permission for `GET /users` and `/users/delta`** |
| `User.ReadBasic.All` | `97235f07-e226-4f63-ace3-39588e11d3a1` | Basic profile only (displayName, mail, UPN, photo…); app-only variant exists — validate against `/users` before shipping since the v1.0 table names `User.Read.All` as least-privileged |
| `Directory.Read.All` | `7ab1d382-f21e-4acd-a863-ba3e13f7da61` | Needed for `memberOf` of arbitrary users (`User.Read.All` insufficient); Microsoft cautions against `Directory.*` |
| `AuditLog.Read.All` | `b0afded3-3588-46d8-8b3d-9842eff778da` | `signInActivity` (also needs Entra ID P1/P2) |

Recommendation: **`User.Read.All`** for v1; add `GroupMember.Read.All`/`Directory.Read.All` only when group sync lands. ([Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).)

**Can the existing SSO app registration be reused?** Mechanically yes — application permissions attach to the same app registration. But the delegated OIDC consent (`openid profile email`) grants **no app roles**: a client-credentials token still mints but carries no `roles` claim, and Graph rejects `/users` with `403 Authorization_RequestDenied` ([client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)). Reuse requires: (a) declaring `User.Read.All` application permission on that app, (b) tenant-admin consent, (c) a client credential (secret/cert/**federated credential** — preferred, no rotation). Note the gateway's `idp_config` already models a Graph-capable credential: `registrar_type = graph_app` with `registrar_*` secret columns (`modules/authn/authn-adapters/src/main/resources/db/migration/cluster/GW1__core.sql:31-40`) — for Entra-bound clusters that registrar credential may already carry Graph app permissions, making it the natural candidate to extend (decide deliberately; see §9).

**Consent flow (multi-tenant SaaS):** redirect the customer admin to `https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=...&scope=https://graph.microsoft.com/.default&redirect_uri=...&state=...` ([admin consent protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent)); `/.default` is mandatory. Success returns `admin_consent=True&tenant={guid}` (never trust the `tenant` param for authz). Then mint tokens **per customer tenant**: `POST https://login.microsoftonline.com/{customer-tenant-id}/oauth2/v2.0/token`, `grant_type=client_credentials&scope=https://graph.microsoft.com/.default`.

**Delta queries:** `GET /v1.0/users/delta` ([user: delta](https://learn.microsoft.com/en-us/graph/api/user-delta?view=graph-rest-1.0), [overview](https://learn.microsoft.com/en-us/graph/delta-query-overview)). Initial crawl pages via `nextLink`, ends with a `deltaLink` — store the **whole URL**. `$select` must be set on the initial request (encoded in tokens). `?$deltatoken=latest` = sync-from-now. Changes surface as creates (full object), updates (`id` + changed props; add `Prefer: return=minimal`), deletes as `"@removed": {"reason": "changed"|"deleted"}` (soft-deleted users restorable for 30 days via `/directory/deletedItems`). Entities may replay — **upsert idempotently**. Tokens expire after **7 days** (`syncStateNotFound`); a **`410 Gone`** with `Location` header forces full resync. `$filter` limited to `id eq` (≤50 ids); no `$expand`/`$top`/`$orderby`. Push option: change notifications (`resource: "users"`, max lifetime ~29 days, renew via `lifecycleNotificationUrl`) as **trigger**, delta as the **data pull** ([subscription resource](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0)).

**Throttling** ([limits](https://learn.microsoft.com/en-us/graph/throttling-limits)): resource-unit budgets — per app per tenant 3,500/5,000/8,000 RU per 10 s (by tenant size); per app across all tenants 150,000 RU/20 s. `GET /users` = 2 RU (−1 with `$select`). Monitor `x-ms-resource-unit`/`x-ms-throttle-limit-percentage`; honor `Retry-After` on 429. [`$batch`](https://learn.microsoft.com/en-us/graph/json-batching) (max 20) does not bypass RU limits.

**Licensing:** plain listing needs **no premium license**; `signInActivity` needs **P1/P2**; External ID external-tenant M2M needs the M2M Premium add-on. **B2C/External ID external tenants do not support delta** — full re-enumeration only; `$count`/`$search` unavailable; local accounts use `identities` + `creationType: "LocalAccount"` ([B2C Graph operations](https://learn.microsoft.com/en-us/azure/active-directory-b2c/microsoft-graph-operations)). Guests: `userType: "Guest"`, mangled UPN (`#EXT#`), possibly null `mail`.

---

## 4. Per-IdP Comparison Matrix

| | **Entra ID** | **Okta** | **Auth0** | **Keycloak** | **Google Workspace** | **PingOne** | **OneLogin** |
|---|---|---|---|---|---|---|---|
| **List API** | `GET /v1.0/users` (Graph) | [`GET /api/v1/users`](https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/) | [`GET /api/v2/users`](https://auth0.com/docs/api/management/v2/users/get-users) (≤1,000 total!) → **use [export job](https://auth0.com/docs/api/management/v2/jobs/post-users-exports)** `POST /api/v2/jobs/users-exports` | `GET /admin/realms/{realm}/users` ([rest-api](https://www.keycloak.org/docs-api/latest/rest-api/index.html); no `/auth` prefix on Quarkus) | [`GET /admin/directory/v1/users?customer=my_customer`](https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/list) | [`GET /v1/environments/{envID}/users`](https://developer.pingidentity.com/pingone-api/platform/users/users-1/read-all-users.html) | [`GET /api/2/users`](https://developers.onelogin.com/api-docs/2/users/list-users) |
| **Auth mechanism** | client_credentials vs `login.microsoftonline.com/{tenant}`, `scope=https://graph.microsoft.com/.default` | OAuth service app, **client_credentials + private_key_jwt** (org AS, `/oauth2/v1/token`); SSWS token discouraged | M2M client_credentials, `audience=https://{domain}/api/v2/` | Confidential client + service account, client_credentials against target realm | Service account + **Domain-Wide Delegation**, impersonates an admin-role user (mandatory — no non-DWD path) | Worker app, client_credentials (`/{envID}/as/token`) | API credential pair, client_credentials (`POST /auth/oauth2/v2/token`) |
| **Least-privilege permission** | App permission `User.Read.All` (+ `Directory.Read.All` for memberOf) | Scope **`okta.users.read`** ∩ assigned admin role (Read-only Admin or custom role + resource set); Super Admin grants scopes | Scopes `read:users` (+ `read:users_app_metadata`, `read:logs` for deltas) | `realm-management:view-users` (composites `query-users`,`query-groups`); cross-realm via master `{realm}-realm:view-users` | DWD grant of `admin.directory.user.readonly`; impersonated subject with custom role "Users → Read" | Role **`Identity Data Read-Only Admin`** scoped to environment | Credential scope **`Read Users`** |
| **Pagination** | `@odata.nextLink` cursor, `$top=999` | `Link: rel="next"` cursor (`after`), limit **200** — never craft cursors | `page`/`per_page` (≤100) but **offset < 1,000 hard cap**; export job for full set | Offset `first`/`max` (default 100); terminate on empty page (count endpoint unreliable: [#45219](https://github.com/keycloak/keycloak/issues/45219)) | `nextPageToken`, `maxResults` ≤ **500** | `_links.next` HAL cursor, `limit` ≤ **200** | `After-Cursor` header → `cursor` param, ≤ **50**/page |
| **Incremental** | **`/users/delta`** deltaLink (7-day expiry, 410 → resync); change notifications as trigger | `search=lastUpdated gt {ts}` (eventually consistent, overlap) + [System Log](https://developer.okta.com/docs/reference/system-log-query/) `next`-cursor for deletes; Event Hooks as trigger | [Logs checkpoint pagination](https://auth0.com/docs/api/management/v2/logs/get-logs) (`from`/`take`, retention 1–30 days) / Log Streams + periodic export diff; `updated_at` search best-effort only | **None native** — [admin-events](https://www.keycloak.org/docs/latest/server_admin/index.html) polling (day-granularity dates; misses self-service/LDAP changes) or [Phase Two webhooks](https://github.com/p2-inc/keycloak-events); periodic full resync | [`users.watch`](https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/watch) push (ADD/UPDATE/DELETE/…; re-fetch on notify) + Reports API audit; **no delta/sync token** | SCIM filter `updatedAt ge "{ts}"` polling | **`updated_since`** param + [Events API](https://developers.onelogin.com/api-docs/1/events/get-events) |
| **SCIM/LDAP server exposure** | None (SCIM inbound-only `/bulkUpload`; LDAP only via Entra Domain Services) | No SCIM server; **LDAP Interface** `{org}.ldap.okta.com:636` (read, 1,000-entry pages, RFC 2696) | Inbound SCIM per-connection only; no LDAP | **SCIM server preview in 26.7** (`{realm}/scim/v2`, flag `scim-api`); commercial/OSS plugins | No SCIM; **Secure LDAP** `ldap.google.com:636` (mTLS, premium editions) | **Yes** — SCIM server (≤200 results, no paging/Groups); no LDAP | SCIM client only; virtual LDAP for app auth, not bulk read |
| **Rate limits** | RU budgets: 3.5k–8k RU/10 s per tenant; 150k RU/20 s all-tenant; 429 + `Retry-After` | `/api/v1/users` bucket 100–600/min org-wide; each app defaults to **50%** of bucket; `/logs` 20–120/min; 75 concurrent | Per-tenant tier: Free ~2 rps burst 10; Enterprise prod ~16 rps burst 50; export jobs separately throttled | **None built-in** — self-throttle; don't expose `/admin` publicly ([production guide](https://www.keycloak.org/server/configuration-production)) | Standard Google API quotas; 3-day page-token validity | Standard platform limits; `count` inaccurate on bounded `updatedAt` queries | Standard; 50/page keeps request counts high |

---

## 5. Recommended Architecture for the Gateway

**SPI + adapters (imitate the existing template exactly).** The map found the canonical shape: SPI in domain, impls in adapters, factory switch on `idp_config.provider`:

- New port `IdpUserDirectory` in `modules/authn/authn-domain/.../upstream/` beside `UpstreamIdp.java:9` ("Config-swappable interface to a cluster's runtime IdP"). Methods roughly: `listUsers(pageCursor)`, `deltaSince(syncState)`, `capabilities()`.
- Implementations in `modules/authn/authn-adapters/.../upstream/<vendor>/` — Entra impl reuses **`GraphApiClient`** (`.../upstream/entra/GraphApiClient.java:35`, cached client-credentials mint + bounded SSRF-guarded JSON calls; its javadoc already says it "mirrors KeycloakUpstreamIdp's adapter shape"); Keycloak impl calls the Admin REST API alongside `KeycloakUpstreamIdp.java:37`.
- Selection via the `UpstreamIdpFactory.forConfig` switch (`.../upstream/UpstreamIdpFactory.java:20-27`, today `"keycloak" | "entra"`) — extend or clone as `IdpUserDirectoryFactory`.
- Reuse house HTTP conventions: JDK `HttpClient` with `Redirect.NEVER`, `SsrfGuard` (`modules/authn/authn-domain/.../common/SsrfGuard.java:23`), `BoundedBody` (`common/BoundedBody.java:24`), `TransientHttpStatus` (`common/TransientHttpStatus.java:11`), `IdpUrlAllowList` (`common/IdpUrlAllowList.java:17`). For durable sync jobs, the `idp_ops_outbox` + `IdpOpsDrainWorker` retry loop (`GW1__core.sql:67-81`) is the precedent for background work.
- Maven layout follows the hexagonal convention already used everywhere (`libs/vault/.../port/SecretStore.java:21` vs `adapter/HashiCorpVaultSecretStore.java:35`; `modules/authz/authz-domain/.../port/PolicyEngine.java`).

**Normalized user schema (SCIM Core, RFC 7643 subset):** `id` (gateway UUID), `idp_user_id` (vendor `externalId`), `userName`, `name{given,family,display}`, `emails[]{value,primary}`, `active` (Entra `accountEnabled`, Okta `status`, Google `suspended` inverted, Auth0 `blocked` inverted), `userType` (member/guest/service), `created`/`lastModified` where available, `groups[]` (phase 2), and **`raw_attributes` JSONB** passthrough (WorkOS pattern — lossless vendor data for Discover/Secure enrichment). Plus sync metadata: `first_seen_at`, `last_seen_at`, `deleted_at` (tombstone). Note the gateway has **no user table today** — users exist only as opaque `sub` strings (`user_backend_tokens` in `GW5__egress.sql:3-9`, `owner_sub` on agents `GW2__agents.sql:11`, `audit_events.actor_subject` `GW1__core.sql:55`); a new RLS-isolated cluster-DB table (à la `GW1__core.sql` conventions) is greenfield. Correlating fetched directory users to observed `owner_sub` values is a valuable Discover feature but a separate mapping problem.

**Credentials:** store the directory credential exactly like broker/registrar secrets — `SecretsVault.store(context, plaintext)` → Vault KV v2 path ref in DB (`VaultBackedSecretsVault.java:29`; existing contexts `idp/broker_client_secret`, `idp/registrar_secret` at `IdpConfigService.java:53-54`; loader split with/without secrets in `ClusterIdpConfigLoader.java:38-67`). New context: **`idp/directory_credential`**. Config lives either as new columns on `idp_config` (`GW1__core.sql:17-46`) or by generalizing `registrar_type` (`graph_app` already exists with `registrar_meta jsonb`). Admin writes go through `IdpConfigService` gated by `IDP_CONFIG_WRITE`, with an `IdpConfigProbe`-style live validation (`modules/authn/authn-facade/.../idp/IdpConfigProbe.java:28-33` — SSRF-guarded, redirects never followed) that performs a 1-user test list before saving.

**RBAC gating:** the house pattern is servlet filter (authN) + imperative first-line check (authZ) — no Spring Security annotations. `AdminAuthFilter`/`TenantIdpAuthFilter` registered in `services/gateway/.../config/WebConfig.java:48-80` stash `AdminPrincipal` as request attribute; the controller calls `AdminAuthz.requireCluster(...)` (`modules/authn/authn-domain/.../admin/authz/AdminAuthz.java:15-37`; unbound scope → 404 anti-enumeration, missing permission → 403). New endpoint shape: `GET /gw/v1/clusters/{clusterId}/idp-users` following `IdpConfigController.java:39-44` and `OwnerGrantController.java:25-40` precedents. Serve from the **synced local table** (paginated), never proxy-live to the IdP per UI request — rate limits and latency make live proxying untenable.

---

## 6. Gateway-Side Permissions / Personas

The admin plane has 5 personas (`AdminRole.java:3`: `SUPER_ADMIN, TENANT_ADMIN, GATEWAY_ADMIN, GATEWAY_EDITOR, GATEWAY_VIEWER`) and a hardcoded fail-closed matrix (`AdminRolePermissions.java:13` — "optional PDP overlay narrows, never widens"). Proposal:

- **`IDP_USERS_READ`** (new, in `AdminPermission.java:3`): granted to `GATEWAY_ADMIN`, `GATEWAY_EDITOR`, `GATEWAY_VIEWER` — it's read-only inventory data, same tier as `READ` (the closest precedent, used on `IdpConfigController.get`). Decide whether `GATEWAY_VIEWER` sees emails/UPNs (PII) or a redacted view.
- **Directory-connection *configuration*** (writing the credential, triggering resync): reuse **`IDP_CONFIG_WRITE`** (already in the matrix and `docs/specs/secure-console-api.md`), granted to `GATEWAY_ADMIN` only.
- `SUPER_ADMIN` is hard-rejected from cluster scope (`AdminAuthz.java:24,32` — plane disjointness), so RSA operators do not see tenant user lists by design; `TENANT_ADMIN` reach would require a `requireTenant`-scoped aggregate endpoint if wanted.
- Note the runtime plane (`modules/authz`, Cedar over `IdentityTuple` — `IdentityTuple.java:31`) is untouched; this feature is purely admin-plane. Longer-term, synced `userGroups` could feed the currently-unconsumed `IdentityTuple.userGroups` (GTW-102, `IdentityTupleAssembler.java:51-52`) — out of scope here.

---

## 7. Incremental Sync Strategy + Common Sync-State Abstraction

**Per-IdP mechanisms** (details in §3–4): Entra = deltaLink (true delta, incl. tombstones); Okta = `lastUpdated` watermark with overlap + System Log cursor for deletes; Auth0 = periodic full export diff + Logs checkpoint cursor (retention-bounded!) or Log Streams; Keycloak = periodic full resync + admin-events polling/webhooks (no native delta — the `q` param is exact-match only, no timestamp ranges); Google = full crawl + `users.watch` push notifications (no sync token on Directory API); PingOne = `updatedAt ge` SCIM-filter watermark; OneLogin = `updated_since` watermark + Events API.

**Common abstraction** — one `idp_sync_state` row per (gateway/cluster, provider), RLS-isolated like `idp_config`:

```
sync_state {
  mode:        DELTA_TOKEN | WATERMARK | LOG_CURSOR | FULL_ONLY
  cursor:      opaque text        -- deltaLink URL, ISO watermark, log id/after-cursor
  cursor2:     opaque text        -- secondary channel (e.g. Okta System Log cursor alongside watermark)
  last_full_sync_at, last_delta_sync_at, next_full_resync_at
  status:      OK | RESYNC_REQUIRED | ERROR
}
```

Adapter contract: `initialSync()` streams all users and returns a cursor; `deltaSync(cursor)` returns upserts + tombstones + new cursor, or throws `ResyncRequired` (Entra 410/`syncStateNotFound` after 7 days, Auth0 log retention exceeded, Okta cursor invalidation). **Universal rules:** (1) upsert idempotently — every vendor replays or duplicates; (2) watermark modes overlap the window by several minutes (Okta `search` and Auth0 search index are *eventually consistent*); (3) schedule a **periodic full resync** regardless of mode (weekly, say) — it is the only reliable delete-detection for watermark-based IdPs and reconciles drift everywhere; (4) treat webhooks/notifications (Graph subscriptions, Okta Event Hooks, Google watch channels) as latency-reducing *triggers* that enqueue a delta pull, never as the source of truth — all are at-least-once/lossy and all expire (Graph ~29 days, Google channels, Okta 25-hook cap). Run sync as a background worker using the `idp_ops_outbox`/`IdpOpsDrainWorker` durable-retry pattern, honoring `TransientHttpStatus` and per-vendor 429 semantics.

---

## 8. Tenant Admin Onboarding Steps per IdP

- **Entra:** admin clicks the gateway-generated admin-consent URL (`.../v2.0/adminconsent?client_id=...&scope=https://graph.microsoft.com/.default...`) → consents to `User.Read.All` → SP provisioned in their tenant. If per-tenant registration instead: create app registration, add `User.Read.All` application permission, grant admin consent, create secret/cert, hand over tenant ID + client ID + credential.
- **Okta:** create an OAuth service app (client_credentials + `private_key_jwt`, register gateway JWKS); a **Super Admin** grants `okta.users.read` on the app's Okta API Scopes tab; assign an admin role (Read-only Admin, or custom role + resource set via `POST /oauth2/v1/clients/{clientId}/roles`); disable the "Public client app admins" auto-SUPER_ADMIN org setting; share org URL + client ID.
- **Auth0:** Dashboard → Applications → create M2M app → authorize for Management API (`https://{domain}/api/v2/`) with `read:users` (+ `read:users_app_metadata`, `read:logs`); share domain, client ID, client secret. No consent UI — pure app-to-app.
- **Keycloak:** in the bound realm, create a confidential client with "Service accounts roles" enabled; assign `realm-management:view-users` (plus `view-events` if admin-events polling is used; enable "Save admin events" in Realm settings → Events); share client ID + secret. (The gateway's existing `admin_service_account` registrar may already suffice — verify role set.)
- **Google Workspace:** gateway supplies a service-account client ID; a **super admin** authorizes it under Admin console → Security → API controls → **Domain-wide delegation** with scope `admin.directory.user.readonly` only (multi-party approval may apply); customer creates a dedicated impersonation user with a custom admin role "Users → Read" (user must have logged in once) and shares that user's email.
- **PingOne:** create a Worker application in the environment; assign role **`Identity Data Read-Only Admin`** scoped to that environment; share env ID + region + client ID/secret.
- **OneLogin:** Developers → API Credentials → New Credential with scope **`Read Users`**; share subdomain + client ID/secret.

---

## 9. Risks, Gotchas, Open Questions

**Risks/gotchas:**
1. **Auth0's 1,000-record cap** on `GET /api/v2/users` makes it architecturally different: full enumeration requires the async export-job flow (poll job, download gzip within the ~60 s `location` validity, job deleted after 24 h) — the adapter SPI must accommodate an async/file-based path, not just page loops.
2. **Delete detection is the hard part** everywhere except Entra delta: Okta hard-deletes vanish silently (System Log `user.lifecycle.delete.completed` is the only signal), Keycloak admin events miss non-admin-API changes, watermark IdPs never tombstone. Periodic full resync is non-negotiable.
3. **Entra B2C / External ID external tenants**: no delta, no `$search`/`$count` — the Entra adapter needs a degraded FULL_ONLY mode.
4. **Multi-tenant Entra app = shared blast radius**: one vendor credential spans all customer tenants; mitigate with certificate or federated (workload-identity) credentials and the 150k RU/20 s all-tenant budget in mind.
5. **Keycloak has no rate limiting** — an aggressive sync (especially N+1 group calls) can saturate a customer's DB/LDAP; self-throttle and schedule off-peak. Federated-LDAP realms list unreliably ([#21465](https://github.com/keycloak/keycloak/issues/21465)).
6. **PII/tenancy**: a synced user table is the most sensitive data the gateway will hold; must be RLS-isolated per gateway like `idp_config`, with retention/erasure semantics defined (GDPR).
7. **Existing gap interplay**: private_key_jwt is unsupported on Entra-bound clusters (`docs/design/gtw-110-entra-private-key-jwt.md`) — but Okta *mandates* private_key_jwt for service apps; credential-type handling must be per-vendor.
8. **Okta OAuth needs scope ∩ admin role** — granting `okta.users.read` alone silently isn't enough; document this or onboarding will fail with confusing 403s.

**Open questions:**
- Reuse the `graph_app` registrar credential for Entra directory reads, or require a separate credential/context (`idp/directory_credential`)? Separation is cleaner least-privilege; reuse is one fewer onboarding step.
- Where does the synced user table live — cluster DB (per-gateway, RLS, matches `idp_config`) or control plane? Cluster DB looks right since the IdP binding is per-gateway.
- Does the Discover UI consume this from the gateway API or from the separate gRPC discovery backend (`rsa-unified-ui/src/lib/discovery.ts:17-19`, connectors in `ConnectorForm.tsx:56-60`)? Two connector stacks (UI `msgraph` connector vs this feature) risk duplication — product decision needed.
- Is group membership in v1 scope? It roughly doubles permission asks (`Directory.Read.All`, `okta.groups.read`, etc.) and API cost (N+1 on Okta/Keycloak).
- Which personas may see PII fields; is a redacted viewer projection needed?
- Do we need `signInActivity`-class data ("stale accounts") for Secure, pulling in P1/P2 + `AuditLog.Read.All`?

---

## 10. Suggested Follow-Up Tickets

1. **GTW-xxx: `IdpUserDirectory` SPI + sync-state schema** — port in `authn-domain`, factory, `idp_sync_state` + normalized `idp_users` cluster-DB migrations (RLS), SCIM-core mapping spec.
2. **GTW-xxx: Entra user-directory adapter** — Graph `GET /users` full crawl + `/users/delta`, reusing `GraphApiClient`; 410/expiry resync handling; B2C FULL_ONLY fallback.
3. **GTW-xxx: Entra admin-consent onboarding flow** — consent URL generation, redirect handling, credential vaulting under `idp/directory_credential`, probe-before-save.
4. **GTW-xxx: Keycloak user-directory adapter** — Admin REST paging with `view-users` service account; evaluate the 26.7 SCIM preview as an alternative path.
5. **GTW-xxx: `IDP_USERS_READ` permission + `/gw/v1/clusters/{id}/idp-users` read API** — `AdminPermission`/`MATRIX` change, controller with `requireCluster`, pagination/filtering contract for the console (extend `docs/specs/secure-console-api.md`).
6. **GTW-xxx: Background sync worker** — outbox-style scheduler, per-vendor throttling/backoff, full-resync cadence, metrics/alerting on sync staleness.
7. **GTW-xxx: Okta adapter** (service app + `okta.users.read` + admin-role onboarding; `lastUpdated` watermark + System Log deletes).
8. **GTW-xxx: Auth0 adapter** (export-job flow + logs checkpoint) — validates the async path in the SPI.
9. **GTW-xxx (spike): generic SCIM-client connector** — covers PingOne/PingDirectory/Keycloak-SCIM/self-hosted; cheap given SCIM-shaped schema.
10. **GTW-xxx (product): reconcile with Discover connector stack** — decide single source of truth between the UI's gRPC discovery backend connectors and gateway-native directory sync.
11. **GTW-xxx (later): correlate directory users with observed `owner_sub`/`user_backend_tokens`** — joins directory identity to runtime activity for Secure.