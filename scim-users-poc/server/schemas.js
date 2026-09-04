// RFC 7643 schema definitions for the attributes this server actually supports.
// Served from GET /Schemas (+ /Schemas/{id}) so SCIM clients doing schema
// discovery (e.g. Microsoft's SCIM Validator "discover schema" mode) get real
// attribute definitions instead of an empty set.

const attr = (name, opts = {}) => ({
  name,
  type: 'string',
  multiValued: false,
  description: opts.description ?? '',
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...opts,
});

const sub = (name, opts = {}) => attr(name, opts);

/** Standard multi-valued complex attribute (emails, phoneNumbers, ...). */
const multi = (name, types) =>
  attr(name, {
    type: 'complex',
    multiValued: true,
    subAttributes: [
      sub('value'),
      sub('display'),
      sub('type', { canonicalValues: types }),
      sub('primary', { type: 'boolean' }),
    ],
  });

export const USER_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:core:2.0:User',
  name: 'User',
  description: 'User Account',
  attributes: [
    attr('userName', { required: true, uniqueness: 'server' }),
    attr('name', {
      type: 'complex',
      subAttributes: [
        sub('formatted'),
        sub('familyName'),
        sub('givenName'),
        sub('middleName'),
        sub('honorificPrefix'),
        sub('honorificSuffix'),
      ],
    }),
    attr('displayName'),
    attr('nickName'),
    attr('profileUrl', { type: 'reference', referenceTypes: ['external'] }),
    attr('title'),
    attr('userType'),
    attr('preferredLanguage'),
    attr('locale'),
    attr('timezone'),
    attr('active', { type: 'boolean' }),
    // No `password` here although RFC 7643 defines it: this server doesn't support
    // passwords (they're stripped on write), and Entra's provisioning service — and
    // its SCIM Validator — reject schemas that advertise the attribute.
    multi('emails', ['work', 'home', 'other']),
    multi('phoneNumbers', ['work', 'home', 'mobile', 'fax', 'pager', 'other']),
    multi('ims', ['aim', 'gtalk', 'icq', 'xmpp', 'msn', 'skype', 'qq', 'yahoo']),
    multi('photos', ['photo', 'thumbnail']),
    attr('addresses', {
      type: 'complex',
      multiValued: true,
      subAttributes: [
        sub('formatted'),
        sub('streetAddress'),
        sub('locality'),
        sub('region'),
        sub('postalCode'),
        sub('country'),
        sub('type', { canonicalValues: ['work', 'home', 'other'] }),
        sub('primary', { type: 'boolean' }),
      ],
    }),
    attr('groups', {
      type: 'complex',
      multiValued: true,
      mutability: 'readOnly',
      subAttributes: [
        sub('value', { mutability: 'readOnly' }),
        sub('$ref', { type: 'reference', referenceTypes: ['User', 'Group'], mutability: 'readOnly' }),
        sub('display', { mutability: 'readOnly' }),
      ],
    }),
    multi('entitlements', []),
    multi('roles', []),
    multi('x509Certificates', []),
    attr('externalId', { caseExact: true }),
  ],
};

export const ENTERPRISE_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  name: 'EnterpriseUser',
  description: 'Enterprise User',
  attributes: [
    attr('employeeNumber'),
    attr('costCenter'),
    attr('organization'),
    attr('division'),
    attr('department'),
    attr('manager', {
      type: 'complex',
      subAttributes: [
        sub('value'),
        sub('$ref', { type: 'reference', referenceTypes: ['User'] }),
        sub('displayName', { mutability: 'readOnly' }),
      ],
    }),
  ],
};

export const GROUP_SCHEMA = {
  id: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  name: 'Group',
  description: 'Group',
  attributes: [
    attr('displayName', { required: true }),
    attr('members', {
      type: 'complex',
      multiValued: true,
      subAttributes: [
        sub('value', { mutability: 'immutable' }),
        sub('$ref', { type: 'reference', referenceTypes: ['User', 'Group'], mutability: 'immutable' }),
        sub('display', { mutability: 'immutable' }),
        sub('type', { canonicalValues: ['User', 'Group'], mutability: 'immutable' }),
      ],
    }),
    attr('externalId', { caseExact: true }),
  ],
};

export const ALL_SCHEMAS = [USER_SCHEMA, ENTERPRISE_SCHEMA, GROUP_SCHEMA];
