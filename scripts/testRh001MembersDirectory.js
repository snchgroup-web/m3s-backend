const assert = require('assert');
const path = require('path');
const {
  DOCUMENT_FIELDS,
  DIRECTORY_FIELDS,
  buildDirectoryPage,
  createMembersDirectoryHandler,
  isFeatureEnabled,
  isRoleAllowed,
  parseAllowedRoles,
  parsePagination,
  readDirectoryDocument,
  validateDirectoryDocument
} = require('../rh001Directory');

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const run = async () => {
  const fixturePath = path.join(__dirname, '..', 'referentiels', 'rh001MembersDirectory.json');
  const document = await readDirectoryDocument(fixturePath);

  assert.equal(document.records.length, 6);
  assert.equal(new Set(document.records.map((item) => item.person_id)).size, 6);
  assert.equal(new Set(document.records.map((item) => item.display_name)).size, 6);
  assert.deepEqual(Object.keys(document), DOCUMENT_FIELDS);

  const firstPage = buildDirectoryPage(document, { limit: '2', offset: '1' });
  assert.equal(firstPage.data.length, 2);
  assert.equal(firstPage.total, 6);
  assert.equal(firstPage.limit, 2);
  assert.equal(firstPage.offset, 1);
  firstPage.data.forEach((record) => {
    assert.deepEqual(Object.keys(record), DIRECTORY_FIELDS);
  });

  assert.deepEqual(parsePagination({ limit: '500', offset: '-4' }), { limit: 100, offset: 0 });
  assert.deepEqual(parsePagination({}), { limit: 100, offset: 0 });
  assert.equal(isFeatureEnabled('true'), true);
  assert.equal(isFeatureEnabled('TRUE'), true);
  assert.equal(isFeatureEnabled('false'), false);

  const roles = parseAllowedRoles('Admin,Utilisateur');
  assert.equal(isRoleAllowed('Administrateur', roles), true);
  assert.equal(isRoleAllowed('USER', roles), true);
  assert.equal(isRoleAllowed('Auditeur', roles), false);
  assert.equal(isRoleAllowed('', roles), false);

  const duplicate = structuredClone(document);
  duplicate.records[1].person_id = duplicate.records[0].person_id;
  assert.throws(() => validateDirectoryDocument(duplicate), /Duplicate person identity/);

  const unexpectedMetadata = structuredClone(document);
  unexpectedMetadata.internal_note = 'not part of the public contract';
  assert.throws(() => validateDirectoryDocument(unexpectedMetadata), /Unexpected RH-001 fields at root/);

  const invalidStatus = structuredClone(document);
  invalidStatus.status = 'draft';
  assert.throws(() => validateDirectoryDocument(invalidStatus), /status must be validated_documentary/);

  const invalidApprovalDate = structuredClone(document);
  invalidApprovalDate.approved_on = '2026-02-31';
  assert.throws(() => validateDirectoryDocument(invalidApprovalDate), /Invalid approved_on/);

  const invalidPreferredName = structuredClone(document);
  invalidPreferredName.records[0].preferred_name = null;
  assert.throws(() => validateDirectoryDocument(invalidPreferredName), /Invalid preferred_name/);

  const invalidSubgroup = structuredClone(document);
  invalidSubgroup.records[0].subgroup = 'TSN-TASKFORCE';
  assert.throws(() => validateDirectoryDocument(invalidSubgroup), /Subgroup must belong to team/);

  const sensitive = structuredClone(document);
  sensitive.records[0].email = 'hidden@example.com';
  assert.throws(() => validateDirectoryDocument(sensitive), /Forbidden RH-001 key/);

  const emailInValue = structuredClone(document);
  emailInValue.records[0].position = 'Contact hidden@example.com';
  assert.throws(() => validateDirectoryDocument(emailInValue), /Email-like value forbidden/);

  const handlerOptions = {
    allowedRoles: roles,
    directoryPath: fixturePath,
    now: () => '2026-07-31T00:00:00.000Z',
    logger: { error: () => {} }
  };

  const disabledResponse = createResponse();
  await createMembersDirectoryHandler({ ...handlerOptions, enabled: false })(
    { user: { role: 'Admin' }, query: {} },
    disabledResponse
  );
  assert.equal(disabledResponse.statusCode, 404);
  assert.equal(disabledResponse.body.code, 'RH001_DIRECTORY_DISABLED');

  const unauthenticatedResponse = createResponse();
  await createMembersDirectoryHandler({ ...handlerOptions, enabled: true })(
    { query: {} },
    unauthenticatedResponse
  );
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(unauthenticatedResponse.body.code, 'RH001_DIRECTORY_UNAUTHENTICATED');

  const forbiddenResponse = createResponse();
  await createMembersDirectoryHandler({ ...handlerOptions, enabled: true })(
    { user: { role: 'Auditeur' }, query: {} },
    forbiddenResponse
  );
  assert.equal(forbiddenResponse.statusCode, 403);
  assert.equal(forbiddenResponse.body.code, 'RH001_DIRECTORY_FORBIDDEN');

  const allowedResponse = createResponse();
  await createMembersDirectoryHandler({ ...handlerOptions, enabled: true })(
    { user: { role: 'Utilisateur' }, query: { limit: '3', offset: '0' } },
    allowedResponse
  );
  assert.equal(allowedResponse.statusCode, 200);
  assert.equal(allowedResponse.body.count, 3);
  assert.equal(allowedResponse.body.total, 6);
  assert.equal(allowedResponse.body.classification, 'C2');

  const invalidResponse = createResponse();
  await createMembersDirectoryHandler({
    ...handlerOptions,
    enabled: true,
    readDocument: async () => { throw new Error('invalid fixture'); }
  })({ user: { role: 'Admin' }, query: {} }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 500);
  assert.equal(invalidResponse.body.code, 'RH001_DIRECTORY_INVALID');

  console.log('RH-001 members directory tests: OK');
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
