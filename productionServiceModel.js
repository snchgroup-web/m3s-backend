'use strict';
const { createHash } = require('node:crypto');
const SOURCES = Object.freeze({ documents: ['GD-005', 'GD-006'], rh: ['GD-008', 'GD-009'] });
const fail = code => { throw new Error(code); };
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('SERVICE_INVALID');
}
function text(value, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f]/.test(value)) fail('SERVICE_INVALID');
  return value.trim();
}
function reference(value) {
  const result = text(value);
  if (/^(data|javascript|file):|^[A-Za-z]:[\\/]|^\\\\/i.test(result) || /[?&](token|apiKey|oobCode|password)=/i.test(result)) fail('SERVICE_INVALID');
  return result;
}
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date());
function date(value, limit = today()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('SERVICE_INVALID');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value > limit) fail('SERVICE_INVALID');
  return value;
}
function setup(input) {
  fields(input, ['track', 'scope', 'owner', 'project_reference', 'authorization_reference'], ['track', 'scope', 'owner', 'authorization_reference']);
  if (!Object.hasOwn(SOURCES, input.track)) fail('SERVICE_INVALID');
  return { track: input.track, scope: text(input.scope, 800), owner: text(input.owner, 160),
    project_reference: input.project_reference == null || input.project_reference === '' ? null : reference(input.project_reference),
    authorization_reference: reference(input.authorization_reference) };
}
function advance(events, input, limit = today()) {
  const allowed = { realization: ['step', 'occurred_on', 'evidence_reference', 'deliverable_reference', 'version'],
    delivery: ['step', 'occurred_on', 'evidence_reference', 'recipient', 'channel'],
    acceptance: ['step', 'occurred_on', 'evidence_reference', 'recipient', 'outcome', 'reservations'] };
  if (!input || !Object.hasOwn(allowed, input.step)) fail('SERVICE_INVALID');
  fields(input, allowed[input.step], allowed[input.step].filter(key => key !== 'reservations'));
  if (events.length >= 60) fail('SERVICE_LIMIT');
  const last = events.at(-1);
  const state = !last ? 'planned' : last.step === 'realization' ? 'realized' : last.step === 'delivery' ? 'delivered' : last.outcome;
  const common = { step: input.step, occurred_on: date(input.occurred_on, limit), evidence_reference: reference(input.evidence_reference) };
  if (last && common.occurred_on < last.occurred_on) fail('SERVICE_CHRONOLOGY');
  if (input.step === 'realization') {
    if (!['planned', 'reserved', 'rejected'].includes(state)) fail('SERVICE_TRANSITION');
    const result = { ...common, deliverable_reference: reference(input.deliverable_reference), version: text(input.version, 80) };
    const previous = events.findLast(item => item.step === 'realization');
    if (previous && previous.version === result.version && previous.deliverable_reference === result.deliverable_reference) fail('SERVICE_VERSION');
    return result;
  }
  if (input.step === 'delivery') {
    if (state !== 'realized') fail('SERVICE_TRANSITION');
    if (!['email', 'secure_link', 'hand_delivery'].includes(input.channel)) fail('SERVICE_INVALID');
    return { ...common, recipient: text(input.recipient, 160), channel: input.channel,
      deliverable_reference: last.deliverable_reference, version: last.version };
  }
  if (state !== 'delivered') fail('SERVICE_TRANSITION');
  if (!['accepted', 'reserved', 'rejected'].includes(input.outcome)) fail('SERVICE_INVALID');
  if (input.recipient !== last.recipient) fail('SERVICE_RECIPIENT');
  if (input.outcome === 'accepted' && input.reservations) fail('SERVICE_INVALID');
  return { ...common, recipient: last.recipient, outcome: input.outcome,
    reservations: input.outcome === 'accepted' ? null : text(input.reservations, 800), delivery_event_index: events.length - 1 };
}
function principal(user) {
  if (user?.authProvider !== 'google' || ![user.id, user.tenantId].every(value => typeof value === 'string' && /^[^\s\x00-\x1f]{1,128}$/.test(value))) fail('SERVICE_FORBIDDEN');
  const hash = value => createHash('sha256').update(value).digest('hex');
  return { tenant: hash(user.tenantId), actor: hash(user.id) };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
module.exports = { SOURCES, fields, setup, advance, principal, digest, fail };
