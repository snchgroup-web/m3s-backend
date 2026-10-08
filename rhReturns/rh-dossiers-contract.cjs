'use strict';

const { previousMonth } = require('./salary-core.cjs');

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error('RH_INVALID_ID');
  return value.toLowerCase();
}

function validateDraft(data) {
  const fields = ['displayName', 'positionRef', 'siteRef', 'employmentStartDate'];
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !fields.includes(key)) || typeof data.displayName !== 'string') throw new Error('RH_INVALID_FIELDS');
  const displayName = data.displayName.trim().normalize('NFC');
  if (!displayName || [...displayName].length > 160 || /[<>@\x00-\x1f]/.test(displayName)) throw new Error('RH_INVALID_NAME');
  const ref = value => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error('RH_INVALID_REFERENCE');
    return value;
  };
  const start = data.employmentStartDate ?? null;
  if (start !== null) { try { previousMonth(start); } catch { throw new Error('RH_INVALID_START_DATE'); } }
  return { displayName, positionRef: ref(data.positionRef), siteRef: ref(data.siteRef), employmentStartDate: start };
}

module.exports = { identifier, validateDraft };
