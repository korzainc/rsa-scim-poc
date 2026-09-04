# GTW-179 SCIM POC — we are the SCIM server; the IdP provisioning client pushes to us.
# `make dev` runs the SCIM server/API (:5175) and the web dev server (:5173) together.

.PHONY: help install dev server web build start stop clean tunnel simulate token reset kc-up kc-seed kc-sync kc-down

help:
	@echo "make install    Install all dependencies (root + web workspace)"
	@echo "make token      Generate a SCIM bearer token to put in .env"
	@echo "make dev        Run SCIM server + web dev server together"
	@echo "make tunnel     Expose the SCIM server publicly via ngrok (needed for Entra)"
	@echo "make simulate   Replay an IdP-shaped SCIM provisioning cycle (demo without Entra)"
	@echo "make server     Run only the SCIM server on :5175"
	@echo "make web        Run only the web dev server on :5173"
	@echo "make build      Production build of the web app (web/dist)"
	@echo "make start      Build then serve UI + SCIM from one process on :5175"
	@echo "make stop       Kill any running POC server left in the background"
	@echo "make reset      Wipe the provisioned-user store (data/)"
	@echo "make clean      Remove node_modules, build output and data"
	@echo "make kc-up      Start a Keycloak 26.7 (SCIM server enabled) on :8090"
	@echo "make kc-seed    Create realm/client/test-users in that Keycloak"
	@echo "make kc-sync    Pull its users over SCIM into this POC (generic SCIM->SCIM sync)"
	@echo "make kc-down    Remove the Keycloak container"

install:
	npm install

token:
	@echo "SCIM_TOKEN=$$(openssl rand -hex 24)"
	@echo "(copy the line above into .env — and paste the value into Entra's Secret Token field)"

dev:
	npm run dev

server:
	node server/index.js

web:
	npm run dev -w web

build:
	npm run build

start: build
	node server/index.js

# Entra's provisioning service must reach us over public HTTPS.
# Tenant URL in Entra / SCIM Validator = the printed https URL + /scim/v2
# Note on free-tier ngrok: browsers get a one-time warning page (click through
# once); server-side SCIM clients (Entra, the SCIM Validator) pass straight
# through. `make tunnel-cf` is a no-account alternative without the warning page.
tunnel:
	ngrok http 5175

tunnel-cf:
	cloudflared tunnel --url http://localhost:5175

simulate:
	node scripts/simulate-idp.mjs

# --- Keycloak-as-SCIM-source demo (pull direction) ---------------------------
# Keycloak has no outbound SCIM client, but 26.6+ ships an experimental SCIM
# SERVER (feature flag scim-api). These targets spin a separate Keycloak on
# :8090 (the monorepo stack on :8080 is untouched), seed a realm + users, then
# pull them over SCIM into this POC's store with the generic scim-sync script.
kc-up:
	docker start scim-poc-keycloak 2>/dev/null || docker run -d --name scim-poc-keycloak -p 8090:8080 \
	  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
	  quay.io/keycloak/keycloak:26.7 start-dev --features=scim-api

kc-seed:
	bash scripts/keycloak-seed.sh

kc-sync:
	node scripts/scim-sync.mjs

kc-down:
	-docker rm -f scim-poc-keycloak

stop:
	-pkill -f "node server/index.js"

reset:
	rm -rf data

clean:
	rm -rf node_modules web/node_modules web/dist data
