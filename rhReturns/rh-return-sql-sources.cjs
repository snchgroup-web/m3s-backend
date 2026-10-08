'use strict';
const { createQualifiedReturnPolicy } = require('./rh-return-current-policy.cjs');
const fail = () => { throw new Error('RH_RETURN_SQL_SOURCE_UNAVAILABLE'); };

// Uses the observer's transaction and scoped connection, never a second pool.
function buildReturnSqlSources({ qualified = false, synthetic = true } = {}) {
  async function query(context, sql, params) {
    if (qualified !== true || typeof context?.client?.query !== 'function') fail();
    if (synthetic) {
      const gate = await context.client.query("SELECT current_setting('m3s.rh_return_candidate_test_only',true) AS gate");
      if (gate.rows[0]?.gate !== 'synthetic-only') fail();
    }
    return context.client.query(sql, params);
  }
  return Object.freeze({
    async authorizeObservation(context) {
      const policy = createQualifiedReturnPolicy({ qualified, readDecisions: async lookup => {
        const result = await query(context, `SELECT can_observe,
          (SELECT can_read FROM rh_private.entitlement_revisions
            WHERE tenant=$1 AND owner_id=$2 ORDER BY revision DESC LIMIT 1) AS can_read
          FROM rh_private.return_decision_revisions
          WHERE tenant=$1 AND owner_id=$2 AND actor=$3 AND employee_id=$4 AND dossier_revision=$5
          AND worked_period=$6 AND kind=$7 ORDER BY revision DESC LIMIT 1`,
        [lookup.tenant,lookup.owner,lookup.actor,lookup.employeeId,lookup.dossierRevision,`${lookup.period}-01`,lookup.kind]);
        if (result.rows.length > 1 || (result.rows[0] && typeof result.rows[0].can_observe !== 'boolean')) fail();
        if (result.rows[0]?.can_read != null && typeof result.rows[0].can_read !== 'boolean') fail();
        return result.rows[0]?.can_observe === true && result.rows[0]?.can_read === true ? [{ ...lookup }] : [];
      } });
      return policy.authorizeObservation(context);
    },
    async resolveExpectation(context) {
      const { scope, target } = context;
      const result = await query(context, `SELECT worker_key,employee_name,amount_xof::text,source_ref,available
        FROM rh_private.return_expectation_revisions WHERE tenant=$1 AND owner_id=$2
        AND employee_id=$3 AND dossier_revision=$4 AND worked_period=$5 ORDER BY revision DESC LIMIT 1`,
      [scope.tenant,scope.owner,target.employeeId,target.dossierRevision,`${target.period}-01`]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || row.available !== true || typeof row.amount_xof !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(row.amount_xof) || !Number.isSafeInteger(Number(row.amount_xof))) fail();
      return { workerKey: row.worker_key, employeeName: row.employee_name,
        amountXof: Number(row.amount_xof), sourceRef: row.source_ref };
    }
  });
}

function createSyntheticReturnSqlSources({syntheticOnly=false} = {}) {
  return buildReturnSqlSources({qualified:syntheticOnly === true,synthetic:true});
}
function createQualifiedReturnSqlSources({qualified=false} = {}) {
  return buildReturnSqlSources({qualified,synthetic:false});
}
module.exports = { createSyntheticReturnSqlSources,createQualifiedReturnSqlSources };
