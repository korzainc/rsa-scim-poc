// SCIM 2.0 server endpoints (RFC 7643/7644) — the subset IdP provisioning
// clients (Entra, Okta, OneLogin, Ping) actually exercise:
//   GET  /ServiceProviderConfig | /ResourceTypes | /Schemas
//   GET  /Users(?filter=userName eq "...")  (+ startIndex/count paging)
//   GET  /Users/{id} · POST /Users · PUT /Users/{id} · PATCH /Users/{id} · DELETE /Users/{id}
//   Same surface for /Groups (minimal).
// Everything is IdP-agnostic — nothing in this file knows about Entra.
import express from 'express';
import { applyPatchOp, normalizeBooleans } from './store.js';
import { ALL_SCHEMAS } from './schemas.js';

const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCHOP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';

export function scimRouter({ store, token, basePath, activity }) {
  const router = express.Router();
  router.use(express.json({ type: () => true, limit: '1mb' }));

  // meta.location must be an absolute URI (RFC 7643 §3.1). Requires
  // `app.set('trust proxy', true)` upstream so req.protocol is https behind the tunnel.
  const loc = (req, suffix) => `${req.protocol}://${req.get('host')}${basePath}${suffix}`;

  // --- bearer auth on everything under /scim/v2 ------------------------------
  router.use((req, res, next) => {
    if (!token) return fail(res, 503, 'SCIM_TOKEN is not configured on the server');
    const got = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(got, token)) return fail(res, 401, 'invalid bearer token');
    next();
  });

  // --- discovery -------------------------------------------------------------
  router.get('/ServiceProviderConfig', (req, res) => {
    ok(req, res, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Long-lived bearer token configured in the IdP provisioning client',
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: loc(req, '/ServiceProviderConfig') },
    });
  });

  router.get('/ResourceTypes', (req, res) => {
    ok(req, res, 200, listResponse([
      resourceType(req, 'User', '/Users', USER),
      resourceType(req, 'Group', '/Groups', GROUP),
    ]));
  });

  router.get('/Schemas', (req, res) => {
    ok(req, res, 200, listResponse(ALL_SCHEMAS.map((s) => schemaResource(req, s))));
  });

  router.get('/Schemas/:id', (req, res) => {
    const s = ALL_SCHEMAS.find((x) => x.id === req.params.id);
    if (!s) return fail(res, 404, `Schema ${req.params.id} not found`);
    ok(req, res, 200, schemaResource(req, s));
  });

  function schemaResource(req, s) {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      ...s,
      meta: { resourceType: 'Schema', location: loc(req, `/Schemas/${s.id}`) },
    };
  }

  function resourceType(req, name, endpoint, schema) {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: name, name, endpoint, schema,
      meta: { resourceType: 'ResourceType', location: loc(req, `/ResourceTypes/${name}`) },
    };
  }

  // --- /Users ---------------------------------------------------------------
  router.get('/Users', (req, res) => {
    listEndpoint(req, res, store.liveUsers(), userResource, {
      username: (rec) => rec.raw.userName,
      externalid: (rec) => rec.raw.externalId,
      'emails.value': (rec) => (rec.raw.emails ?? []).map((e) => e?.value),
    });
  });

  router.get('/Users/:id', (req, res) => {
    const rec = store.userById(req.params.id);
    if (!rec) return fail(res, 404, `User ${req.params.id} not found`);
    ok(req, res, 200, userResource(rec, req));
  });

  router.post('/Users', (req, res) => {
    const body = req.body ?? {};
    if (!body.userName) return fail(res, 400, 'userName is required', 'invalidValue');
    const clash = store.liveUsers().find(
      (u) => (u.raw.userName ?? '').toLowerCase() === body.userName.toLowerCase(),
    );
    if (clash) return fail(res, 409, `userName ${body.userName} already exists`, 'uniqueness');
    const rec = store.createUser(normalizeBooleans(stripMeta(body)));
    ok(req, res, 201, userResource(rec, req), `created ${body.userName}`);
  });

  router.put('/Users/:id', (req, res) => {
    const rec = store.userById(req.params.id);
    if (!rec) return fail(res, 404, `User ${req.params.id} not found`);
    rec.raw = normalizeBooleans(stripMeta(req.body ?? {}));
    store.touch(rec);
    ok(req, res, 200, userResource(rec, req), `replaced ${rec.raw.userName}`);
  });

  router.patch('/Users/:id', (req, res) => {
    const rec = store.userById(req.params.id);
    if (!rec) return fail(res, 404, `User ${req.params.id} not found`);
    if (!Array.isArray(req.body?.Operations)) {
      return fail(res, 400, `PATCH body must be a ${PATCHOP} with Operations`, 'invalidSyntax');
    }
    try {
      for (const op of req.body.Operations) applyPatchOp(rec.raw, op);
    } catch (e) {
      return fail(res, 400, e.message, 'invalidPath');
    }
    normalizeBooleans(rec.raw);
    store.touch(rec);
    const summary = req.body.Operations
      .map((o) => `${String(o.op).toLowerCase()} ${o.path ?? Object.keys(o.value ?? {}).join(',')}`)
      .join('; ');
    ok(req, res, 200, userResource(rec, req), `${rec.raw.userName}: ${summary}`);
  });

  router.delete('/Users/:id', (req, res) => {
    const rec = store.userById(req.params.id);
    if (!rec) return fail(res, 404, `User ${req.params.id} not found`);
    store.tombstone(rec);
    log(req, 204, `deprovisioned ${rec.raw.userName}`);
    res.status(204).end();
  });

  // --- /Groups (minimal but functional) --------------------------------------
  router.get('/Groups', (req, res) => {
    listEndpoint(req, res, store.liveGroups(), groupResource, {
      displayname: (rec) => rec.raw.displayName,
      externalid: (rec) => rec.raw.externalId,
    });
  });

  router.get('/Groups/:id', (req, res) => {
    const rec = store.groupById(req.params.id);
    if (!rec) return fail(res, 404, `Group ${req.params.id} not found`);
    ok(req, res, 200, groupResource(rec, req));
  });

  router.post('/Groups', (req, res) => {
    const body = req.body ?? {};
    if (!body.displayName) return fail(res, 400, 'displayName is required', 'invalidValue');
    const clash = store.liveGroups().find(
      (g) => (g.raw.displayName ?? '').toLowerCase() === body.displayName.toLowerCase(),
    );
    if (clash) return fail(res, 409, `Group ${body.displayName} already exists`, 'uniqueness');
    const rec = store.createGroup(normalizeBooleans(stripMeta(body)));
    ok(req, res, 201, groupResource(rec, req), `created group ${rec.raw.displayName}`);
  });

  router.put('/Groups/:id', (req, res) => {
    const rec = store.groupById(req.params.id);
    if (!rec) return fail(res, 404, `Group ${req.params.id} not found`);
    rec.raw = normalizeBooleans(stripMeta(req.body ?? {}));
    store.touch(rec);
    ok(req, res, 200, groupResource(rec, req), `replaced group ${rec.raw.displayName}`);
  });

  router.patch('/Groups/:id', (req, res) => {
    const rec = store.groupById(req.params.id);
    if (!rec) return fail(res, 404, `Group ${req.params.id} not found`);
    if (!Array.isArray(req.body?.Operations)) {
      return fail(res, 400, `PATCH body must be a ${PATCHOP} with Operations`, 'invalidSyntax');
    }
    try {
      for (const op of req.body.Operations) applyGroupPatch(rec.raw, op);
    } catch (e) {
      return fail(res, 400, e.message, 'invalidPath');
    }
    normalizeBooleans(rec.raw);
    store.touch(rec);
    ok(req, res, 200, groupResource(rec, req), `patched group ${rec.raw.displayName}`);
  });

  router.delete('/Groups/:id', (req, res) => {
    const rec = store.groupById(req.params.id);
    if (!rec) return fail(res, 404, `Group ${req.params.id} not found`);
    store.tombstone(rec);
    log(req, 204, `deleted group ${rec.raw.displayName}`);
    res.status(204).end();
  });

  // --- shared helpers ---------------------------------------------------------

  /** GET collection with `attr eq "value"` filtering and 1-based paging. */
  function listEndpoint(req, res, records, toResourceReq, filterables) {
    const toResource = (rec) => toResourceReq(rec, req);
    let matched = records;
    const filter = req.query.filter;
    if (filter) {
      const m = String(filter).match(/^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i);
      if (!m) return fail(res, 400, `unsupported filter "${filter}"`, 'invalidFilter');
      const get = filterables[m[1].toLowerCase()];
      if (!get) return fail(res, 400, `cannot filter on "${m[1]}"`, 'invalidFilter');
      const want = m[2].toLowerCase();
      matched = records.filter((rec) => {
        const v = get(rec);
        return (Array.isArray(v) ? v : [v]).some((x) => (x ?? '').toLowerCase() === want);
      });
    }
    const startIndex = Math.max(1, parseInt(req.query.startIndex ?? '1', 10) || 1);
    const count = Math.min(200, Math.max(0, parseInt(req.query.count ?? '100', 10) || 100));
    const page = matched.slice(startIndex - 1, startIndex - 1 + count);
    ok(req, res, 200, {
      ...listResponse(page.map(toResource)),
      totalResults: matched.length,
      startIndex,
      itemsPerPage: page.length,
    }, filter ? `filter ${filter} → ${matched.length}` : `list → ${matched.length}`);
  }

  function userResource(rec, req) {
    return withMeta(rec, 'User', loc(req, `/Users/${rec.id}`), USER);
  }
  function groupResource(rec, req) {
    return withMeta(rec, 'Group', loc(req, `/Groups/${rec.id}`), GROUP);
  }

  function withMeta(rec, type, location, coreSchema) {
    const schemas = Array.isArray(rec.raw.schemas) && rec.raw.schemas.length ? rec.raw.schemas : [coreSchema];
    return {
      ...rec.raw,
      schemas,
      id: rec.id,
      meta: { resourceType: type, created: rec.createdAt, lastModified: rec.updatedAt, location },
    };
  }

  function ok(req, res, status, body, summary) {
    log(req, status, summary);
    res.status(status).type('application/scim+json').json(body);
  }

  function fail(res, status, detail, scimType) {
    activity.push(res.req, status, detail);
    res.status(status).type('application/scim+json').json({
      schemas: [ERROR],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    });
  }

  function log(req, status, summary) {
    activity.push(req, status, summary);
  }

  return router;
}

function listResponse(resources) {
  return {
    schemas: [LIST],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** Group PATCH: members add/remove/replace + simple attribute ops. */
function applyGroupPatch(raw, op) {
  const kind = String(op.op ?? '').toLowerCase();
  const path = (op.path ?? '').trim();
  if (path === 'members' || path.startsWith('members[')) {
    if (!Array.isArray(raw.members)) raw.members = [];
    if (kind === 'add') {
      for (const m of [].concat(op.value ?? [])) {
        if (!raw.members.some((x) => x.value === m.value)) raw.members.push(m);
      }
    } else if (kind === 'replace') {
      raw.members = [].concat(op.value ?? []);
    } else if (kind === 'remove') {
      const m = path.match(/members\[value\s+eq\s+"((?:[^"\\]|\\.)*)"\]/i);
      if (m) raw.members = raw.members.filter((x) => x.value !== m[1]);
      else if (op.value) {
        const gone = new Set([].concat(op.value).map((v) => v.value));
        raw.members = raw.members.filter((x) => !gone.has(x.value));
      } else raw.members = [];
    }
    return;
  }
  applyPatchOp(raw, op);
}

function stripMeta(resource) {
  // password is writeOnly per RFC 7643 — must never be stored or echoed back.
  const { meta, id, password, ...rest } = resource;
  return rest;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
