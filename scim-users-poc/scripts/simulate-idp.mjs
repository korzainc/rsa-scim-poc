// Simulates an IdP's SCIM provisioning client (what Entra does on its ~40-min
// cycles) against the local SCIM server — same wire protocol, same endpoints,
// same auth. Lets you demo/verify the whole path without waiting for Entra:
//   lookup (GET filter) → create (POST) → update (PATCH) → deactivate → delete.
import 'dotenv/config';

const PORT = Number(process.env.PORT ?? 5175);
const TOKEN = process.env.SCIM_TOKEN?.trim();
const BASE = `http://localhost:${PORT}/scim/v2`;

if (!TOKEN) {
  console.error('SCIM_TOKEN missing — set it in .env first (openssl rand -hex 24)');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/scim+json',
  'User-Agent': 'SCIM-Client-Simulator (Entra-provisioning-shaped)',
};

async function scim(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: json };
}

const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const PEOPLE = [
  ['Ava Stone', 'Engineering', 'Software Engineer'],
  ['Noah Patel', 'Engineering', 'SRE'],
  ['Mia Kim', 'Security', 'Security Analyst'],
  ['Liam Novak', 'Product', 'Product Manager'],
  ['Zoe Silva', 'Security', 'Security Engineer'],
  ['Ethan Mensah', 'Finance', 'Controller'],
  ['Isla Weber', 'IT Operations', 'Systems Admin'],
  ['Arjun Rossi', 'Engineering', 'Software Engineer'],
  ['Priya Tanaka', 'Product', 'Designer'],
  ['Kai Iyer', 'Sales', 'Account Executive'],
  ['Lena Berg', 'Engineering', 'Engineering Manager'],
  ['Omar Costa', 'IT Operations', 'Support Engineer'],
];

function scimUser([name, dept, title], i) {
  const [given, family] = name.split(' ');
  const userName = `${given}.${family}@contoso.com`.toLowerCase();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', ENTERPRISE],
    externalId: `aad-${String(i).padStart(4, '0')}`,
    userName,
    active: true,
    displayName: name,
    name: { givenName: given, familyName: family },
    emails: [{ primary: true, type: 'work', value: userName }],
    title,
    userType: i % 7 === 6 ? 'Guest' : 'Member',
    [ENTERPRISE]: { department: dept, employeeNumber: String(1000 + i) },
  };
}

// 1. Test Connection — exactly what Entra's "Test Connection" button does.
console.log('→ test connection (GET /Users with a non-existent userName filter)');
await scim('GET', `/Users?filter=userName+eq+%22connection.test%40invalid%22`);

// 2. Provisioning cycle: lookup by userName, create when absent.
for (const [i, person] of PEOPLE.entries()) {
  const u = scimUser(person, i);
  const found = await scim('GET', `/Users?filter=userName+eq+${encodeURIComponent(`"${u.userName}"`)}`);
  if (found.body.totalResults === 0) {
    const created = await scim('POST', '/Users', u);
    console.log(`  created ${u.userName} (${created.status})`);
    u.id = created.body.id;
  } else {
    u.id = found.body.Resources[0].id;
    console.log(`  exists  ${u.userName}`);
  }
  PEOPLE[i].id = u.id;
  await new Promise((r) => setTimeout(r, 120));
}

// 3. Updates, Entra-style PATCH (capitalized op, string booleans, URN paths).
const [, , mia, liam, , ethan] = PEOPLE;
console.log('→ PATCH title/department change (Mia)');
await scim('PATCH', `/Users/${mia.id}`, {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [
    { op: 'Replace', path: 'title', value: 'Senior Security Analyst' },
    { op: 'Replace', path: `${ENTERPRISE}:department`, value: 'Security Engineering' },
  ],
});

console.log('→ PATCH deactivate (Liam) — Entra sends active as the string "False"');
await scim('PATCH', `/Users/${liam.id}`, {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
});

console.log('→ DELETE hard-deprovision (Ethan)');
await scim('DELETE', `/Users/${ethan.id}`);

// 4. A group push, as "Sync all users and groups" scope would produce.
console.log('→ POST /Groups + member PATCH');
const grp = await scim('POST', '/Groups', {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
  externalId: 'aad-grp-0001',
  displayName: 'Engineering',
  members: [],
});
if (grp.status === 201) {
  await scim('PATCH', `/Groups/${grp.body.id}`, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [
      { op: 'Add', path: 'members', value: PEOPLE.filter((p) => p[1] === 'Engineering').map((p) => ({ value: p.id })) },
    ],
  });
}

const all = await scim('GET', '/Users?count=200');
console.log(`\nDone. Server now holds ${all.body.totalResults} live users. Open the UI to see them.`);
