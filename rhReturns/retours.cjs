'use strict';

(function () {
const { previousMonth, validationError, workMinutes, mergeWorkEntries } =
  typeof module !== 'undefined' && module.exports ? require('./salary-core.cjs') : globalThis;

function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error('INVALID_RETURN_FIELDS');
  }
}
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error('INVALID_RETURN_TEXT');
}
function parse(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > 1024 * 1024) throw new Error('INVALID_RETURN_SIZE');
  try { return JSON.parse(source); } catch { throw new Error('INVALID_RETURN_JSON'); }
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('INVALID_CLIENT_TIMESTAMP');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('INVALID_CLIENT_TIMESTAMP');
  return value.slice(0, 10);
}
function context(expected) {
  text(expected.workerKey); text(expected.employeeName); previousMonth(expected.today);
}
function untrusted(value, hours = false) {
  if (value.authenticated !== false || value.sync_m3s !== false ||
      (hours ? value.validated_by_2sg !== false : value.signature !== null)) throw new Error('UNSUPPORTED_TRUST_CLAIM');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function salary(source, expected) {
  context(expected);
  const data = parse(source);
  exact(data, ['schema', 'reference', 'employee_name', 'role', 'site', 'payroll_period', 'amount_xof',
    'received_date', 'funding_channel', 'group_transfer_date', 'individual_delivery_channel', 'status',
    'note', 'channel', 'collector', 'recorded_at_client', 'authenticated', 'signature', 'sync_m3s', 'proof']);
  if (data.schema !== '2sg.salary.declaration.local.v1') throw new Error('UNSUPPORTED_RETURN_SCHEMA');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(expected.period || '') ||
      !Number.isSafeInteger(expected.amountXof) || expected.amountXof <= 0) throw new Error('INVALID_EXPECTED_PAYROLL');
  if (data.reference !== `LOCAL-${expected.workerKey}-${expected.period}` ||
      data.employee_name !== expected.employeeName || data.payroll_period !== expected.period) throw new Error('RETURN_SCOPE_MISMATCH');
  untrusted(data);
  text(data.role); text(data.site);
  if (!['confirmed_local', 'difference_reported'].includes(data.status) || !['direct', 'accompanied'].includes(data.channel)) throw new Error('INVALID_RETURN_STATUS');
  if (data.channel === 'accompanied') text(data.collector);
  else if (data.collector !== null) throw new Error('INVALID_RETURN_COLLECTOR');
  if (typeof data.note !== 'string' || data.note.length > 2000) throw new Error('INVALID_RETURN_NOTE');
  if (data.status === 'difference_reported' && !data.note.trim()) throw new Error('INVALID_RETURN_NOTE');
  if (!Number.isSafeInteger(data.amount_xof) || data.amount_xof <= 0) throw new Error('INVALID_RETURN_AMOUNT');
  if (data.received_date !== null) {
    previousMonth(data.received_date);
    if (data.received_date > expected.today) throw new Error('FUTURE_RETURN_DATE');
  }
  const recordedDate = timestamp(data.recorded_at_client);
  if (recordedDate > expected.today || (data.received_date && recordedDate < data.received_date)) throw new Error('RETURN_DATE_ORDER');
  previousMonth(data.group_transfer_date);
  if (data.group_transfer_date > expected.today) throw new Error('FUTURE_RETURN_DATE');
  if (data.funding_channel !== 'Wave grouped transfer' || data.individual_delivery_channel !== null) throw new Error('UNSUPPORTED_DELIVERY_CLAIM');
  if (data.status === 'confirmed_local' && validationError({ period: data.payroll_period,
    receivedDate: data.received_date, amount: data.amount_xof, channel: data.channel,
    collector: data.collector || '', checked: true }, expected.today)) throw new Error('INVALID_LOCAL_CONFIRMATION');
  if (data.proof !== null) {
    exact(data.proof, ['name', 'mime', 'size', 'sha256']); text(data.proof.name);
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(data.proof.mime) || !Number.isSafeInteger(data.proof.size) ||
        data.proof.size <= 0 || data.proof.size > 5 * 1024 * 1024 ||
        (data.proof.sha256 !== null && (typeof data.proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.proof.sha256)))) throw new Error('INVALID_PROOF_METADATA');
  }
  return data;
}

function receiveSalary(source, expected, previousSource = null) {
  const data = salary(source, expected);
  if (previousSource !== null) {
    const previous = salary(previousSource, expected);
    if (JSON.stringify(canonical(previous)) !== JSON.stringify(canonical(data))) throw new Error('CONFLICTING_RETURN_NO_OVERWRITE');
  }
  return {
    status: 'local_review_only', duplicate: previousSource !== null, expectedAmountXof: expected.amountXof,
    review: data.status === 'difference_reported' ? 'difference_reported'
      : data.amount_xof !== expected.amountXof ? 'amount_discrepancy' : 'declaration_to_review',
    proofStatus: data.proof === null ? 'no_attached_proof_metadata' : 'file_not_received_or_resolved',
    authenticated: false, sync_m3s: false, writes: 0, data
  };
}

function hours(source, expected) {
  context(expected);
  const data = parse(source);
  exact(data, ['schema', 'employee_key', 'employee_name', 'timezone', 'authenticated', 'validated_by_2sg', 'sync_m3s', 'entries']);
  if (data.schema !== '2sg.work-hours.local.v1') throw new Error('UNSUPPORTED_RETURN_SCHEMA');
  if (data.employee_key !== expected.workerKey || data.employee_name !== expected.employeeName || data.timezone !== 'Africa/Dakar') throw new Error('RETURN_SCOPE_MISMATCH');
  untrusted(data, true);
  if (!Array.isArray(data.entries) || data.entries.length > 1000) throw new Error('INVALID_HOURS_LIST');
  return data.entries.map(entry => {
    exact(entry, ['id', 'date', 'start', 'end', 'pause', 'overnight', 'minutes', 'declared_at_client']);
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(entry.id)) throw new Error('INVALID_HOURS_ID');
    previousMonth(entry.date);
    if (entry.date > expected.today || typeof entry.overnight !== 'boolean') throw new Error('INVALID_HOURS_DATE');
    const recordedDate = timestamp(entry.declared_at_client);
    if (recordedDate > expected.today || recordedDate < entry.date) throw new Error('RETURN_DATE_ORDER');
    if (workMinutes(entry.start, entry.end, entry.pause, entry.overnight) !== entry.minutes) throw new Error('HOURS_DURATION_MISMATCH');
    return entry;
  });
}

function receiveHours(source, expected, previousSource = null) {
  const incoming = hours(source, expected);
  const existing = previousSource === null ? [] : mergeWorkEntries([], hours(previousSource, expected)).entries;
  const result = mergeWorkEntries(existing, incoming);
  if (result.entries.length > 1000) throw new Error('MAX_HOURS_ENTRIES');
  return { status: 'local_review_only', ...result, authenticated: false, validated_by_2sg: false,
    sync_m3s: false, writes: 0, salaryCalculation: null };
}

function inspectReview(source, options) {
  previousMonth(options.today);
  if (!Array.isArray(options.profiles) || !options.profiles.length) throw new Error('INVALID_REVIEW_PROFILES');
  const profileKeys = new Set();
  options.profiles.forEach(profile => {
    text(profile.key); text(profile.name);
    if (profileKeys.has(profile.key)) throw new Error('INVALID_REVIEW_PROFILES');
    profileKeys.add(profile.key);
  });
  const report = parse(source);
  exact(report, ['schema', 'authenticated', 'validated_by_2sg', 'sync_m3s', 'reviewed_at_client', 'declarations', 'hours']);
  if (report.schema !== '2sg.salary.return-review.local.v1') throw new Error('UNSUPPORTED_RETURN_SCHEMA');
  untrusted(report, true);
  if (timestamp(report.reviewed_at_client) > options.today) throw new Error('RETURN_DATE_ORDER');
  if (!Array.isArray(report.declarations) || report.declarations.length > 240 ||
      !Array.isArray(report.hours) || report.hours.length > options.profiles.length) throw new Error('INVALID_REVIEW_LIST');
  const salaryKeys = new Set(), hourKeys = new Set();
  const salaryItems = report.declarations.map(item => {
    exact(item, ['status', 'duplicate', 'expectedAmountXof', 'review', 'proofStatus', 'authenticated', 'sync_m3s', 'writes', 'data']);
    if (!item.data || typeof item.data !== 'object' || item.status !== 'local_review_only' ||
        typeof item.duplicate !== 'boolean' || item.writes !== 0) throw new Error('INVALID_REVIEW_RECORD');
    untrusted({ ...item, signature: null });
    const profile = options.profiles.find(profile => item.data.employee_name === profile.name &&
      item.data.reference === `LOCAL-${profile.key}-${item.data.payroll_period}`);
    if (!profile) throw new Error('RETURN_SCOPE_MISMATCH');
    const fields = { workerKey: profile.key, employeeName: profile.name, period: item.data.payroll_period,
      amountXof: item.expectedAmountXof, today: options.today };
    const payload = JSON.stringify(item.data), result = receiveSalary(payload, fields);
    if (result.review !== item.review || result.proofStatus !== item.proofStatus) throw new Error('INCONSISTENT_REVIEW_RECORD');
    const key = `${profile.key}|${fields.period}`;
    if (salaryKeys.has(key)) throw new Error('DUPLICATE_REVIEW_RECORD');
    salaryKeys.add(key);
    return { workerKey: profile.key, period: fields.period, source: payload, result };
  });
  const hoursItems = report.hours.map(item => {
    exact(item, ['workerKey', 'status', 'entries', 'skipped', 'authenticated', 'validated_by_2sg', 'sync_m3s', 'writes', 'salaryCalculation']);
    untrusted(item, true);
    if (item.status !== 'local_review_only' || item.writes !== 0 || item.salaryCalculation !== null ||
        !Number.isSafeInteger(item.skipped) || item.skipped < 0) throw new Error('INVALID_REVIEW_RECORD');
    const profile = options.profiles.find(profile => profile.key === item.workerKey);
    if (!profile) throw new Error('RETURN_SCOPE_MISMATCH');
    if (hourKeys.has(profile.key)) throw new Error('DUPLICATE_REVIEW_RECORD');
    hourKeys.add(profile.key);
    const payload = JSON.stringify({ schema: '2sg.work-hours.local.v1', employee_key: profile.key, employee_name: profile.name,
      timezone: 'Africa/Dakar', authenticated: false, validated_by_2sg: false, sync_m3s: false, entries: item.entries });
    const result = receiveHours(payload, { workerKey: profile.key, employeeName: profile.name, today: options.today });
    return { workerKey: profile.key, source: payload, result };
  });
  return { salaryItems, hoursItems };
}

function receiveReview(source, options, previousSource = null) {
  const incoming = inspectReview(source, options);
  const previous = previousSource === null ? { salaryItems: [], hoursItems: [] } : inspectReview(previousSource, options);
  const salaries = new Map(previous.salaryItems.map(item => [`${item.workerKey}|${item.period}`, item]));
  const hoursByWorker = new Map(previous.hoursItems.map(item => [item.workerKey, item]));
  let addedDeclarations = 0, addedHours = 0;
  // Validate the entire candidate before the caller changes any session state.
  for (const item of incoming.salaryItems) {
    const key = `${item.workerKey}|${item.period}`, old = salaries.get(key);
    if (old) {
      if (old.result.expectedAmountXof !== item.result.expectedAmountXof ||
          JSON.stringify(canonical(old.result.data)) !== JSON.stringify(canonical(item.result.data))) throw new Error('CONFLICTING_RETURN_NO_OVERWRITE');
    } else { salaries.set(key, item); addedDeclarations++; }
  }
  for (const item of incoming.hoursItems) {
    const old = hoursByWorker.get(item.workerKey);
    const merged = mergeWorkEntries(old?.result.entries || [], item.result.entries);
    if (merged.entries.length > 1000) throw new Error('MAX_HOURS_ENTRIES');
    addedHours += merged.entries.length - (old?.result.entries.length || 0);
    const payload = JSON.parse(item.source); payload.entries = merged.entries;
    hoursByWorker.set(item.workerKey, { workerKey: item.workerKey, source: JSON.stringify(payload), result: { ...item.result, ...merged } });
  }
  return { status: 'local_review_only', salaryItems: [...salaries.values()], hoursItems: [...hoursByWorker.values()],
    addedDeclarations, addedHours, authenticated: false, validated_by_2sg: false, sync_m3s: false, writes: 0 };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { receiveSalary, receiveHours, receiveReview };
else globalThis.SalaryReturns = { receiveSalary, receiveHours, receiveReview };
})();
