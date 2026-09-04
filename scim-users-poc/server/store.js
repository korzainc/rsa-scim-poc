// File-backed store for SCIM resources + RFC 7644 PATCH semantics.
//
// Records keep the raw SCIM resource exactly as the IdP sent it (that's the
// "raw_attributes passthrough" idea from the GTW-179 research) plus our own
// bookkeeping. DELETE tombstones instead of erasing so the UI can show that
// deprovisioning arrived over the wire.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENTERPRISE_EXT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

export class Store {
  constructor(file) {
    this.file = file;
    this.users = [];
    this.groups = [];
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.users = data.users ?? [];
      this.groups = data.groups ?? [];
    } catch {
      /* first boot — empty store */
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ users: this.users, groups: this.groups }, null, 1));
    }, 150);
  }

  // --- lookups (live = not tombstoned; SCIM endpoints only ever see live) ----
  liveUsers() {
    return this.users.filter((u) => !u.deletedAt);
  }
  liveGroups() {
    return this.groups.filter((g) => !g.deletedAt);
  }
  userById(id) {
    return this.liveUsers().find((u) => u.id === id) ?? null;
  }
  groupById(id) {
    return this.liveGroups().find((g) => g.id === id) ?? null;
  }

  createUser(resource) {
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), raw: resource, createdAt: now, updatedAt: now, deletedAt: null };
    this.users.push(rec);
    this.save();
    return rec;
  }
  createGroup(resource) {
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), raw: resource, createdAt: now, updatedAt: now, deletedAt: null };
    this.groups.push(rec);
    this.save();
    return rec;
  }
  touch(rec) {
    rec.updatedAt = new Date().toISOString();
    this.save();
  }
  tombstone(rec) {
    rec.deletedAt = new Date().toISOString();
    this.save();
  }
}

// --- attribute access -------------------------------------------------------

/**
 * Splits a SCIM attribute path into {ext, attr, filter, sub}.
 * Handles the shapes Entra actually sends:
 *   active
 *   name.givenName
 *   emails[type eq "work"].value
 *   urn:...:enterprise:2.0:User:department        (URN-prefixed, colon-joined)
 *   urn:...:enterprise:2.0:User:manager.value
 */
export function parsePath(rawPath) {
  let ext = null;
  let p = rawPath.trim();
  if (p.startsWith(ENTERPRISE_EXT)) {
    ext = ENTERPRISE_EXT;
    p = p.slice(ENTERPRISE_EXT.length).replace(/^[:.]/, '');
  }
  const m = p.match(/^([\w$-]+)(?:\[(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"\])?(?:\.([\w$-]+))?$/i);
  if (!m) return null;
  return { ext, attr: m[1], filter: m[2] ? { attr: m[2], value: m[3] } : null, sub: m[4] ?? null };
}

function container(resource, parsed, create) {
  if (!parsed.ext) return resource;
  if (!resource[parsed.ext] && create) resource[parsed.ext] = {};
  return resource[parsed.ext] ?? null;
}

/** Entra sometimes sends booleans as the strings "True"/"False". */
export function coerce(value) {
  if (value === 'True' || value === 'true') return true;
  if (value === 'False' || value === 'false') return false;
  return value;
}

const MULTI_VALUED = ['emails', 'phoneNumbers', 'addresses', 'roles', 'ims', 'photos', 'entitlements', 'x509Certificates', 'groups'];

/**
 * Entra's client (and Microsoft's SCIM Validator) send some booleans as the
 * strings "True"/"False" — e.g. roles[].primary — but a response that echoes the
 * string back is not a valid SCIM2 Core User. Normalize on every write.
 */
export function normalizeBooleans(resource) {
  if ('active' in resource) resource.active = coerce(resource.active);
  for (const attr of MULTI_VALUED) {
    if (!Array.isArray(resource[attr])) continue;
    for (const el of resource[attr]) {
      if (el && typeof el === 'object' && 'primary' in el) el.primary = coerce(el.primary);
    }
  }
  return resource;
}

export function applyPatchOp(resource, op) {
  const kind = String(op.op ?? '').toLowerCase();
  if (kind === 'add' || kind === 'replace') {
    if (!op.path) {
      // No path: value is an object of attribute/value pairs, keys may themselves be paths.
      for (const [k, v] of Object.entries(op.value ?? {})) setByPath(resource, k, coerce(v));
      return;
    }
    setByPath(resource, op.path, coerce(op.value));
  } else if (kind === 'remove') {
    if (!op.path) throw new Error('remove requires a path');
    removeByPath(resource, op.path);
  } else {
    throw new Error(`unsupported patch op "${op.op}"`);
  }
}

/**
 * Value-filter match with boolean coercion: the IdP may filter on
 * `roles[primary eq "True"]` (string) while we store `primary: true` (boolean,
 * normalized on write) — both must match.
 */
function filterMatches(el, filter) {
  const got = coerce(el?.[filter.attr]);
  const want = coerce(filter.value);
  return got === want || String(got) === String(want);
}

function setByPath(resource, rawPath, value) {
  const parsed = parsePath(rawPath);
  if (!parsed) throw new Error(`unsupported path "${rawPath}"`);
  const target = container(resource, parsed, true);

  // Entra's simple (non-verbose) PATCH sends the enterprise manager as a bare
  // string id (sometimes wrapped in an array); the schema says manager is a
  // complex attribute, so normalize to {value: "<id>"}.
  if (parsed.attr === 'manager' && !parsed.sub) {
    if (Array.isArray(value)) value = value[0];
    if (value !== null && value !== undefined && typeof value !== 'object') {
      value = { value: String(value) };
    }
  }

  if (parsed.filter) {
    // Multi-valued attribute, e.g. emails[type eq "work"].value
    if (!Array.isArray(target[parsed.attr])) target[parsed.attr] = [];
    let el = target[parsed.attr].find((e) => filterMatches(e, parsed.filter));
    if (!el) {
      el = { [parsed.filter.attr]: coerce(parsed.filter.value) };
      target[parsed.attr].push(el);
    }
    if (parsed.sub) el[parsed.sub] = value;
    else Object.assign(el, typeof value === 'object' && value !== null ? value : { value });
  } else if (parsed.sub) {
    // Complex attribute, e.g. name.givenName
    if (typeof target[parsed.attr] !== 'object' || target[parsed.attr] === null) target[parsed.attr] = {};
    target[parsed.attr][parsed.sub] = value;
  } else {
    target[parsed.attr] = value;
  }
}

function removeByPath(resource, rawPath) {
  const parsed = parsePath(rawPath);
  if (!parsed) throw new Error(`unsupported path "${rawPath}"`);
  const target = container(resource, parsed, false);
  if (!target) return;

  if (parsed.filter && Array.isArray(target[parsed.attr])) {
    if (parsed.sub) {
      for (const e of target[parsed.attr]) {
        if (filterMatches(e, parsed.filter)) delete e[parsed.sub];
      }
    } else {
      target[parsed.attr] = target[parsed.attr].filter((e) => !filterMatches(e, parsed.filter));
    }
  } else if (parsed.sub && target[parsed.attr]) {
    delete target[parsed.attr][parsed.sub];
  } else {
    delete target[parsed.attr];
  }
}

// --- UI normalization --------------------------------------------------------

export function normalizeUser(rec) {
  const r = rec.raw;
  const ext = r[ENTERPRISE_EXT] ?? {};
  const emails = Array.isArray(r.emails) ? r.emails : [];
  const primary = emails.find((e) => e?.primary) ?? emails[0];
  return {
    id: rec.id,
    externalId: r.externalId ?? null,
    userName: r.userName ?? '',
    displayName:
      r.displayName ||
      [r.name?.givenName, r.name?.familyName].filter(Boolean).join(' ') ||
      r.name?.formatted ||
      r.userName ||
      '',
    email: primary?.value ?? null,
    active: r.active !== false && r.active !== 'False',
    title: r.title ?? null,
    department: ext.department ?? null,
    userType: r.userType ?? null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    deletedAt: rec.deletedAt,
  };
}
