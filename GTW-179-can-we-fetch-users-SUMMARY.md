# GTW-179 — Can We Fetch the Users List from an IdP? (Plain-Language Summary)

Companion to the full research doc (`GTW-179-idp-user-fetching-research.md`). This one answers only the fundamental question, clearly.

---

## The Question

> Can the gateway fetch the list of all users (and their info) registered in a customer's IdP, through APIs the IdP exposes?

## The Answer

**Yes. Every major IdP exposes an official admin/management REST API that lets a backend service list every user in the tenant, with their profile info.** This is a fully supported, documented use case for all of them — not a workaround.

**But there is no single shared API that works across all IdPs.** Each vendor has its own API, its own authentication setup, and its own permission model. So the gateway needs **one small adapter per IdP**, all returning the same normalized user object. There is no way around this — it's how every product in this space (WorkOS, SailPoint, ConductorOne) does it too.

---

## Per-IdP: Can we fetch all users? How?

| IdP | Fetch all users? | The API | What the customer admin must grant us |
|---|---|---|---|
| **Entra ID** | ✅ Yes | Microsoft Graph: `GET /v1.0/users` | Admin consent for app permission `User.Read.All` (one click on a consent URL we generate) |
| **Okta** | ✅ Yes | `GET /api/v1/users` | OAuth service app with scope `okta.users.read` + a read-only admin role |
| **Auth0** | ✅ Yes (with a twist) | Management API `GET /api/v2/users`; **beyond 1,000 users must use the bulk export job** | M2M app authorized with scope `read:users` |
| **Keycloak** | ✅ Yes | Admin REST API: `GET /admin/realms/{realm}/users` | Service-account client with role `realm-management:view-users` |
| **Google Workspace** | ✅ Yes | Admin SDK: `GET /admin/directory/v1/users` | Service account with domain-wide delegation, scope `admin.directory.user.readonly` |
| **PingOne** | ✅ Yes | `GET /v1/environments/{envId}/users` | Worker app with role `Identity Data Read-Only Admin` |
| **OneLogin** | ✅ Yes | `GET /api/2/users` | API credential with scope `Read Users` |

### What info do we get?

All of them return, per user: unique ID, username/login, display name, email(s), active/suspended status, created/updated timestamps, and vendor-specific extras (department, job title, custom attributes...). Group membership is available everywhere too, but usually costs extra API calls and (on Entra) an extra permission — treat it as phase 2.

### The one-time setup per customer (this is the real "cost")

Fetching users always requires the customer's IdP admin to do a **one-time grant**: consent to a permission (Entra), create a service app/credential with a read-users scope (all others). This is normal — every SaaS product that lists IdP users onboards this way. The important design consequences:

1. **The existing SSO/OIDC binding is NOT enough.** The OIDC login flow only proves who the *current* user is (UserInfo endpoint = one user only, by design). Listing *all* users is an admin-level operation and always needs its own server-to-server credential with a directory-read permission. On Entra specifically: our existing app registration can be reused, but the customer must additionally consent to `User.Read.All` — the SSO consent alone gives a token that Graph rejects with 403.
2. **The credential is read-only and least-privilege** on every IdP — no vendor forces us to ask for write or full-directory-admin access just to list users.

---

## Why isn't there one generic API for all IdPs?

The only standard that looks right is **SCIM 2.0** (standard REST API + user schema, literally has `GET /Users`). The problem is **direction**: IdPs implement SCIM as a *client* — they push users into other apps for provisioning. They do not run a SCIM *server* over their own directory that we could query. Entra, Okta, Auth0, Google, OneLogin: none of them let us pull users via SCIM. (Only PingOne does, badly capped, and Keycloak has an experimental one as of 26.6.)

So: **SCIM is useless as the transport, but perfect as the schema.** Our adapter interface should return users shaped like the SCIM Core User (id, userName, name, emails, active, ...) — then every vendor adapter is just "call vendor API, map fields," and everything downstream (DB table, UI, Secure/Discover) is vendor-agnostic.

---

## Secondary: keeping track of new users

This works everywhere but the mechanism differs in quality — details in the full doc. Short version:

- **Entra is the best**: `GET /users/delta` gives true incremental changes including deletions.
- **Okta, PingOne, OneLogin**: poll with an "updated since {timestamp}" filter.
- **Auth0, Keycloak, Google**: no real delta — periodic re-fetch, optionally sped up by event logs/webhooks.
- **Universal rule**: whatever the mechanism, a periodic full re-sync (e.g. weekly) is still needed as the safety net, mainly to catch deletions.

Push notifications (Graph change notifications, Okta event hooks, Google watch) exist but are best treated as *triggers* to sync sooner, never as the source of truth.

---

## Bottom Line

1. **Fetching all users + their info from the bounded IdP is possible on every IdP we care about, via official, supported, read-only APIs.** The feature is feasible — full stop.
2. **A generic single-protocol client is not possible; a generic adapter interface is.** One `IdpUserDirectory` port, one thin adapter per vendor (~the same pattern as our existing `UpstreamIdp` abstraction), normalized to a SCIM-shaped user model.
3. **The per-customer cost is a one-time admin grant** of a read-only directory permission — a standard onboarding step we must design (consent URL for Entra, credential entry for the rest).
4. **Start with Entra**: best API, best incremental story, and our codebase already has a Graph client and a `graph_app` credential type to build on.
