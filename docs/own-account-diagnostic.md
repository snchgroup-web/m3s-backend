# Own-account diagnostic (review candidate)

This change adds one read-only route, disabled by default. It does not change
login, roles, permissions, account records, Firebase, database schemas or files.
No activation, merge or deployment is authorized by this document.

## Contract

`GET /api/auth/account-diagnostic` is registered only when
`M3S_OWN_ACCOUNT_DIAGNOSTIC_ENABLED` is exactly `true` in server configuration.
No setting is enabled or created by this PR. Without it the route is absent.

The route independently verifies the bearer signature and expiry using the
existing verifier, including when global API authentication is disabled. An
existing req.user is never accepted as proof. Only exact, explicit account id
and tenantId are used. No email/default-tenant fallback is applied.

The current configured account is reread by exact id/tenantId. Only id, tenantId,
active and permissions are projected. No password, hash, salt, email, role,
personal document or other account is returned. Missing/duplicate/inactive
accounts are rejected. Missing explicit grants return an incomplete result;
role-derived privileges are not manufactured to complete the diagnostic.

Success contains scope=current-account and account fields id, tenantId, active,
explicitPermissions and effectivePermissions. The latter is the intersection
of the current explicit grants and verified session grants, not certification
of authorization on every historical business endpoint. No business permission
is granted by this route. An authenticated active owner can inspect this bounded
diagnostic even when the explicit grant list is empty.

All handler responses are private/no-store. Failures are neutral: 401 denied,
409 explicit permissions unavailable, 503 source unavailable. No query/body
selector may choose another account. There is no write handler or file export.

## Verification and release boundary

Tests use only synthetic signing material/accounts. No production secrets or
business data are fixtures. Run
`node --test tests/ownAccountDiagnostic.test.js tests/historicalOwnAccountDiagnostic.test.js tests/ownAccountDiagnosticHttp.test.js`.
HTTP tests use ephemeral loopback ports and never start server.js or BigQuery.

Before a separately authorized activation: review this small diff, validate the
deployed verifier/configuration source, arrange one authenticated own-account
read, and confirm no-cache and refusal cases. If IDs or explicit permissions
are missing, stop and report the missing fields; do not create defaults/grants.
No automatic link to an external identity or employee/person record follows.
Rollback is removal/disablement of the flag; no database rollback is needed.
