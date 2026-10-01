# Income source amounts: local qualification

Status: LOCAL_CANDIDATE_NOT_ACTIVATED, 2026-10-01.

## Scope

Permit a documented receipt in its original currency without inventing a second
currency equivalent. Reuse the existing income register and its dimensions.
Do not net supplier refunds against their original expense or deduplicate on amount.
The bank transaction reference identifies separate credits; the supplier credit-note
match can remain unresolved without changing the amount received.

## Contract

`amount_contract_version: 2` with `source_amounts`:

- `original_currency`: CHF, EUR, USD or XOF (CFA accepted as an alias).
- `total_received`: strictly positive, currency-precision amount actually received.
- `equivalent_chf`, `equivalent_cfa`: optional documented values, not indicative rates.
- `conversion_source`: required exactly when a cross-currency equivalent is supplied.

Receipt fields are distinct from expense principal, fees and recipient delivery.
The validated expense decimal rules are reused internally, without exposing its
payment/delivery fields on a receipt. Unknown equivalents remain null.

Existing storage columns `MONTANT_SAISI`, `DEVISE_SAISIE`, `MONTANT_CHF`,
`MONTANT_CFA` and rate columns are reused. Candidate additions are nullable
`AMOUNT_CONTRACT_VERSION INTEGER` and `CONVERSION_SOURCE STRING` only.
The planner validates the resolved table and schema, produces additive SQL and
never executes it. It rejects incompatible or non-nullable amount/rate columns.

## Checks completed

- 65 offline tests across income and existing expense amount/storage contracts.
- Existing Finance transaction FX script passes unchanged.
- Null query parameters serialize through the installed BigQuery SDK offline.
- Three synthetic receipts of 1.62, 2.43 and 1.62 CHF remain three records and total
  5.67 CHF; no synthetic CFA is produced.
- Partial income sums are exposed separately from complete totals. Zero and null
  remain distinct. Expense totals are preserved.
- Local routes now import the candidate modules. Income V2 is accepted only when
  the resolved schema supports nullable amounts, rates, currencies and metadata.
  Production has not been changed by this local integration.

## Local integration in progress

POST/PUT use typed source amounts; version guards protect V2 rows from legacy
updates. Reads advertise the storage capability. Summary responses distinguish
known income subtotals from incomplete totals. The frontend candidate includes
FR/EN/DE receipt fields, partial indicators and null-preserving annual series.
Income-specific GED links now use a separate append-only table, with the existing
owner scope and lifecycle/version checks. They are disabled unless
`M3S_GED_INCOME_LINKS_ENABLED=true`. Runtime checks require SELECT/INSERT only,
forced RLS and a non-owner application role before enabling the registry.
The expense namespace and stored links are unchanged.

Verification of the integrated candidate: 165 frontend tests in ten suites,
66 backend tests covering contracts, HTTP routes, lifecycle and owner isolation,
and a strict CI build passed. Local synthetic desktop/mobile QA verified creation,
credit-note attachment, PDF preview/close, edit reopening and cancellation.
The synthetic fixture does not prove production schema or permissions.
The checklist below describes activation gates, not completed production work.

## Required integration before activation

1. Read resolved income table schema and capture a backup with verified restore.
   Do not run a guessed `income` table name or assume nullable columns.
2. Add schema/capability detection; protect both POST and PUT against unavailable
   storage and prevent a V1 request from overwriting a V2 row.
3. Connect typed writes and versioned reads together. Preserve legacy rows and
   all dimensions; verify source-amount round-trip.
4. Add income missing-currency counts to the global summary and mask incomplete
   totals. Adapt frontend summary, balance, tables and charts together so partial
   sums cannot appear complete.
5. Add receipt-specific FR/EN/DE source fields gated by backend capability.
   Preserve edit/cancel/confirmation flows and existing social income behavior.
6. Verify the authorized financial GED link path for income (not an expense ID),
   and retain distinct bank references as duplicate controls.
7. Run integration tests, desktop/mobile QA, review and publish the bounded lot.
   Only then check the live register for duplicates and record the three credits.

No migration, publication, production write, payment or subscription was performed
for this qualification. The real credits and proof mappings remain in the local
reconciliation records, not in the repository tests or this document.
