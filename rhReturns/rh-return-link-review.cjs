'use strict';

const { identifier } = require('./rh-dossiers-contract.cjs');
const { receiveSalary, receiveHours } = require('./retours.cjs');

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('RH_RETURN_INVALID_FIELDS');
  }
}

// A supplied snapshot is not a database read or an access decision.
function prepareReturnLinkReview({ kind, source, binding, currentDossiers, today, previousSource = null }) {
  exact(binding, ['workerKey', 'employeeName', 'employeeId', 'dossierRevision', 'period', 'amountXof']);
  const employeeId = identifier(binding.employeeId);
  if (!Number.isSafeInteger(binding.dossierRevision) || binding.dossierRevision < 1 ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(binding.period || '') ||
      !Number.isSafeInteger(binding.amountXof) || binding.amountXof <= 0) {
    throw new Error('RH_RETURN_INVALID_BINDING');
  }
  if (!Array.isArray(currentDossiers) || !currentDossiers.length || currentDossiers.length > 1000) {
    throw new Error('RH_RETURN_INVALID_SNAPSHOT');
  }
  const dossiers = new Map();
  for (const row of currentDossiers) {
    exact(row, ['employeeId', 'displayName', 'dossierRevision']);
    const id = identifier(row.employeeId);
    if (typeof row.displayName !== 'string' || !row.displayName.trim() ||
        !Number.isSafeInteger(row.dossierRevision) || row.dossierRevision < 1 || dossiers.has(id)) {
      throw new Error('RH_RETURN_INVALID_SNAPSHOT');
    }
    dossiers.set(id, row);
  }
  const current = dossiers.get(employeeId);
  if (!current || current.displayName !== binding.employeeName) throw new Error('RH_RETURN_DOSSIER_MISMATCH');
  if (current.dossierRevision !== binding.dossierRevision) throw new Error('RH_RETURN_STALE_REVISION');
  const expected = { workerKey: binding.workerKey, employeeName: binding.employeeName,
    period: binding.period, amountXof: binding.amountXof, today };
  let review;
  if (kind === 'salary') review = receiveSalary(source, expected, previousSource);
  else if (kind === 'hours') {
    review = receiveHours(source, expected, previousSource);
    if (review.entries.some(entry => entry.date.slice(0, 7) !== binding.period)) {
      throw new Error('RH_RETURN_HOURS_PERIOD_MISMATCH');
    }
  } else throw new Error('RH_RETURN_UNSUPPORTED_KIND');
  return {
    status: 'local_link_review_only', kind, employeeId,
    dossierRevision: binding.dossierRevision, period: binding.period, review,
    databaseRevisionVerified: false, accessAuthorized: false,
    authenticated: false, syncM3s: false, writes: 0,
    paymentConfirmed: false, salaryCalculation: null,
    blockers: ['live_dossier_and_access_check', 'authenticated_collector_provenance',
      'persistent_revision_and_duplicate_control', ...(kind === 'salary' && review.data.proof !== null
        ? ['private_proof_file_resolution'] : [])]
  };
}

function prepareReturnLinkBatchReview(input) {
  exact(input, ['items', 'currentDossiers', 'today']);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) {
    throw new Error('RH_RETURN_INVALID_BATCH');
  }
  const seen = new Set(), workers = new Map(), employees = new Map();
  let bytes = 0;
  // Validate the complete lot before returning any proposal; never partly accept it.
  const rows = input.items.map(item => {
    exact(item, ['kind', 'source', 'binding', 'previousSource']);
    for (const source of [item.source, item.previousSource]) {
      if (source !== null) {
        if (typeof source !== 'string') throw new Error('RH_RETURN_INVALID_BATCH');
        bytes += new TextEncoder().encode(source).byteLength;
      }
    }
    if (bytes > 2 * 1024 * 1024) throw new Error('RH_RETURN_BATCH_TOO_LARGE');
    const result = prepareReturnLinkReview({ ...item,
      currentDossiers: input.currentDossiers, today: input.today });
    const worker = item.binding.workerKey, employee = result.employeeId;
    if ((workers.has(worker) && workers.get(worker) !== employee) ||
        (employees.has(employee) && employees.get(employee) !== worker)) {
      throw new Error('RH_RETURN_AMBIGUOUS_BINDING');
    }
    workers.set(worker, employee); employees.set(employee, worker);
    const key = `${employee}|${result.period}|${result.kind}`;
    if (seen.has(key)) throw new Error('RH_RETURN_DUPLICATE_BATCH_ITEM');
    seen.add(key);
    const incomingCount = result.kind === 'hours' ? receiveHours(item.source, {
      workerKey: worker, employeeName: item.binding.employeeName, today: input.today
    }).entries.length : null;
    const duplicate = result.kind === 'salary' ? result.review.duplicate
      : incomingCount > 0 && result.review.skipped === incomingCount;
    const base = {
      kind: result.kind, employeeId: employee, employeeName: item.binding.employeeName,
      dossierRevision: result.dossierRevision, period: result.period,
      duplicate, reviewStatus: result.kind === 'salary' ? result.review.review : 'declared_hours_to_review',
      blockers: result.blockers.slice()
    };
    // Preview contains neither notes, collector identity nor proof filenames.
    return result.kind === 'salary' ? { ...base,
      expectedAmountXof: result.review.expectedAmountXof,
      declaredAmountXof: result.review.data.amount_xof,
      receivedDateDeclared: result.review.data.received_date,
      proofStatus: result.review.proofStatus
    } : { ...base, entryCount: result.review.entries.length, incomingCount,
      skippedCount: result.review.skipped,
      declaredMinutes: result.review.entries.reduce((total, entry) => total + entry.minutes, 0),
      timezone: 'Africa/Dakar'
    };
  });
  return {
    status: 'local_batch_preview_only', rows,
    totals: { items: rows.length, employees: employees.size,
      salaryDeclarations: rows.filter(row => row.kind === 'salary').length,
      hoursReviews: rows.filter(row => row.kind === 'hours').length,
      duplicates: rows.filter(row => row.duplicate).length,
      discrepancies: rows.filter(row => ['amount_discrepancy', 'difference_reported'].includes(row.reviewStatus)).length },
    databaseRevisionVerified: false, accessAuthorized: false, authenticated: false,
    syncM3s: false, writes: 0, paymentConfirmed: false, salaryCalculation: null
  };
}

function makeReturnLinkPreviewExport(input, recordedAtClient) {
  const proposal = prepareReturnLinkBatchReview(input);
  if (typeof recordedAtClient !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recordedAtClient) ||
      !Number.isFinite(Date.parse(recordedAtClient)) ||
      new Date(recordedAtClient).toISOString() !== recordedAtClient ||
      recordedAtClient.slice(0, 10) > input.today) {
    throw new Error('RH_RETURN_INVALID_EXPORT_TIMESTAMP');
  }
  return { schema: '2sg.rh.return-link-preview.local.v1', recordedAtClient,
    ...proposal, importableInM3s: false };
}

module.exports = { prepareReturnLinkReview, prepareReturnLinkBatchReview, makeReturnLinkPreviewExport };
