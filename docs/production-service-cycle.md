# Production Service Cycle

Status: implementation and operator migration candidate. Closed by default.
No startup schema creation, automatic grant, fictional import or salary update.

## Reuse and Scope

Uses the existing PostgreSQL service, Google/MFA identity runtime and the
governed metadata reader for GD-005/GD-006 and GD-008/GD-009. Does not reuse
GED/RH credentials or their writer roles. Existing Administration permissions
are not dedicated Production write/acceptance permissions.

Only metadata is stored: authorised scope reference, declared preparation
owner, optional project reference, dated evidence references, deliverable
versions, handover recipient/channel and reported response. No binary files,
salaries, payroll events or payment operations. The authenticated actor and
server recording time are recorded separately from the declared owner/date.

Evidence references remain declared, not resolved document content or a
signature. A reported acceptance is not a recipient-authenticated acceptance,
customer contract, invoice, or authority to commit 2SG. The initial two paths
remain internal preparations, not commercial customer orders.

## Storage and Rights

`production_private` contains four forced-RLS tables: schema_versions,
access_decisions, cycles and append-only events. Tenant and actor scopes use
the existing SHA-256 identity convention. Every request rereads current access
decisions; no role-name default grants. Decisions are per actor and path:
read, prepare/realise, deliver, accept. Only the operator can change decisions.

The application role is NOLOGIN with SELECT, INSERT on cycles/events and only
UPDATE(revision) on cycles. No event UPDATE/DELETE, access-decision mutation,
TRUNCATE or access to the existing RH/GED/Finance tables. A separate connector
must have only SET membership of this role, NOINHERIT, no direct table grants,
no elevated flags and a two-connection limit. Runtime drift closes checkout.

Short SERIALIZABLE transactions, row locks and unique request/event keys
protect stage append and revision together. A stale or conflicting request
returns 409, never silently overwrites. Retrying the same request ID/body is
idempotent. A transaction failure rolls back both event and revision. The
server replays stored history before returning or extending a cycle.

## API

Prefix `/api/production/service-cycles`:

- GET `/access`: current scoped capabilities.
- GET `?track=documents|rh`: up to 100 authorised cycles; overflow is explicit.
- GET `/:id`: cycle, history and audit markers.
- POST `/`: `{request_id, preparation}`; no imported events or local ID.
- POST `/:id/events`: `{request_id, expected_revision, event}`; one event only.

POST requires an allowed Origin, Google/MFA-authenticated current account,
application/json, no query or content encoding and an 8 KiB limit. General
50 MiB body parsing is bypassed for this prefix. Logs omit cycle IDs; responses
are private/no-store and hide provider/SQL details. No mutation retry is automatic.

## Operator Gates

1. Verify source database, capacity, absence of the new schema and actual role
   inventory. Preserve a new backup before migration; old backups alone do not
   qualify the present source. Restore privately and compare source before/after
   and restored rows/columns/RLS. Preserve role/ACL baseline before later grants.
2. Execute the reviewed, hash-matched `sql/production_service_cycle_v1.sql`
   only after the relevant action-time approval. The script intentionally fails
   on pre-existing schema/role rather than taking them over. It does not seed
   access decisions or create a login. No existing schema/table/default changed.
3. Qualify the exact actors, both paths and decisions; do not copy all RH grants
   or give all six members permission by default. Decide who may record a
   reported acceptance separately from who actually accepts the deliverable.
4. Provision a separate connector and distinct opaque technical credential
   through the approved secure process, never chat. Do not use a PostgreSQL
   administrator or borrow GED/RH credentials. Rehearse concurrent native
   connections and backup the populated schema before operational use.
   `sql/production_service_connector_v1.sql` creates that connector in NOLOGIN
   first, with a two-connection limit and SET-only membership. It rejects
   pre-existing roles and unexpected PUBLIC/direct access. The user completes
   masked PostgreSQL credential entry and the matching Railway secret, never
   chat; enable LOGIN only after that handoff and verification. No account
   decision is seeded by this generic connector script.
5. Publish only reviewed code, then configure
   `M3S_PRODUCTION_SERVICE_PROFILE=service-cycle-v1`,
   `M3S_PRODUCTION_SERVICE_DB_PASSWORD` (at least 32 characters, distinct) and
   reuse the verified `M3S_RH_DB_CA_PEM`. TLS, host and pool bounds are pinned.
   A profile alone cannot create schema or grant business access.
6. Connect the existing local UI to this explicit shared contract, with the
   current capability set, idempotent request IDs, revision conflicts and
   uncertain-save recovery. Do not promote existing synthetic JSON/history.
   Verify an authorised non-fictional preparation and read-only refresh before
   declaring the full application active. No real stage without its own evidence.
   The shared UI defaults closed when unavailable and offers local preparation
   only as an explicit, separate mode. It never imports local JSON into shared
   storage. A shared JSON export is a read-only snapshot, not an import format.
   Confirmation precedes each write. An uncertain response locks new writes;
   the user may retry exactly the same request ID/body, without automatic retry.
   Pending requests stay in the current account's in-memory session across
   client-side navigation; leaving/reloading the document warns before losing
   that state. No sensitive draft is persisted in browser storage. After an
   intentional reload, inspect server records before creating another cycle.

## Recovery and Residual Limits

Disable the new profile and revoke only the relevant Production decisions to
stop this feature; do not delete history or change RH/GED rights. Preserve the
new schema in the next qualified independent backup scope before actual use.
Restore to a separate protected target first, never overwrite the source as a test.

PGlite tests exercise SQL/RLS, persistence across reopen, permissions, HTTP,
rollback and stale/idempotent requests. They do not certify simultaneous native
PostgreSQL connections, cloud activation, signed acceptance or independent
off-host backup. Existing accepted employee/Android trials are not repeated.
