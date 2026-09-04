// Generic SCIM→SCIM sync: reads all users from ANY source SCIM server and
// upserts them into ANY target SCIM server (by default, this POC's own).
// Nothing here is Keycloak-specific — the source just happens to be Keycloak's
// experimental SCIM Realm API when run via `make kc-sync`. This is a prototype
// of the "generic SCIM-client connector" from the GTW-179 research.
//
// Env (see .kc-source.env written by keycloak-seed.sh):
//   SOURCE_SCIM_BASE      e.g. http://localhost:8090/realms/poc/scim/v2
//   SOURCE_TOKEN          static bearer for the source, OR mint one via:
//   SOURCE_TOKEN_URL + SOURCE_CLIENT_ID + SOURCE_CLIENT_SECRET   (client credentials)
//   TARGET_SCIM_BASE      default http://localhost:5175/scim/v2
//   SCIM_TOKEN            bearer for the target (from .env)
import 'dotenv/config';
import fs from 'node:fs';

// Layer in .kc-source.env if present (does not override real env).
try {
  for (const line of fs.readFileSync(new URL('../.kc-source.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* not seeded yet */ }

const SOURCE = process.env.SOURCE_SCIM_BASE;
const TARGET = process.env.TARGET_SCIM_BASE ?? `http://localhost:${process.env.PORT ?? 5175}/scim/v2`;
const TARGET_TOKEN = process.env.SCIM_TOKEN?.trim();

if (!SOURCE) { console.error('SOURCE_SCIM_BASE missing — run `make kc-seed` first (or set env)'); process.exit(1); }
if (!TARGET_TOKEN) { console.error('SCIM_TOKEN missing in .env'); process.exit(1); }

async function sourceToken() {
  if (process.env.SOURCE_TOKEN) return process.env.SOURCE_TOKEN;
  const res = await fetch(process.env.SOURCE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SOURCE_CLIENT_ID,
      client_secret: process.env.SOURCE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`source token mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function scim(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/scim+json',
      Accept: 'application/scim+json, application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${base}${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// --- pull all users from the source (standard SCIM paging) --------------------
const srcTok = await sourceToken();
const users = [];
let startIndex = 1;
for (;;) {
  const page = await scim(SOURCE, srcTok, 'GET', `/Users?startIndex=${startIndex}&count=50`);
  users.push(...(page.Resources ?? []));
  if (users.length >= (page.totalResults ?? 0) || !(page.Resources ?? []).length) break;
  startIndex += page.Resources.length;
}
console.log(`source: ${users.length} users from ${SOURCE}`);

// --- upsert into the target -----------------------------------------------------
let created = 0, updated = 0;
for (const u of users) {
  const { id, meta, groups, password, ...attrs } = u; // target assigns its own id
  if (!attrs.externalId && id) attrs.externalId = id; // keep the source identity
  if (!attrs.userName) { console.warn('skipping user without userName', id); continue; }

  const found = await scim(TARGET, TARGET_TOKEN, 'GET',
    `/Users?filter=${encodeURIComponent(`userName eq "${attrs.userName}"`)}`);
  if (found.totalResults > 0) {
    await scim(TARGET, TARGET_TOKEN, 'PUT', `/Users/${found.Resources[0].id}`, attrs);
    updated++;
    console.log(`  updated ${attrs.userName}`);
  } else {
    await scim(TARGET, TARGET_TOKEN, 'POST', '/Users', attrs);
    created++;
    console.log(`  created ${attrs.userName}`);
  }
}
console.log(`\nDone: ${created} created, ${updated} updated → ${TARGET}. Open the Owners UI to see them.`);
