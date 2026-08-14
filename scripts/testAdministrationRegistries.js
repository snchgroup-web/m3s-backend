const assert = require('assert');
const {
  PERMISSIONS,
  buildAdministrationRegistrySchemaStatements,
  ensureAdministrationRegistrySchema,
  defaultPermissionsForRole,
  permissionsForAccount,
  normalizeResourcePayload,
  normalizeCorrespondencePayload,
  parsePagination,
  parseAuditMetadata,
  createAdministrationRegistryHandlers
} = require('../administrationRegistries');

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

const createBigQuery = outcomes => {
  const calls = [];
  return {
    calls,
    async query(options) {
      calls.push(options);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome || [[]];
    }
  };
};

const resourcePayload = {
  title: 'Portail officiel association',
  family: 'legal_regulatory',
  authority: 'Autorité publique',
  location: 'https://example.invalid/reference',
  source_status: 'official',
  review_status: 'controlled',
  confidentiality: 'internal',
  note: 'Métadonnée de référence uniquement.'
};

const correspondencePayload = {
  receipt_date: '2026-08-14',
  direction: 'incoming',
  channel: 'whatsapp',
  sender: 'Personne externe',
  recipient: 'Administration 2SG',
  subject: 'Transmission de document',
  category: 'human_resources',
  confidentiality: 'restricted_hr',
  linked_person_or_case: 'Dossier RH',
  ged_reference: 'GED-RH-2026-001',
  receipt_evidence_reference: 'PREUVE-RECEPTION-001',
  owner: 'Organisation & RH',
  next_action: 'Classer dans la GED sécurisée.',
  status: 'to_file_dms',
  deadline: ''
};

const founder = {
  id: 'USR-FOUNDER',
  tenantId: 'TENANT-2SG',
  name: 'Cheikh',
  role: 'Membre fondateur',
  permissions: defaultPermissionsForRole('Membre fondateur')
};

const reader = {
  id: 'USR-READER',
  tenantId: 'TENANT-2SG',
  name: 'Lecteur',
  permissions: [PERMISSIONS.RESOURCES_READ, PERMISSIONS.CORRESPONDENCE_READ]
};

const createHandlers = bigquery => createAdministrationRegistryHandlers({
  bigquery,
  projectId: 'project-test',
  datasetId: 'dataset_test',
  location: 'EU',
  now: () => '2026-08-14T12:00:00.000Z',
  idGenerator: prefix => `${prefix}-TEST`,
  logger: { error: () => {} }
});

const run = async () => {
  const schemaStatements = buildAdministrationRegistrySchemaStatements({
    projectId: 'project-test',
    datasetId: 'dataset_test'
  });
  assert.equal(schemaStatements.length, 3);
  assert.match(schemaStatements[0], /CREATE TABLE IF NOT EXISTS `project-test\.dataset_test\.administration_resources`/);
  assert.match(schemaStatements[1], /PARTITION BY receipt_date/);
  assert.match(schemaStatements[2], /CLUSTER BY tenant_id, entity_type, action/);
  assert.throws(
    () => buildAdministrationRegistrySchemaStatements({ projectId: 'project`; DROP TABLE x', datasetId: 'dataset_test' }),
    /Invalid BigQuery project identifier/
  );

  const schemaBigQuery = createBigQuery([[[]], [[]], [[]]]);
  const schemaResult = await ensureAdministrationRegistrySchema({
    bigquery: schemaBigQuery,
    projectId: 'project-test',
    datasetId: 'dataset_test',
    location: 'EU'
  });
  assert.equal(schemaBigQuery.calls.length, 3);
  assert(schemaBigQuery.calls.every(call => call.location === 'EU'));
  assert.deepEqual(schemaResult.tables, [
    'administration_resources',
    'administration_correspondence',
    'administration_audit_log'
  ]);

  const founderPermissions = defaultPermissionsForRole('Membre fondateur');
  assert(founderPermissions.includes(PERMISSIONS.RESOURCES_RESTRICTED));
  assert(founderPermissions.includes(PERMISSIONS.CORRESPONDENCE_RESTRICTED));
  assert(founderPermissions.includes(PERMISSIONS.AUDIT_READ));
  assert.deepEqual(defaultPermissionsForRole('Utilisateur'), [
    PERMISSIONS.RESOURCES_READ,
    PERMISSIONS.CORRESPONDENCE_READ
  ]);
  assert.equal(defaultPermissionsForRole('Administrateur').includes(PERMISSIONS.AUDIT_READ), false);
  assert.deepEqual(permissionsForAccount({
    role: 'Membre fondateur',
    permissions: [PERMISSIONS.RESOURCES_READ, 'permission:unknown']
  }), [PERMISSIONS.RESOURCES_READ]);

  assert.equal(normalizeResourcePayload(resourcePayload).title, resourcePayload.title);
  assert.equal(normalizeCorrespondencePayload(correspondencePayload).deadline, '');
  assert.throws(
    () => normalizeCorrespondencePayload({ ...correspondencePayload, attachments: [{ base64: 'abc' }] }),
    error => error.code === 'ADMIN_REGISTRY_FILE_CONTENT_FORBIDDEN'
  );
  assert.throws(
    () => normalizeResourcePayload({ ...resourcePayload, confidentiality: 'secret' }),
    /Invalid confidentiality/
  );
  assert.throws(
    () => normalizeResourcePayload({ ...resourcePayload, raw_document: 'hidden content' }),
    /Unexpected fields: raw_document/
  );
  assert.throws(
    () => normalizeCorrespondencePayload({ ...correspondencePayload, receipt_date: '2026-02-31' }),
    /Invalid receipt_date/
  );
  assert.deepEqual(parsePagination({ limit: '999', offset: '-3' }), { limit: 200, offset: 0 });
  assert.deepEqual(parseAuditMetadata('{"changed_fields":["title","note"]}'), { changed_fields: ['title', 'note'] });
  assert.deepEqual(parseAuditMetadata('invalid-json'), { changed_fields: [] });

  const unauthenticatedBq = createBigQuery([]);
  const unauthenticatedResponse = createResponse();
  await createHandlers(unauthenticatedBq).listResources({ query: {} }, unauthenticatedResponse);
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(unauthenticatedBq.calls.length, 0);

  const forbiddenBq = createBigQuery([]);
  const forbiddenResponse = createResponse();
  await createHandlers(forbiddenBq).createResource(
    { user: reader, body: resourcePayload },
    forbiddenResponse
  );
  assert.equal(forbiddenResponse.statusCode, 403);
  assert.equal(forbiddenBq.calls.length, 0);

  const ordinaryMutationCases = [
    ['updateResource', { user: reader, params: { id: 'RES-1' }, body: resourcePayload }],
    ['deleteResource', { user: reader, params: { id: 'RES-1' } }],
    ['createCorrespondence', { user: reader, body: { ...correspondencePayload, confidentiality: 'internal' } }],
    ['updateCorrespondence', { user: reader, params: { id: 'COR-1' }, body: { ...correspondencePayload, confidentiality: 'internal' } }],
    ['deleteCorrespondence', { user: reader, params: { id: 'COR-1' } }],
    ['listAuditEvents', { user: reader, query: {} }]
  ];
  for (const [handlerName, request] of ordinaryMutationCases) {
    const ordinaryBq = createBigQuery([]);
    const ordinaryResponse = createResponse();
    await createHandlers(ordinaryBq)[handlerName](request, ordinaryResponse);
    assert.equal(ordinaryResponse.statusCode, 403, `${handlerName} must reject an ordinary user`);
    assert.equal(ordinaryBq.calls.length, 0, `${handlerName} must not query BigQuery when forbidden`);
  }

  const listBq = createBigQuery([[[{ id: 'RES-1' }]]]);
  const listResponse = createResponse();
  await createHandlers(listBq).listResources({ user: reader, query: { limit: '10' } }, listResponse);
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.body.data[0].id, 'RES-1');
  assert.equal(listBq.calls[0].params.tenant_id, 'TENANT-2SG');
  assert.equal(listBq.calls[0].params.user_id, 'USR-READER');
  assert.equal(listBq.calls[0].params.can_read_restricted_resources, false);
  assert.match(listBq.calls[0].query, /tenant_id = @tenant_id/);

  const correspondenceListBq = createBigQuery([[[{ id: 'COR-1' }]]]);
  const correspondenceListResponse = createResponse();
  await createHandlers(correspondenceListBq).listCorrespondence(
    { user: reader, query: { limit: '10' } },
    correspondenceListResponse
  );
  assert.equal(correspondenceListResponse.statusCode, 200);
  assert.equal(correspondenceListBq.calls[0].params.can_read_restricted_correspondence, false);
  assert.match(correspondenceListBq.calls[0].query, /confidentiality NOT IN \('restricted_hr', 'confidential'\)/);

  const auditBq = createBigQuery([[[{
    id: 'AUD-1',
    actor_name: 'Membre fondateur',
    entity_type: 'resource',
    entity_id: 'RES-1',
    action: 'update',
    event_at: '2026-08-14T12:00:00.000Z',
    metadata_json: '{"changed_fields":["title","note"]}'
  }]]]);
  const auditResponse = createResponse();
  await createHandlers(auditBq).listAuditEvents({ user: founder, query: { limit: '25' } }, auditResponse);
  assert.equal(auditResponse.statusCode, 200);
  assert.deepEqual(auditResponse.body.data[0].changed_fields, ['title', 'note']);
  assert.equal('metadata_json' in auditResponse.body.data[0], false);
  assert.equal('actor_user_id' in auditResponse.body.data[0], false);
  assert.equal(auditBq.calls[0].params.tenant_id, founder.tenantId);
  assert.match(auditBq.calls[0].query, /WHERE tenant_id=@tenant_id/);

  const missingTableBq = createBigQuery([new Error('Not found: Table project-test:dataset_test.administration_resources')]);
  const missingTableResponse = createResponse();
  await createHandlers(missingTableBq).listResources({ user: reader, query: {} }, missingTableResponse);
  assert.equal(missingTableResponse.statusCode, 503);
  assert.equal(missingTableResponse.body.code, 'ADMIN_REGISTRY_SOURCE_UNAVAILABLE');

  const restrictedBq = createBigQuery([]);
  const restrictedResponse = createResponse();
  await createHandlers(restrictedBq).createCorrespondence(
    { user: reader, body: correspondencePayload },
    restrictedResponse
  );
  assert.equal(restrictedResponse.statusCode, 403);
  assert.equal(restrictedBq.calls.length, 0);

  const notFoundBq = createBigQuery([[[]]]);
  const notFoundResponse = createResponse();
  await createHandlers(notFoundBq).updateResource(
    { user: founder, params: { id: 'RES-MISSING' }, body: resourcePayload },
    notFoundResponse
  );
  assert.equal(notFoundResponse.statusCode, 404);
  assert.equal(notFoundBq.calls.length, 1);
  assert.doesNotMatch(notFoundBq.calls[0].query, /administration_audit_log/);

  const updatedCorrespondence = { id: 'COR-1', subject: 'Transmission mise à jour' };
  const updateBq = createBigQuery([
    [[{ id: 'COR-1', confidentiality: 'restricted_hr', created_by_user_id: founder.id }]],
    [[updatedCorrespondence]]
  ]);
  const updateResponse = createResponse();
  await createHandlers(updateBq).updateCorrespondence(
    { user: founder, params: { id: 'COR-1' }, body: correspondencePayload },
    updateResponse
  );
  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.body.data.subject, updatedCorrespondence.subject);
  assert.equal(updateBq.calls.length, 2);
  assert.match(updateBq.calls[1].query, /BEGIN TRANSACTION/);
  assert.match(updateBq.calls[1].query, /administration_audit_log/);
  assert.equal(updateBq.calls[1].params.tenant_id, founder.tenantId);

  const deleteBq = createBigQuery([
    [[{ id: 'RES-1', confidentiality: 'internal', created_by_user_id: founder.id }]],
    [[]]
  ]);
  const deleteResponse = createResponse();
  await createHandlers(deleteBq).deleteResource(
    { user: founder, params: { id: 'RES-1' } },
    deleteResponse
  );
  assert.equal(deleteResponse.statusCode, 200);
  assert.equal(deleteBq.calls.length, 2);
  assert.match(deleteBq.calls[1].query, /administration_audit_log/);

  console.log('Administration registries tests: OK');
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
