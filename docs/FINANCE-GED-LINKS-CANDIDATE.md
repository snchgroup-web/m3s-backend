# Expense / GED linkage - controlled activation

## September 27 implementation

The operator has authorized the new protected link table and SELECT/INSERT
for the existing runtime role after backup/restoration verification.
The first activation is a fixed, locally reconciled batch; business identifiers
and document hashes are kept outside Git. No general-purpose attach/detach
write endpoint is exposed in this release. The append-only schema supports
future revision-controlled commands, which require separate implementation.

The expense row offers a proof viewer with private downloads. Both endpoints
recheck Finance read permission, GED owner/MFA, the unique authoritative
expense, the financial category, non-trashed root and pinned historical version.
The link is not an allocation and never changes any financial amount.
The following sections preserve the original design and future write gates.

## Preserve existing sources

- Finance expense key: actual `Nr REF` from the resolved expense table, not
  the UI fallback reference. Source table identity must be server-derived.
- GED: tenant/owner/document hash, root and immutable version from lifecycle.
- Supplier: existing `FOURNISSEUR` text is not a supplier master ID.
- Budget: reuse BUDGET-MAP-001 and the T1 reference contracts. Budget V2 already
  models entity, fiscal year, function, team, agent, portfolio, dossier,
  project and phase. Do not create competing reference registries.
- Real operation allocation remains closed in the budget mapping contract.

## First operational scope

The expense table stays primary. Add a compact proof action per existing row.
Its detail lists document role, external reference and an authenticated GED
download. Invoice number is external metadata, not the expense ID or filename.
No obligatory invoice number for transfers or receipts.

One expense may have an invoice and payment receipt. One transfer document may
be referenced by several existing allocations, but links have no amounts and
never create allocations, expenses, payments or budget execution totals.

## Candidate persistence

`sql/ged-expense-links-candidate.sql` is not loaded at startup and has not been
executed in production. It records append-only attach/detach history scoped to
the current GED owner, with immutable root and version references. Detaching
does not delete the document or expense. It grants no runtime privileges.

Before activation, implement the server/UI adapter and test all of:

1. Authenticated Finance read/write permissions plus existing GED MFA and
   owner controls. Linking never shares a document with another reader.
2. Resolve exactly one expense from the authoritative source, not only the
   current page or the first 200 rows; refuse ambiguous/missing references.
3. Resolve the accessible financial document and its actual lifecycle root
   and version; refuse personal, trashed or mismatched versions.
4. Derive scope/source/actor on the server; do not trust client values.
5. Expected-revision concurrency and idempotent retries, transactional append.
6. On every read/download recheck access and current availability; retain
   historical pinned version rather than silently replacing proof bytes.
7. Preserve all existing amounts, supplier, Agent, Team, department and phase.

## Activation gate

After adapter tests and verified backup, obtain approval for the limited new
link table and SELECT/INSERT runtime access to it. No accounting migration,
new account, subscription, sharing or supplier/project creation is implied.
Do not present the candidate table alone as a functioning link feature.
