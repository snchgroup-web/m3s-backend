# Restricted RH document attachment

This release adds only `POST /api/rh/private/employees/:employeeId/contract-document-links`.
It does not upload documents, download originals, revise employees or issue contracts.
Existing dossier reads retain their separate reader and pool.

## Activation

- Foundation schema and `m3s_rh_document_writer` are provisioned by the operator, not at application startup.
- The writer remains NOLOGIN, NOINHERIT, with eight SELECT and two INSERT privileges.
- `m3s_rh_document_connector` is a distinct LOGIN, NOINHERIT, connection limit 2, with SET-only membership in the writer, no ADMIN and no direct table privileges.
- The operator enters a new secret of at least 32 characters in protected fields, never in source code or chat.
- Configure `M3S_RH_DOCUMENT_DB_PASSWORD`; retain the verified `M3S_RH_DB_CA_PEM` certificate.
- Activate `M3S_RH_DOCUMENT_PROFILE=rh-document-attachment-v1` only after connection qualification.
- Keep `M3S_RH_DB_PASSWORD` and `M3S_RH_READ_PROFILE` unchanged.

The host pins the internal Railway database, verifies TLS, validates the connector on every checkout,
then assumes the writer and verifies its privileges and forced RLS. Provider errors and credentials
are never returned to clients. Shutdown closes both RH pools.

## Business authorization

Google authentication, the existing MFA identity bridge, an allowed Origin, the current RH read/revise
decision and the exact employee/revision/document/version attachment decision remain mandatory.
Document metadata must designate an eligible C3 RH draft. Being Manager is not an RH grant.
Empty authorization registers refuse attachment; activation does not populate them implicitly.

The link is idempotent. A replay returns 200 instead of creating a second link. Contracts remain
`draft_not_signable`. No employee data, financial document, real credential or new subscription is included.

## Rollback

Unset `M3S_RH_DOCUMENT_PROFILE` to close only attachment routes without deleting history.
The dossier reader stays independent. Revert the release if deployment health fails.
