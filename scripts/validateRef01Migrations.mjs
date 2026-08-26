import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const migrationDirectory = path.join(repositoryRoot, 'migrations', 'ref01');

const upSql = await readFile(
  path.join(migrationDirectory, '001_ref01_foundations.up.sql'),
  'utf8',
);
const downSql = await readFile(
  path.join(migrationDirectory, '001_ref01_foundations.down.sql'),
  'utf8',
);

const ids = {
  eventOne: '10000000-0000-4000-8000-000000000001',
  eventTwo: '10000000-0000-4000-8000-000000000002',
  eventThree: '10000000-0000-4000-8000-000000000003',
  object: '20000000-0000-4000-8000-000000000001',
  version: '30000000-0000-4000-8000-000000000001',
  person: '40000000-0000-4000-8000-000000000001',
  team: '50000000-0000-4000-8000-000000000001',
  requester: '60000000-0000-4000-8000-000000000001',
  validator: '60000000-0000-4000-8000-000000000002',
  membershipOne: '70000000-0000-4000-8000-000000000001',
  membershipTwo: '70000000-0000-4000-8000-000000000002',
  evidence: '80000000-0000-4000-8000-000000000001',
  outbox: '90000000-0000-4000-8000-000000000001',
};

async function expectRejected(operation, label) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, `${label} should be rejected`);
}

const db = new PGlite();

try {
  await db.exec(upSql);

  const tableResult = await db.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'ref01'
    ORDER BY table_name
  `);
  assert.deepEqual(
    tableResult.rows.map(({ table_name: tableName }) => tableName),
    ['event', 'evidence_link', 'membership_period', 'object_version', 'outbox'],
  );

  const insertEvent = async ({ id, idempotencyKey, objectType = 'person' }) => {
    await db.query(
      `INSERT INTO ref01.event (
        id, object_id, object_type, event_type, effective_at, reason,
        requested_by_subject_id, validated_by_subject_id, confidentiality,
        idempotency_key, expected_object_version, payload
      ) VALUES ($1, $2, $3, 'register', '2026-08-26T10:00:00Z',
        'Synthetic migration validation', $4, $5, 'C2', $6, 0,
        '{"synthetic":true}'::jsonb
      )`,
      [id, ids.object, objectType, ids.requester, ids.validator, idempotencyKey],
    );
  };

  await insertEvent({ id: ids.eventOne, idempotencyKey: 'synthetic-ref01-001' });
  await insertEvent({
    id: ids.eventTwo,
    idempotencyKey: 'synthetic-ref01-002',
    objectType: 'membership',
  });
  await insertEvent({
    id: ids.eventThree,
    idempotencyKey: 'synthetic-ref01-003',
    objectType: 'membership',
  });

  await db.query(
    `INSERT INTO ref01.object_version (
      id, object_id, object_type, version_number, valid_from, snapshot,
      source_event_id
    ) VALUES ($1, $2, 'person', 1, '2026-08-26T10:00:00Z',
      '{"display_name":"Synthetic Person"}'::jsonb, $3)`,
    [ids.version, ids.object, ids.eventOne],
  );

  await db.query(
    `INSERT INTO ref01.membership_period (
      id, person_id, team_id, role_code, starts_at, source_event_id
    ) VALUES ($1, $2, $3, 'SYNTHETIC_MEMBER', '2026-01-01T00:00:00Z', $4)`,
    [ids.membershipOne, ids.person, ids.team, ids.eventTwo],
  );

  await db.query(
    `INSERT INTO ref01.evidence_link (
      id, event_id, evidence_ref, classification
    ) VALUES ($1, $2, 'GED-SYNTHETIC-REF-001', 'C2')`,
    [ids.evidence, ids.eventOne],
  );

  await db.query(
    `INSERT INTO ref01.outbox (id, event_id, topic, payload)
     VALUES ($1, $2, 'ref01.synthetic.created', '{"synthetic":true}'::jsonb)`,
    [ids.outbox, ids.eventOne],
  );

  await expectRejected(
    () => insertEvent({
      id: '10000000-0000-4000-8000-000000000099',
      idempotencyKey: 'synthetic-ref01-001',
    }),
    'duplicate idempotency key',
  );

  await expectRejected(
    () => db.query(`UPDATE ref01.event SET reason = 'Mutation' WHERE id = $1`, [ids.eventOne]),
    'event mutation',
  );

  await expectRejected(
    () => db.query(
      `INSERT INTO ref01.membership_period (
        id, person_id, team_id, role_code, starts_at, ends_at, source_event_id
      ) VALUES ($1, $2, $3, 'SYNTHETIC_MEMBER',
        '2026-06-01T00:00:00Z', '2026-12-31T00:00:00Z', $4)`,
      [ids.membershipTwo, ids.person, ids.team, ids.eventThree],
    ),
    'overlapping membership period',
  );

  await expectRejected(
    () => db.query(`UPDATE ref01.outbox SET status = 'completed' WHERE id = $1`, [ids.outbox]),
    'completed outbox item without timestamp',
  );

  const publicGrantResult = await db.query(`
    SELECT count(*)::integer AS grant_count
    FROM information_schema.role_table_grants
    WHERE table_schema = 'ref01' AND grantee = 'PUBLIC'
  `);
  assert.equal(publicGrantResult.rows[0].grant_count, 0);

  await db.exec(downSql);
  const schemaResult = await db.query(`
    SELECT count(*)::integer AS schema_count
    FROM information_schema.schemata
    WHERE schema_name = 'ref01'
  `);
  assert.equal(schemaResult.rows[0].schema_count, 0);

  console.log('REF-01 L1 migration validation passed with synthetic data.');
} finally {
  await db.close();
}
