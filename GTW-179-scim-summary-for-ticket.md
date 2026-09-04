# GTW-179 — SCIM-based user fetching: findings summary

## What is SCIM

SCIM 2.0 (System for Cross-domain Identity Management, RFC 7643/7644) is the open standard for exchanging user identity data: a normalized User/Group schema plus a REST API (`/Users`, `/Groups`, filtering, PATCH). It defines two roles: a **SCIM server** has a *mailbox* — it exposes `/scim/v2/Users` and receives users someone else pushes in; a **SCIM client** *writes the letters* — its provisioning engine sends users to any address an admin configures.

**"Supports SCIM" is ambiguous — direction is everything.** Vendors say "SCIM support" for either role. For this feature the gateway is the mailbox, so only IdPs with an outbound **client** help us. The litmus test: *is there a screen in the IdP's admin console where the customer pastes OUR SCIM URL and OUR bearer token?*

## The model we validated

**The gateway acts as the SCIM server** (one implementation, IdP-agnostic); each tenant's IdP is configured as a SCIM client pointing at the gateway's endpoint (URL + bearer token). User data lands in a gateway-owned store, which the UI reads — the IdP is never queried live. Incremental sync is inherent: every change arrives as a discrete SCIM operation, including deactivations (`active=false`) and deletes.

## Which IdPs can push to us (verified against official docs, Aug 2026)

| IdP | Outbound SCIM client → custom URL? | Notes |
|---|---|---|
| Microsoft Entra ID | ✅ Yes | Enterprise app → Provisioning; ~40-min cycles + on-demand; needs Entra ID P1 for non-gallery apps |
| Okta | ✅ Yes | Custom SCIM app integration (Provisioning tab); may need Lifecycle Management SKU |
| OneLogin | ✅ Yes | "SCIM Provisioner with SAML" templates; base URL + bearer token |
| PingOne | ✅ Yes | Generic "SCIM Outbound" provisioning connection |
| PingFederate | ✅ Yes* | Outbound provisioning channel; *requires LDAP/AD as the user source |
| JumpCloud | ✅ Yes | Custom SCIM Identity Management on any SSO app (SCIM 2.0 only) |
| authentik (OSS) | ✅ Yes | Native "SCIM Provider" backchannel; real-time + hourly sync |
| Google Workspace | ❌ No* | Has an outbound SCIM engine, but **closed**: pushes only to Google's ~60-app catalog — no custom URL field (see below) |
| Auth0 | ❌ No* | "Supports SCIM" as a **server only** ("Inbound SCIM") — see below |
| AWS IAM Identity Center | ❌ No | Inbound SCIM server only |
| Zitadel | ❌ No | SCIM server (preview) only; outbound client is an open roadmap issue |
| FusionAuth | ❌ No | SCIM server only, no outbound plans stated |
| **Keycloak** | ❌ **No** | See below |

### The two that "support SCIM" but still can't push to us

**Auth0** genuinely supports SCIM — as a *server*. Its feature is literally named **Inbound SCIM**: each enterprise connection can expose a SCIM endpoint + token so a customer's *upstream* IdP (their Entra/Okta) can push employees **into Auth0**. The arrow only points one way:

```
Customer's Entra ──SCIM push──▶ Auth0          ✅ what Auth0 supports
Auth0 ──SCIM push──▶ our gateway               ❌ does not exist
```

Auth0 never initiates SCIM calls to an external URL; its docs route outbound sync to "build it yourself" via events/webhooks. So for our purposes it needs a pull adapter (Management API).

**Google Workspace** is the trickier case: it *does* have an outbound SCIM provisioning engine — but it can only push to apps in **Google's own curated catalog** (~60 apps: Slack, Asana, Adobe…). There is no "custom SCIM app" option and no field to enter an arbitrary URL + token. Google is a SCIM client, just a **closed** one — unless the gateway someday becomes a listed catalog partner, it can't be a target. Functionally, for us, that equals "no": Google-bound tenants need the pull adapter (Admin SDK Directory API).

## Keycloak limitation (why an Entra-style end-to-end POC isn't possible)

Stock Keycloak ships **no outbound SCIM client** — there is no screen to paste a SCIM server URL + token, so it cannot push users to the gateway the way Entra does. The Keycloak team has explicitly deferred outbound SCIM to "the future" (Feb 2026 survey-feedback post); the SCIM feature they *did* ship (experimental in 26.2, preview in 26.7) is a **SCIM server**: `/realms/{realm}/scim/v2`, behind the `scim-api` feature flag plus a per-realm `scimApiEnabled` switch, with a token-audience requirement of `{realm URL}/scim/v2`. A community plugin (`suvera/keycloak-scim2-storage`) adds outbound push, but it targets Keycloak 25, is community-maintained, and asking customers to install third-party plugins on their IdP is not viable for the product.

**Workaround demonstrated in the POC:** we run SCIM in the *pull* direction for Keycloak — a generic SCIM→SCIM sync reads users from Keycloak's SCIM server and upserts them into the gateway's SCIM server (same store, same normalized model, zero changes to our server). Consequences vs. Entra's push: sync runs on *our* schedule (a background worker in production, `make kc-sync` in the POC), nothing flows automatically on user creation, and delete detection requires a full-list diff (disables do flow as `active=false`).

## POC results

- Built a standalone SCIM 2.0 server + UI (unified-ui style, "Owners" tab) — users, live SCIM activity feed, file-backed store.
- **Passes the Microsoft Entra SCIM Validator** (both simple and verbose PATCH modes, schema discovery included) after fixing real compliance quirks the validator caught: string booleans (`"True"`), absolute `meta.location` URIs, filter-path PATCH coercion (`roles[primary eq "True"]`), enterprise `manager` sent as a bare string, group `displayName` uniqueness (409), and not advertising `password` (Entra rejects it).
- Live Entra push pending only org-side setup: creating the enterprise app requires the Cloud Application Administrator role (+ Entra ID P1 for non-gallery provisioning).
- Keycloak pull working end to end: 26.7 container → seeded realm/users → SCIM pull → gateway store/UI, incremental upsert verified.

## Bottom line

One SCIM server in the gateway covers **Entra, Okta, OneLogin, Ping, JumpCloud and authentik with configuration only** — no per-IdP code. **Auth0, Google Workspace and Keycloak cannot push**, so they need pull adapters (native admin APIs, or a generic SCIM-client connector for IdPs that expose SCIM servers, like Keycloak/Zitadel). SCIM wins as the normalized schema and one transport leg; a small pull-connector layer is still required for full IdP coverage — consistent with the original research recommendation.
