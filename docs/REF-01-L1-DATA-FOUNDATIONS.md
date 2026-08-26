# REF-01 L1 data foundations

**Status:** candidate for G1 review

**Data used by validation:** synthetic only

**Production application:** none

## Purpose

Prepare a versioned and reversible PostgreSQL contract for People, Teams and
Responsibilities without connecting it to the running M3S backend.

## Candidate objects

| Object | Purpose | Main control |
| --- | --- | --- |
| `ref01.event` | Append-only record of governed changes | Idempotency, dual responsibility, immutable events |
| `ref01.object_version` | Effective-dated object snapshots | One current version per object |
| `ref01.membership_period` | Team membership history | No overlapping period for the same person and team |
| `ref01.evidence_link` | Opaque link to evidence retained by GED | Reference and classification only |
| `ref01.outbox` | Reliable publication candidate | Unique event and explicit processing status |

The schema stores opaque identifiers and references. It does not store evidence
files, credentials or real personal data in this lot.

## Controls already testable

- Event rows cannot be updated or deleted.
- Requester and validator must be different subjects.
- Replayed commands are rejected by a unique idempotency key.
- Version intervals and membership intervals must be coherent.
- Concurrent current versions are prevented per object.
- Completed outbox items require a completion timestamp.
- The schema, tables and functions grant no access to `PUBLIC`.
- The downward migration removes only the isolated `ref01` schema.

## Decisions still required at G1

- Confirm the target PostgreSQL service and its backup and restore procedure.
- Approve application roles, row-level visibility and authorization mappings.
- Approve retention periods and C2/C3/C4 handling with GED.
- Confirm migration ownership, deployment identity and rollback authority.
- Review monitoring, alerting and outbox retry rules.
- Authorize or reject a later L2 API integration lot.

No G1 decision authorizes real-data import, production migration or API
exposure by itself.
