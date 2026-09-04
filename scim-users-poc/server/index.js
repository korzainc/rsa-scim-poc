// GTW-179 POC v2 — receive ALL users from the bounded IdP over SCIM 2.0.
//
// We are the SCIM SERVER; the IdP's provisioning engine (Entra, Okta, OneLogin,
// Ping) is the SCIM CLIENT that pushes creates/updates/deactivations/deletes to
// /scim/v2/*. The UI reads the resulting local store via /api/* — the browser
// never touches SCIM or the bearer token.
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, normalizeUser } from './store.js';
import { scimRouter } from './scim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT ?? 5175);
const TOKEN = process.env.SCIM_TOKEN?.trim() ?? '';
const SCIM_BASE_PATH = '/scim/v2';

const store = new Store(path.join(root, 'data', 'store.json'));

// Ring buffer of recent SCIM requests, surfaced live in the UI.
const events = [];
let seq = 0;
const activity = {
  push(req, status, summary) {
    events.push({
      id: ++seq,
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl.replace(/\?.*$/, '') + (req.query?.filter ? `?filter=${req.query.filter}` : ''),
      status,
      summary: summary ?? null,
      agent: (req.get('user-agent') ?? '').slice(0, 80) || null,
    });
    if (events.length > 300) events.splice(0, events.length - 300);
  },
};

const app = express();
app.set('query parser', 'simple');
// Behind ngrok/cloudflared: trust X-Forwarded-* so meta.location URIs come out https.
app.set('trust proxy', true);

app.use(SCIM_BASE_PATH, scimRouter({
  store,
  token: TOKEN,
  basePath: SCIM_BASE_PATH,
  activity,
}));

// --- UI API (local only, no SCIM token involved) ------------------------------

app.get('/api/status', (_req, res) => {
  res.json({
    tokenConfigured: Boolean(TOKEN),
    scimPath: SCIM_BASE_PATH,
    port: PORT,
    users: store.liveUsers().length,
    deleted: store.users.filter((u) => u.deletedAt).length,
    groups: store.liveGroups().length,
    lastPushAt: events.length ? events[events.length - 1].ts : null,
  });
});

app.get('/api/users', (_req, res) => {
  res.json({ users: store.users.map(normalizeUser) });
});

app.get('/api/activity', (_req, res) => {
  res.json({ events: events.slice(-100).reverse() });
});

// The #1 misconfiguration: a Tenant URL missing the /scim/v2 path. Without this
// guard those requests would fall through to the SPA fallback and return the UI's
// index.html with a 200 — which SCIM clients choke on with a confusing error.
app.use(/^\/(Users|Groups|ServiceProviderConfig|Schemas|ResourceTypes)(\/.*)?$/, (req, res) => {
  activity.push(req, 404, `SCIM request hit the root — Tenant URL is missing ${SCIM_BASE_PATH}`);
  res.status(404).type('application/scim+json').json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: '404',
    detail: `SCIM endpoints live under ${SCIM_BASE_PATH} — set the Tenant/endpoint URL to https://<host>${SCIM_BASE_PATH}`,
  });
});

// Serve the built UI when present so `npm run start` is a one-process demo.
const dist = path.resolve(root, 'web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith(SCIM_BASE_PATH)) {
      return next();
    }
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[scim] listening on http://localhost:${PORT}`);
  console.log(`[scim] SCIM base: http://localhost:${PORT}${SCIM_BASE_PATH} (tenant URL = your ngrok https URL + ${SCIM_BASE_PATH})`);
  console.log(
    TOKEN
      ? '[scim] bearer token configured'
      : '[scim] WARNING: SCIM_TOKEN not set — SCIM endpoints will answer 503 until you set it in .env',
  );
  console.log(`[scim] store: ${store.liveUsers().length} users, ${store.liveGroups().length} groups`);
});
