# Production identity bridge preparation

Status: isolated candidate, NOT imported by server.js, NOT deployed or activated.
The existing production password and session paths remain unchanged.

`identityAccessGate.js` and `identityAccountReader.js` reuse the access qualification
contracts with an authentication-only mode (no new business grant) and stricter
token timestamps. `identityProductionBridge.js` provides one explicit startup
choice. In Google mode it rejects the historical password endpoint, verifies
every request with official Admin Auth `verifyIdToken(token, true)`, requires
verified email and TOTP, and resolves the stable provider subject to exactly one
active approved link and account. No match by email. No legacy fallback.

Effective grants are the intersection of approved and current explicit grants.
Both permission-explicit flags are set, including Finance, so a Manager label
cannot expand a reduced set. `/auth/me` returns whitelisted metadata only.
Credential-bearing account JSON must not be passed to the injected repositories.

## Verification

Use Node 24 and the normal backend dependencies. Install the isolated PostgreSQL
test dependency with `npm install --ignore-scripts --omit=optional` in this directory.
From the repository root on PowerShell:

```powershell
$env:NODE_PATH = (Resolve-Path 'qualification/identity-production/node_modules').Path
node --test tests/identityProductionBridge.test.js
node --test tests/*.test.js
```

All provider results and records in these tests are synthetic. The HTTP test
binds only 127.0.0.1 and verifies absence of password/legacy-token bypass and
unchanged Finance authorization. It does not verify Google's live MFA behavior.

## Before registration and deployment

1. Confirm the production provider project and 0-cost boundary.
2. Establish an authorized server identity with Auth read access and a working
   API consumer project; no implicit IAM role change, key export or billing.
3. Prepare current sanitized account/link stores with explicit IDs and approved
   grants, preserving the existing own-profile principal and no new permissions.
4. Inject the official SDK, qualify the whole runtime on supported Node LTS,
   wire the middleware and password guard together at one controlled cutover.
   Add application-wide abuse limits and provider failure timeouts before use.
5. Connect the browser SDK, token refresh/signout, recovery and TOTP challenge.
   Do not expose business pages after a first factor alone. Complete live user
   acceptance, revoked/disabled-account checks and the factor-loss procedure.
6. Rollback remains a deliberate operator action; never retry legacy auth after
   provider failure. Keep real keys, subjects and account records out of Git.

Official references checked on 2026-09-26:
- https://firebase.google.com/docs/auth/admin/manage-sessions
- https://firebase.google.com/docs/auth/admin/verify-id-tokens
- https://docs.cloud.google.com/iam/docs/roles-permissions/firebaseauth
