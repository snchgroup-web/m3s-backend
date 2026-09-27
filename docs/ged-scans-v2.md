# GED scans: local candidate, not activated

The default `pilot-v1` policy is unchanged: 10 approved PDF/DOCX files, 1 MiB
each. Explicit `M3S_GED_IMPORT_PROFILE=scans-v2` enables at most 64 approved
PDF/DOCX/JPEG/PNG files, 5 MiB each and 64 MiB in aggregate. Unknown profiles
fail closed. SVG and arbitrary files remain denied.

Every file still requires exact operator-approved SHA-256, name, size and
classification; file signatures supplement this check, not replace malware
screening. Storage stays private and immutable. Downloads stay attachments
with nosniff and a sandbox CSP. No new IAM grants or public URLs are introduced.

`scripts/ged-merge-manifest.js` prepares a merged candidate while preserving all
old entries and rejecting changes to existing metadata. It does not scan,
approve, upload or modify cloud configuration. Existing hashes must never be
removed to make room in the manifest: reads and history depend on them.

## Activation order (not executed)

1. Confirm the exact source batch, exclude duplicate copies, retain the original
   files and complete malware checks during the agreed inactive window.
2. Verify a fresh backup and a tested restore of the current GED register.
3. Apply `sql/ged-scans-v3.sql` explicitly as schema owner. This changes only
   the byte-size constraint; no grants, row updates or deletions.
4. Publish the compatible backend and frontend after review; enable the profile
   and the merged approved manifest together. Keep all original entries.
5. Import the approved batch, re-read hashes/counts and verify existing records
   and history remain available. Record imports separately from accounting.

Do not revert to the old 10-file/1-MiB configuration after larger documents
have been imported: that would deny access to those documents. Any rollback
must preserve compatible read support and the complete manifest, or pause
uploads without removing existing content. No rollback or activation is
performed by this candidate.

Synthetic tests cover opt-in, size/count/aggregate limits, MIME/signature/hash,
HTTP idempotence, private attachments, manifest preservation and actual SQL
constraint migration with unchanged RLS/ACL and retained original rows.
