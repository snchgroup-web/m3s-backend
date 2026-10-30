'use strict';

const { HASH, approvedDocument, categoryFor, scopeFor } = require('./gedPrivatePolicy');
const fail = () => Object.assign(new Error('FINANCE_GED_RECOVERY_UNAVAILABLE'), { code: 'FINANCE_GED_RECOVERY_UNAVAILABLE' });

// Local candidate only. No route, scheduling or automatic recovery is provided.
async function recoverFinancialDecisionGate({ token, principal, policy, register, storage, gate, pinnedRoot }) {
  if (!HASH.test(pinnedRoot || '') || token?.documentId !== pinnedRoot || token?.actorId !== principal?.id ||
      token?.tenantId !== principal?.tenantId || !Number.isSafeInteger(token?.expectedRevision) ||
      token.expectedRevision < 0 || token.expectedRevision > 10000 || typeof register?.lifecycle?.withLockedRoot !== 'function' ||
      typeof storage?.get !== 'function' || typeof gate?.thaw !== 'function') throw fail();
  const scope = scopeFor(policy, principal);
  if (categoryFor(approvedDocument(policy, pinnedRoot)) !== 'finance') throw fail();
  return register.lifecycle.withLockedRoot(scope, pinnedRoot, async current => {
    if (!current || current.root_id !== pinnedRoot || current.tenant !== scope.tenant || current.owner_id !== scope.owner ||
        !HASH.test(current.document_id || '') || !Number.isSafeInteger(current.revision) ||
        (current.revision !== token.expectedRevision && current.revision !== token.expectedRevision + 1) ||
        typeof current.trashed !== 'boolean') throw fail();
    if (!current.trashed) {
      if (categoryFor(approvedDocument(policy, current.document_id)) !== 'finance' ||
          !Number.isSafeInteger(current.byte_size) || !/^[1-9][0-9]{0,29}$/.test(current.generation || '')) throw fail();
      const bytes = await storage.get({ key: `ged-private/v1/${scope.tenant}/${scope.owner}/${current.document_id}`,
        generation: current.generation, size: current.byte_size, sha256: current.document_id });
      approvedDocument(policy, current.document_id, bytes);
    }
    const gateRevision = await gate.thaw(token);
    return { status: 'verified_and_reopened', document_revision: current.revision,
      document_trashed: current.trashed, gate_revision: gateRevision };
  });
}

module.exports = { recoverFinancialDecisionGate };
