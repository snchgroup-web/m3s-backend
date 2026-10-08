'use strict';
const { createHash } = require('node:crypto');
const { identifier } = require('./rh-dossiers-contract.cjs');
const { prepareReturnLinkReview } = require('./rh-return-link-review.cjs');
const { receiveHours } = require('./retours.cjs');
const { mergeWorkEntries } = require('./salary-core.cjs');
const { assertReturnWriterAccess } = require('./rh-return-production-access.cjs');

const fail = code => { throw new Error(code); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('RH_RETURN_INVALID_FIELDS');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// Deliberately unmounted: disposable SQL qualification, not a production writer.
function buildReturnObservationService(pool, { qualified = false, synthetic = true, authorizeObservation,
  resolveExpectation, now = () => new Date() } = {}) {
  return Object.freeze({ async observeBatch(scope, inputs) {
    if (qualified !== true || typeof pool?.connect !== 'function' ||
        typeof authorizeObservation !== 'function' || typeof resolveExpectation !== 'function') fail('RH_RETURN_NOT_QUALIFIED');
    exact(scope, ['tenant', 'owner', 'actor']);
    if (Object.values(scope).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail('RH_RETURN_INVALID_SCOPE');
    scope = Object.freeze({ ...scope });
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) fail('RH_RETURN_INVALID_BATCH');
    let bytes = 0;
    const requests = new Set(), targets = new Set();
    const candidates = inputs.map(input => {
      exact(input, ['requestId', 'employeeId', 'dossierRevision', 'kind', 'period', 'expectedPreviousRevision', 'source']);
      const target = { ...input, requestId: identifier(input.requestId), employeeId: identifier(input.employeeId) };
      if (!['salary', 'hours'].includes(target.kind) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(target.period || '') ||
          !Number.isSafeInteger(target.dossierRevision) || target.dossierRevision < 1 ||
          !Number.isSafeInteger(target.expectedPreviousRevision) || target.expectedPreviousRevision < 0 || target.expectedPreviousRevision >= 10000 ||
          typeof target.source !== 'string') fail('RH_RETURN_INVALID_TARGET');
      const size = new TextEncoder().encode(target.source).byteLength; bytes += size;
      if (size > 1024 * 1024 || bytes > 2 * 1024 * 1024) fail('RH_RETURN_BATCH_TOO_LARGE');
      const key = `${target.employeeId}|${target.period}|${target.kind}`;
      if (requests.has(target.requestId) || targets.has(key)) fail('RH_RETURN_DUPLICATE_BATCH_ITEM');
      requests.add(target.requestId); targets.add(key);
      return Object.freeze(target);
    });
    const date = now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('RH_RETURN_INVALID_SERVER_DATE');
    const today = date.toISOString().slice(0, 10); // Dakar uses UTC throughout the year.
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      if (synthetic) {
        const gate = await client.query("SELECT current_setting('m3s.rh_return_candidate_test_only',true) AS gate");
        if (gate.rows[0]?.gate !== 'synthetic-only') fail('RH_RETURN_NOT_QUALIFIED');
      } else {
        await assertReturnWriterAccess(client);
      }
      await client.query("SELECT set_config('m3s.tenant',$1,true),set_config('m3s.owner',$2,true),set_config('m3s.actor',$3,true)",
        [scope.tenant, scope.owner, scope.actor]);
      // Stable lock ordering protects batches with shared dossiers or request keys.
      const locks = new Set([`rh-access-v1:${scope.tenant}:${scope.owner}`, ...candidates.flatMap(target => [
        `rh-draft-v1:${scope.tenant}:${scope.owner}:${target.employeeId}`,
        `rh-return-request-v1:${scope.tenant}:${scope.owner}:${target.requestId}`
      ])]);
      for (const key of [...locks].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const results = [];
      const contexts = [];
      async function allowed(context) {
        let permission;
        try { permission = await authorizeObservation(context); }
        catch { fail('RH_RETURN_ACCESS_SOURCE_UNAVAILABLE'); }
        if (permission !== true) fail('RH_RETURN_OBSERVATION_DENIED');
      }
      for (const target of candidates) {
        const context = Object.freeze({ client, scope: Object.freeze({ ...scope }), target });
        await allowed(context);
        contexts.push(context);
        const dossier = await client.query(`SELECT revision,display_name,record_status,classification FROM rh_private.employee_revisions
          WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 ORDER BY revision DESC LIMIT 1`,
        [scope.tenant, scope.owner, target.employeeId]);
        const row = dossier.rows[0];
        if (!row || row.revision !== target.dossierRevision || row.record_status !== 'draft' || row.classification !== 'C3') fail('RH_RETURN_STALE_DOSSIER');
        let expectation;
        try { expectation = await resolveExpectation(context); }
        catch { fail('RH_RETURN_EXPECTATION_UNAVAILABLE'); }
        exact(expectation, ['workerKey', 'employeeName', 'amountXof', 'sourceRef']);
        if (expectation.employeeName !== row.display_name || typeof expectation.sourceRef !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(expectation.sourceRef)) fail('RH_RETURN_EXPECTATION_UNAVAILABLE');
        const binding = { workerKey: expectation.workerKey, employeeName: expectation.employeeName,
          amountXof: expectation.amountXof, employeeId: target.employeeId,
          dossierRevision: target.dossierRevision, period: target.period };
        const checked = prepareReturnLinkReview({ kind: target.kind, source: target.source, binding,
          currentDossiers: [{ employeeId: target.employeeId, dossierRevision: row.revision, displayName: row.display_name }], today });
        const parsed = JSON.parse(target.source);
        const digestInput = { employeeId: target.employeeId, dossierRevision: target.dossierRevision,
          kind: target.kind, period: target.period, expectedPreviousRevision: target.expectedPreviousRevision,
          source: canonical(parsed), expectation: canonical(expectation) };
        const digest = createHash('sha256').update(JSON.stringify(canonical(digestInput))).digest('hex');
        const prior = await client.query(`SELECT input_sha256,employee_id,worked_period,kind,observation_revision
          FROM rh_private.return_observations WHERE tenant=$1 AND owner_id=$2 AND request_id=$3`,
        [scope.tenant, scope.owner, target.requestId]);
        if (prior.rows.length) {
          if (prior.rows[0].input_sha256 !== digest) fail('RH_RETURN_REQUEST_CONFLICT');
          results.push({ employeeId: target.employeeId, period: target.period, kind: target.kind,
            observationRevision: prior.rows[0].observation_revision, replayed: true });
          continue;
        }
        const previous = await client.query(`SELECT observation_revision,source_declared FROM rh_private.return_observations
          WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 AND worked_period=$4 AND kind=$5
          ORDER BY observation_revision DESC LIMIT 1`,
        [scope.tenant, scope.owner, target.employeeId, `${target.period}-01`, target.kind]);
        const revision = previous.rows[0]?.observation_revision || 0;
        if (revision !== target.expectedPreviousRevision) fail('RH_RETURN_OBSERVATION_REVISION_CONFLICT');
        let stored = parsed;
        if (target.kind === 'hours') {
          const hourContext = { workerKey: expectation.workerKey, employeeName: expectation.employeeName, today };
          const old = previous.rows[0]?.source_declared;
          const merged = receiveHours(target.source, hourContext, old ? JSON.stringify(old) : null);
          if (merged.entries.some(entry => entry.date.slice(0, 7) !== target.period)) fail('RH_RETURN_HOURS_PERIOD_MISMATCH');
          if (!merged.entries.length || (old && merged.entries.length === old.entries.length)) fail('RH_RETURN_NO_NEW_HOURS');
          const neighbours = await client.query(`SELECT DISTINCT ON (worked_period) worked_period::text AS period_date,source_declared
            FROM rh_private.return_observations WHERE tenant=$1 AND owner_id=$2 AND employee_id=$3 AND kind='hours'
            AND worked_period BETWEEN $4::date - interval '1 month' AND $4::date + interval '1 month'
            AND worked_period <> $4::date ORDER BY worked_period,observation_revision DESC`,
          [scope.tenant, scope.owner, target.employeeId, `${target.period}-01`]);
          const adjacent = neighbours.rows.flatMap(row => {
            const entries = receiveHours(JSON.stringify(row.source_declared), hourContext).entries;
            if (entries.some(entry => entry.date.slice(0, 7) !== row.period_date.slice(0, 7))) fail('RH_RETURN_HOURS_PERIOD_MISMATCH');
            return entries;
          });
          // The existing core checks full intervals, not pause-subtracted durations.
          mergeWorkEntries([], [...adjacent, ...merged.entries]);
          stored = { ...parsed, entries: merged.entries };
        }
        await client.query(`INSERT INTO rh_private.return_observations
          (tenant,owner_id,employee_id,dossier_revision,worked_period,kind,observation_revision,
           previous_revision,request_id,input_sha256,recorded_by,review_status,source_declared,expectation_source_ref)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unverified_declaration',$12,$13)`,
        [scope.tenant, scope.owner, target.employeeId, target.dossierRevision, `${target.period}-01`, target.kind,
          revision + 1, revision || null, target.requestId, digest, scope.actor,
          JSON.stringify(canonical(stored)), expectation.sourceRef]);
        results.push({ employeeId: target.employeeId, period: target.period, kind: target.kind,
          observationRevision: revision + 1, replayed: false,
          review: target.kind === 'salary' ? checked.review.review : 'declared_hours_to_review' });
      }
      for (const context of contexts) await allowed(context);
      await client.query('COMMIT');
      return { status: synthetic ? 'synthetic_observations_only' : 'unverified_observations', results, paymentConfirmed: false,
        employeeAuthenticated: false, productionEnabled: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw error;
    } finally { client.release(broken); }
  } });
}

function createSyntheticReturnObservationService(pool, {syntheticOnly=false,authorizeObservation,resolveExpectation,now} = {}) {
  return buildReturnObservationService(pool,{qualified:syntheticOnly === true,synthetic:true,authorizeObservation,resolveExpectation,now});
}
function createQualifiedReturnObservationService(pool, {qualified=false,authorizeObservation,resolveExpectation,now} = {}) {
  return buildReturnObservationService(pool,{qualified,synthetic:false,authorizeObservation,resolveExpectation,now});
}
module.exports = { createSyntheticReturnObservationService,createQualifiedReturnObservationService };
