# REF-01 L1 migrations

This directory contains the isolated, reversible data foundations for the
REF-01 People, Teams and Responsibilities reference model.

## Scope

- Candidate schema only: `ref01`.
- Synthetic validation only.
- No import of real people, teams, evidence or credentials.
- No server startup hook, API route or automatic production execution.
- No grant to `PUBLIC`; application roles remain a later governed decision.

## Validation

```powershell
npm.cmd run validate:ref01
```

The validator starts an embedded PostgreSQL engine, applies the upward
migration, checks the integrity controls with fictitious identifiers, applies
the downward migration and confirms that the isolated schema is removed.

## Application

The SQL files are not an operational runbook. Applying them to a shared or
production database requires the G1 review, an approved role and access model,
a backup and restore test, and an explicitly authorized deployment procedure.
