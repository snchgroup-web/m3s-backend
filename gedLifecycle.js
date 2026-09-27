const { HASH, approvedDocument, categoryFor, fail } = require('./gedPrivatePolicy');
const validateTitle = title => typeof title === 'string' && title === title.trim() &&
  title.length > 0 && title.length <= 140 && !/[\x00-\x1f\x7f<>]/.test(title);

function transition(current, command, approvedVersion) {
  if (!command || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== current.revision) fail('GED_VERSION_CONFLICT');
  const allowed = { rename: ['action', 'expectedRevision', 'title'], version: ['action', 'expectedRevision', 'versionId'],
    trash: ['action', 'expectedRevision'], restore: ['action', 'expectedRevision'] }[command.action];
  if (!allowed || Object.keys(command).some(key => !allowed.includes(key))) fail('GED_INVALID_COMMAND');
  if (current.revision >= 10000) fail('GED_REVISION_LIMIT');
  if (current.trashed && command.action !== 'restore') fail('GED_DOCUMENT_TRASHED');
  const next = { ...current, revision: current.revision + 1 };
  if (command.action === 'rename') {
    if (!validateTitle(command.title)) fail('GED_INVALID_TITLE');
    next.title = command.title;
  } else if (command.action === 'version') {
    if (!HASH.test(command.versionId) || !approvedVersion || approvedVersion.id !== command.versionId ||
        approvedVersion.category !== current.category || approvedVersion.registered !== true ||
        approvedVersion.owner !== current.owner || approvedVersion.tenant !== current.tenant ||
        approvedVersion.id === current.currentDocumentId || approvedVersion.id === current.documentId) fail('GED_VERSION_NOT_APPROVED');
    next.currentDocumentId = approvedVersion.id;
  } else if (command.action === 'trash') next.trashed = true;
  else {
    if (!current.trashed) fail('GED_DOCUMENT_NOT_TRASHED');
    next.trashed = false;
  }
  return next;
}

function createLifecycle({ transaction, read, policy }) {
  const history = async (client, scope, id) => (await client.query(`SELECT revision, current_document_id, title, trashed, action, created_at
    FROM ged_private.revisions WHERE tenant=$1 AND owner_id=$2 AND document_id=$3 ORDER BY revision`, [scope.tenant, scope.owner, id])).rows;
  const aliases = async (client, scope) => (await client.query(`SELECT DISTINCT current_document_id FROM ged_private.revisions
    WHERE tenant=$1 AND owner_id=$2 AND current_document_id<>document_id`, [scope.tenant, scope.owner])).rows.map(row => row.current_document_id);
  const state = (row, events) => {
    const last = events.at(-1);
    return { documentId: row.document_id, currentDocumentId: last?.current_document_id || row.document_id,
      title: last?.title || row.filename, revision: last?.revision || 0, trashed: last?.trashed || false,
      category: categoryFor(approvedDocument(policy, row.document_id)), tenant: row.tenant, owner: row.owner_id };
  };
  async function load(client, scope, id) {
    approvedDocument(policy, id);
    if ((await aliases(client, scope)).includes(id)) fail('GED_VERSION_NOT_ROOT');
    const row = await read(client, scope, id);
    if (!row) fail('GED_NOT_FOUND');
    const events = await history(client, scope, id);
    return { row, events, current: state(row, events) };
  }
  async function record(client, scope, current) {
    const row = await read(client, scope, current.currentDocumentId);
    if (!row) fail('GED_REGISTER_UNAVAILABLE');
    return { ...row, root_id: current.documentId, title: current.title, revision: current.revision, trashed: current.trashed };
  }
  return Object.freeze({
    list: scope => transaction(scope, async client => {
      const rows = (await client.query(`SELECT tenant, owner_id, document_id, filename, byte_size, generation, created_at
        FROM ged_private.documents WHERE tenant=$1 AND owner_id=$2 ORDER BY created_at, document_id LIMIT 100`, [scope.tenant, scope.owner])).rows;
      const hidden = await aliases(client, scope);
      const records = [];
      for (const row of rows) if (!hidden.includes(row.document_id)) records.push(await record(client, scope, state(row, await history(client, scope, row.document_id))));
      return records;
    }),
    history: (scope, id) => transaction(scope, async client => {
      const { row, events } = await load(client, scope, id);
      const initial = { revision: 0, current_document_id: id, title: row.filename, trashed: false, action: 'import', created_at: row.created_at };
      const result = [];
      for (const event of [initial, ...events]) result.push({ ...event, row: await read(client, scope, event.current_document_id) });
      return result;
    }),
    mutate: (scope, id, command) => transaction(scope, async client => {
      // Serialize an owner's revision/link operations; immutable originals require no UPDATE privilege.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope.tenant + scope.owner]);
      const { current } = await load(client, scope, id);
      let version;
      if (command?.action === 'version') {
        const entry = approvedDocument(policy, command.versionId);
        const row = await read(client, scope, command.versionId);
        if ((await aliases(client, scope)).includes(command.versionId) || (await history(client, scope, command.versionId)).length) fail('GED_VERSION_ALREADY_LINKED');
        version = { id: command.versionId, category: categoryFor(entry), registered: !!row, tenant: row?.tenant, owner: row?.owner_id };
      }
      const next = transition(current, command, version);
      await client.query(`INSERT INTO ged_private.revisions (tenant, owner_id, document_id, revision, current_document_id, title, trashed, action)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.tenant, scope.owner, id, next.revision, next.currentDocumentId, next.title, next.trashed, command.action]);
      return record(client, scope, next);
    })
  });
}
module.exports = { validateTitle, transition, createLifecycle };
