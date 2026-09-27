# Expense source amounts - candidate, not activated

## Implementation update - 2026-09-27

User authorized activation and wiring after backup. The additive SQL is now applied to the resolved production expenses table. Backup `expenses_backup_20260927_amounts_v2` restored to `expenses_restorecheck_20260927_amounts_v2`: 134 rows, zero differences. Post-migration comparison of all legacy columns also returned zero differences. No expense created or updated.

Create/read/update integration now exists locally; schema capability gates version 2. Income and legacy expense contracts remain strict. Updates cannot silently downgrade a version-2 record; source amounts retain explicit null parameter types. Dashboard API masks incomplete expense totals for all consumers and exposes coverage counts. Frontend source fields and tests are wired locally. Deployment and production verification remain pending. The chronological candidate below records the design basis, not current activation status.

The legacy expense INSERT stores CHF/CFA, but discards original amount/currency. Its GET hardcodes CHF and derives FX from CFA/CHF. Changing the form alone would lose source information. The shared legacy normalizer also governs income: do not relax it globally.

`financeExpenseAmounts.js` is a pure, offline candidate contract, not wired to production. Tests use synthetic amounts only. Missing amounts remain null. Explicit zero fees remain zero. Principal plus fees must equal total in currency minor units. Delivered recipient money is separate from accounting equivalents. No market-rate lookup or default conversion occurs.

## Additive persistence proposal

Preserve the existing expense table and its stable references, dimensions, and all historical rows. Following verified backup and approval, add nullable columns for:

- original currency (STRING) and total paid (NUMERIC);
- principal and fees in that currency (NUMERIC);
- recipient currency (STRING) and amount (NUMERIC);
- conversion source (STRING), amount-contract version (INTEGER).

Use existing CHF/CFA columns only for documented accounting equivalents; verify their actual types and nullability before migration. Do not backfill old rows or reinterpret existing CFA. Legacy rows stay legacy. The target table must come from the resolved Finance source, not an invented dataset or table name.

## Release gates still required

1. Inspect actual schema and verify backup can be restored; apply approved additive migration.
2. Introduce an explicit supported-version capability. New payloads must fail closed on an old backend, never fall through to the legacy writer.
3. Wire create, read and update together with explicit BigQuery null parameter types. Preserve existing authorization and Team/Agent validation. Retain source version during edits.
4. Update aggregate coverage: sums with unknown equivalents are partial, not complete totals. Expose missing-conversion counts; never treat a missing equivalent as zero. Keep historical rows untouched.
5. Extend existing FR/DE/EN form and detail view. Support original CHF/USD/EUR/XOF, optional documented equivalents, principal/fees and recipient amount. Keep budget/project/Agent/Team contracts unchanged. Do not allocate a transfer and count it twice.
6. Integration tests for round-trip persistence, totals coverage, legacy edits and rollback; responsive QA; controlled release, then import only reconciled missing operations.

No cloud query, migration, accounting entry, deployment or additional permission has been performed by these files. Expense/GED links remain a separate unactivated candidate.
