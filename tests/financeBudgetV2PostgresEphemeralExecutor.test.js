const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const {
  collectBudgetV2PostgresInventory,
  createBudgetV2EphemeralConsumptionStore,
  createBudgetV2PGliteEphemeralSession,
  executeBudgetV2PostgresEphemeralMigration
} = require('../financeBudgetV2PostgresEphemeralExecutor');
const {
  buildBudgetV2PostgresMigrationPlan
} = require('../financeBudgetV2PostgresMigrationPlanner');
const {
  SCHEMA_NAME,
  buildBudgetV2PostgresOfflinePlan
} = require('../financeBudgetV2PostgresSchema');

const TARGET = Object.freeze({
  targetRef: 'local-budget-v2-ephemeral-001',
  environment: 'local-ephemeral',
  engine: 'postgresql',
  postgresMajor: 18,
  databaseName: 'm3s_budget_v2_ephemeral',
  schemaName: SCHEMA_NAME,
  databaseEncoding: 'UTF8',
  dataClassification: 'synthetic-only'
});
const OBSERVED_AT = '2026-09-09T20:00:00.000Z';
const GENERATED_AT = '2026-09-09T20:01:00.000Z';
const AUTHORIZED_AT = '2026-09-09T20:02:00.000Z';
const STARTED_AT = '2026-09-09T20:03:00.000Z';
const DEADLINE_AT = '2026-09-09T20:04:00.000Z';

function context(overrides = {}) {
  return {
    executionRef: 'BUDGET-T1-D-B-2-C-RUN-001',
    targetRef: TARGET.targetRef,
    environment: 'local-ephemeral',
    engine: 'pglite-postgresql',
    dataClassification: 'synthetic-only',
    startedAt: STARTED_AT,
    deadlineAt: DEADLINE_AT,
    networkMode: 'none',
    storageMode: 'memory-only',
    ...overrides
  };
}

function authorization(plan, overrides = {}) {
  return {
    decisionRef: 'BUDGET-T1-D-B-2-C-AUTH-001',
    planFingerprint: plan.fingerprint,
    targetRef: plan.target.targetRef,
    confirmation: `APPLY BUDGET V2 DDL TO ${plan.target.targetRef} AT ${plan.fingerprint}`,
    authorizedAt: AUTHORIZED_AT,
    scope: 'apply-three-budget-v2-ddl-statements',
    ...overrides
  };
}

async function harness({ createSchema = true } = {}) {
  const database = new PGlite();
  if (createSchema) await database.exec(`CREATE SCHEMA ${SCHEMA_NAME}`);
  return {
    database,
    session: createBudgetV2PGliteEphemeralSession(database),
    close: () => database.close()
  };
}

async function plannedCreate(session) {
  const inventory = await collectBudgetV2PostgresInventory({
    session,
    target: TARGET,
    observedAt: OBSERVED_AT
  });
  return planFromInventory(inventory);
}

function planFromInventory(inventory) {
  return buildBudgetV2PostgresMigrationPlan({
    schemaPlan: buildBudgetV2PostgresOfflinePlan(),
    target: TARGET,
    inventory,
    generatedAt: GENERATED_AT
  });
}

function rejects(run) {
  return assert.rejects(run, error => (
    error?.code === 'BUDGET_V2_POSTGRES_EPHEMERAL_EXECUTION_INVALID'
    && error.message === 'Invalid Budget V2 PostgreSQL ephemeral execution'
  ));
}

test('collector distinguishes missing, empty, conformant and divergent schemas', async () => {
  const missing = await harness({ createSchema: false });
  const empty = await harness();
  const conformant = await harness();
  const divergent = await harness();
  try {
    assert.equal((await collectBudgetV2PostgresInventory({
      session: missing.session, target: TARGET, observedAt: OBSERVED_AT
    })).schemaState, 'missing');
    assert.equal((await collectBudgetV2PostgresInventory({
      session: empty.session, target: TARGET, observedAt: OBSERVED_AT
    })).schemaState, 'empty');
    for (const statement of buildBudgetV2PostgresOfflinePlan().statements) {
      await conformant.database.exec(statement);
    }
    const conformantInventory = await collectBudgetV2PostgresInventory({
      session: conformant.session, target: TARGET, observedAt: OBSERVED_AT
    });
    assert.equal(conformantInventory.schemaState, 'conformant');
    assert.match(conformantInventory.catalogFingerprint, /^[0-9a-f]{64}$/);
    await divergent.database.exec(`CREATE TABLE ${SCHEMA_NAME}.unexpected_table (id integer)`);
    const divergentInventory = await collectBudgetV2PostgresInventory({
      session: divergent.session, target: TARGET, observedAt: OBSERVED_AT
    });
    assert.equal(divergentInventory.schemaState, 'divergent');
    assert.deepEqual(divergentInventory.unexpectedObjects, ['catalog-drift']);
  } finally {
    await Promise.all([missing.close(), empty.close(), conformant.close(), divergent.close()]);
  }
});

test('authorized plan is applied once and produces a closed proof', async () => {
  const local = await harness();
  try {
    const plan = await plannedCreate(local.session);
    const store = createBudgetV2EphemeralConsumptionStore();
    const result = await executeBudgetV2PostgresEphemeralMigration({
      session: local.session,
      plan,
      authorization: authorization(plan),
      executionContext: context(),
      consumptionStore: store
    });
    assert.equal(result.outcome, 'applied');
    assert.equal(result.appliedStatements, 3);
    assert.equal(result.catalogValid, true);
    assert.equal(result.consumptionState, 'applied');
    assert.equal(store.getState(plan.fingerprint), 'applied');
    assert.equal(Object.isFrozen(result), true);
    assert.doesNotMatch(JSON.stringify(result), /CREATE TABLE|password|localhost/i);
    const inventory = await collectBudgetV2PostgresInventory({
      session: local.session, target: TARGET, observedAt: DEADLINE_AT
    });
    assert.equal(inventory.schemaState, 'conformant');
  } finally {
    await local.close();
  }
});

test('the same plan cannot be consumed twice and replay stops before SQL', async () => {
  const local = await harness();
  try {
    const plan = await plannedCreate(local.session);
    const store = createBudgetV2EphemeralConsumptionStore();
    await executeBudgetV2PostgresEphemeralMigration({
      session: local.session, plan, authorization: authorization(plan),
      executionContext: context(), consumptionStore: store
    });
    let transactions = 0;
    const countingSession = {
      ...local.session,
      transaction: async callback => {
        transactions += 1;
        return local.session.transaction(callback);
      }
    };
    await rejects(() => executeBudgetV2PostgresEphemeralMigration({
      session: countingSession, plan, authorization: authorization(plan),
      executionContext: context(), consumptionStore: store
    }));
    assert.equal(transactions, 0);
  } finally {
    await local.close();
  }
});

test('invalid context and authorization stop before reservation and SQL', async () => {
  const local = await harness();
  try {
    const plan = await plannedCreate(local.session);
    for (const [executionContext, candidateAuthorization] of [
      [context({ environment: 'preview' }), authorization(plan)],
      [context({ networkMode: 'loopback' }), authorization(plan)],
      [context({ storageMode: 'file' }), authorization(plan)],
      [context({ deadlineAt: '2026-09-09T20:05:00.001Z' }), authorization(plan)],
      [context(), authorization(plan, { confirmation: 'APPLY' })]
    ]) {
      let transactions = 0;
      const session = {
        ...local.session,
        transaction: async callback => {
          transactions += 1;
          return local.session.transaction(callback);
        }
      };
      await rejects(() => executeBudgetV2PostgresEphemeralMigration({
        session,
        plan,
        authorization: candidateAuthorization,
        executionContext,
        consumptionStore: createBudgetV2EphemeralConsumptionStore()
      }));
      assert.equal(transactions, 0);
    }
  } finally {
    await local.close();
  }
});

test('a certain failure inside the transaction rolls back every object', async () => {
  const local = await harness();
  try {
    const plan = await plannedCreate(local.session);
    const store = createBudgetV2EphemeralConsumptionStore();
    const failingSession = {
      ...local.session,
      transaction: callback => local.session.transaction(async transaction => {
        let statements = 0;
        return callback({
          ...transaction,
          exec: async statement => {
            statements += 1;
            if (statements === 2) throw new Error('synthetic statement failure');
            return transaction.exec(statement);
          }
        });
      })
    };
    const result = await executeBudgetV2PostgresEphemeralMigration({
      session: failingSession, plan, authorization: authorization(plan),
      executionContext: context(), consumptionStore: store
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.appliedStatements, 0);
    assert.equal(store.getState(plan.fingerprint), 'failed');
    assert.equal((await collectBudgetV2PostgresInventory({
      session: local.session, target: TARGET, observedAt: DEADLINE_AT
    })).schemaState, 'empty');
  } finally {
    await local.close();
  }
});

test('a lost commit acknowledgement is uncertain and never retried', async () => {
  const local = await harness();
  try {
    const plan = await plannedCreate(local.session);
    const store = createBudgetV2EphemeralConsumptionStore();
    const uncertainSession = {
      ...local.session,
      transaction: async callback => {
        await local.session.transaction(callback);
        throw new Error('synthetic lost acknowledgement');
      }
    };
    const result = await executeBudgetV2PostgresEphemeralMigration({
      session: uncertainSession, plan, authorization: authorization(plan),
      executionContext: context(), consumptionStore: store
    });
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.appliedStatements, null);
    assert.equal(result.consumptionState, 'uncertain');
    assert.equal(store.getState(plan.fingerprint), 'uncertain');
    assert.equal((await collectBudgetV2PostgresInventory({
      session: local.session, target: TARGET, observedAt: DEADLINE_AT
    })).schemaState, 'conformant');
    await rejects(() => executeBudgetV2PostgresEphemeralMigration({
      session: local.session, plan, authorization: authorization(plan),
      executionContext: context(), consumptionStore: store
    }));
  } finally {
    await local.close();
  }
});

test('blocked, no-op and expired plans are refused before a transaction', async () => {
  const missing = await harness({ createSchema: false });
  const conformant = await harness();
  const empty = await harness();
  try {
    for (const statement of buildBudgetV2PostgresOfflinePlan().statements) {
      await conformant.database.exec(statement);
    }
    const blockedPlan = planFromInventory(await collectBudgetV2PostgresInventory({
      session: missing.session, target: TARGET, observedAt: OBSERVED_AT
    }));
    const noopPlan = planFromInventory(await collectBudgetV2PostgresInventory({
      session: conformant.session, target: TARGET, observedAt: OBSERVED_AT
    }));
    const createPlan = await plannedCreate(empty.session);
    for (const [plan, executionContext] of [
      [blockedPlan, context()],
      [noopPlan, context()],
      [createPlan, context({
        startedAt: '2026-09-09T20:31:00.001Z',
        deadlineAt: '2026-09-09T20:32:00.000Z'
      })]
    ]) {
      let transactions = 0;
      const session = {
        ...empty.session,
        transaction: async callback => {
          transactions += 1;
          return empty.session.transaction(callback);
        }
      };
      await rejects(() => executeBudgetV2PostgresEphemeralMigration({
        session,
        plan,
        authorization: authorization(plan),
        executionContext,
        consumptionStore: createBudgetV2EphemeralConsumptionStore()
      }));
      assert.equal(transactions, 0);
    }
  } finally {
    await Promise.all([missing.close(), conformant.close(), empty.close()]);
  }
});

test('collector never reads table contents and refuses open session metadata', async () => {
  const local = await harness();
  try {
    const observedQueries = [];
    const session = {
      ...local.session,
      query: (text, params) => {
        observedQueries.push(text);
        return local.session.query(text, params);
      }
    };
    await collectBudgetV2PostgresInventory({
      session, target: TARGET, observedAt: OBSERVED_AT
    });
    assert.equal(observedQueries.some(query => /document_json|SELECT\s+\*/i.test(query)), false);
    await assert.rejects(() => collectBudgetV2PostgresInventory({
      session: { ...session, capabilities: { ...session.capabilities, host: 'local' } },
      target: TARGET,
      observedAt: OBSERVED_AT
    }), error => error?.code === 'BUDGET_V2_POSTGRES_EPHEMERAL_EXECUTION_INVALID');
    await assert.rejects(() => collectBudgetV2PostgresInventory({
      session,
      target: { ...TARGET, host: 'local' },
      observedAt: OBSERVED_AT
    }), error => error?.code === 'BUDGET_V2_POSTGRES_EPHEMERAL_EXECUTION_INVALID');
    await assert.rejects(() => collectBudgetV2PostgresInventory({
      session: {
        ...session,
        query: async () => { throw new Error('private driver failure'); }
      },
      target: TARGET,
      observedAt: OBSERVED_AT
    }), error => error?.code === 'BUDGET_V2_POSTGRES_EPHEMERAL_EXECUTION_INVALID'
      && !error.message.includes('private'));
  } finally {
    await local.close();
  }
});

test('ephemeral lot is absent from server and has no network, file or environment access', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'financeBudgetV2PostgresEphemeralExecutor.js'
  ), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source,
    /express|@google-cloud|require\(['"]pg['"]\)|node:fs|node:http|node:https|process\.env|Date\.now|fetch\(/i);
  assert.doesNotMatch(server, /financeBudgetV2PostgresEphemeralExecutor/);
});
