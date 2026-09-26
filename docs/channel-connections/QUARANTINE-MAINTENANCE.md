# eBay quarantine inventory, deletion census and encryption maintenance

Status (2026-09-26): **deployed, never run in production.** Inventory (C11f5), crypto cancellation
(C11f6a), cold verify (C11f6b) and rewrap (C11f6c) shipped in Package A (PR #15); the deletion
review census shipped in release B+C (PR #32, migration `20260926s`). No operator login has been
granted either role, so none of these tools has run against production. eBay processing and topic
setup stay held. KMS is on in production since 2026-09-26 (the runtime encrypts new quarantine
bodies under it); operator KMS use, rewrap and key retirement each still need their own yes.
See [the completion matrix](COMPLETION-MATRIX.md) and [the build evidence](build/CX-REMAINING.md).

## Authority and approval

The ordinary application role cannot execute any maintenance function. Two NOLOGIN
roles hold operator authority; the NOLOGIN writer role owns the restricted functions
and must never be granted to anyone. The migrations create the roles/functions but
grant no operator login access.

| Role | Allows | Needed by |
|---|---|---|
| `nexus_ebay_quarantine_maintenance` | metadata inventory, deletion census, digest manifest, audited rewrap CAS | inventory, deletion census, verify, rewrap |
| `nexus_ebay_quarantine_custodian` | reading retained **ciphertext** (5 bodies per call, 3 MiB each) | verify, rewrap |

Ciphertext is not plaintext, but anyone who also holds `NEXUS_CREDENTIAL_ENC_KEY`
can read every `env` body. Grant the custodian role only to an operator approved to
decrypt provider bodies. A metadata-only operator keeps the C11f5 no-body boundary.

Before provisioning production access, identify the exact dedicated login, its
credential storage and its existing privileges. It must not be a database owner,
superuser, RLS-bypass role, application login, or member of the writer role. Prepare
the exact grants for approval; these templates are **not executed grants**:

```sql
GRANT nexus_ebay_quarantine_maintenance TO "<approved-operator-login>"
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
-- Only for an operator approved to verify or rewrap bodies:
GRANT nexus_ebay_quarantine_custodian TO "<approved-operator-login>"
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

Every definer function pins `search_path=pg_catalog, pg_temp`: without `pg_temp`
last, a caller's own temporary type could run code as the writer (C11f6b review;
a static gate now checks every shared definer). Provisioning access does not approve
production rewrap, live KMS checks or key retirement; those keep their separate
approval boundaries. Keep the original decryption key available from the moment
encrypted admission is deployed.

## Metadata inventory

Supply `CX_QUARANTINE_MAINTENANCE_DATABASE_URL` through the approved secret mechanism.
The CLI deliberately does not load dotenv files or fall back to `DATABASE_URL`.
Do not put the connection string in command arguments, logs or the repository.
From `apps/api`, after building:

```sh
node dist/scripts/cx-quarantine-inventory.js --max-rows 10000 --page-size 50
```

An optional `--target-key-arn` takes a resolved KMS resource ARN. It classifies
**stored key metadata only**; it performs no AWS request and does not establish
that the resource exists or can decrypt anything. `apparentFormats` examines the
envelope prefix only, not validity or authenticated contents. Unknown/missing key
metadata is counted explicitly. No body, provider ID, subject, per-row ID or
arbitrary stored key text is printed; the supplied validated target ARN is echoed.

The report includes all quarantine rows visible in one read-only, repeatable-read
snapshot, including resolved history and rejected-signature metadata. `asOf` is the
database transaction start time. `unassignedVerified` excludes rejected signatures.
Concurrent arrivals belong to the next snapshot; rerunning gives a fresh census.

Bounds: default10,000 rows; maximum100,000; page1–100 (default50); scan budget60s
checked between queries; SQL statement timeout10s; client query timeout15s. One
in-flight query may finish after the scan budget. Prefix slicing avoids reading
whole encrypted bodies just to identify their version. No quantified production
latency claim follows from the local tests.

| Exit | Meaning |
|---|---|
| 0 | Metadata snapshot traversal completed. Recovery remains unverified. |
| 2 | Partial census: `incompleteReason` is `row_limit` or `time_limit`. |
| 1 | Arguments, dedicated connection, authority or inventory failed. No successful census is returned. |

Never interpret a partial scan, failed permission check or an empty response after
an error as a complete zero. A legitimate complete empty snapshot is possible.
Every report keeps `recovery: not_checked` and `retirementReady: false`.

## Deletion review census (metadata only)

Deployed 2026-09-26 (PR #32); never run against production. Requires additive migration
`20260926s_cx_ebay_privacy_census` (applied with the release) and an already approved
dedicated login with the maintenance role. It uses the same
`CX_QUARANTINE_MAINTENANCE_DATABASE_URL` mechanism as inventory, with no dotenv or
application `DATABASE_URL` fallback. No custodian permission, decryption key or KMS
access is needed. From `apps/api`, after building:

```sh
node dist/scripts/cx-ebay-deletion-census.js
```

No arguments or write mode are accepted. The report contains only aggregate
counts and the oldest receipt time for production and sandbox, from one READ ONLY,
REPEATABLE READ snapshot. `asOf` is the transaction start. It counts verified
`MARKETPLACE_ACCOUNT_DELETION` quarantine rows, including historical generic
`subject_or_topic_unresolved` reasons. New verified deletion notices use
`account_deletion_review_required`; old immutable reasons are not rewritten.
Other stored reasons share a fixed aggregate bucket, so arbitrary text cannot leak
through the report. Rejected signatures and unclassified envelopes are excluded.

`unresolved` means no receipt-routing handoff; it is **not** an erasure state.
The fixed `disposition: review_required_no_erasure` describes this boundary.
The census neither matches subjects to workspaces nor creates review requests,
notices or erasure actions. The [privacy review](EBAY-PRIVACY-REVIEW.md) runs in
the retry worker after eBay is acknowledged and stays OFF by default. With it ON,
the retention job deletes a deletion notice 30 days after its review finished once
no business still has an open request for it; expired notices leave this census.
A cold verify or rewrap run that overlaps an expiry reports `state_changed`; rerun
it. Anonymising or deleting business data: the Owner chose option A on 2026-09-26 (remove personal
data now, keep only what tax law needs); the executor is not built yet.

The SQL statement timeout is 10 seconds and client query timeout 15 seconds.
Exit 0 means the aggregate snapshot completed, never that erasure completed.
Exit 1 returns a static `authority_denied`, `census_failed` or `census_unavailable`
error, with no successful empty/partial census. No production latency claim follows
from the local tests.

## Cold verify (read-only; uses KMS)

Requires migration20260923h and both roles. Same dedicated connection rules as
inventory. It decrypts every retained verified body locally, so the operator needs
`NEXUS_CREDENTIAL_ENC_KEY` for `env` envelopes and KMS Decrypt on every stored key
(`AWS_REGION` = the keys' region; the client defaults to eu-west-1). The proof covers
this operator's key access, not the runtime's. It never writes and never calls
GenerateDataKey.

```sh
node dist/scripts/cx-quarantine-verify.js --target-key-arn <resolved-key-arn> [--max-rows 1000] [--budget-seconds 60]
```

It reads a digest manifest in a closed read-only snapshot, then reads at most five
encrypted bodies per closed snapshot (custodian role) and cold-opens each one (no
key cache) with no database transaction open. It then reads a second manifest.
`complete: true` only when every verified body opened exactly once and the final
manifest matches the first exactly (ids, ciphertext digests and immutable binding
fields; delivery/adoption history may change). The claim is: every verified body in
the final observed state opened during this interval. It is not a claim about later
arrivals, and `retirementReady` is always false. `unchangedObservedState` is `null`
unless the final comparison ran. Snapshot times are transaction starts, so they are
lower bounds for the snapshots. Only the returned byte buffer is wiped; intermediate
strings stay in process memory until garbage collection.

| Exit | Meaning |
|---|---|
| 0 | `status` is `verified_observed_state`, `metadata_only` (only rejected-signature rows) or `empty`. |
| 2 | Incomplete: `manifest_incomplete`, `state_changed`, `verification_failed`, `cancelled` (Ctrl-C/SIGTERM) or `time_limit`. |
| 1 | `invalid_arguments`, `authority_denied` or `verification_unavailable` (including a body over the 3 MiB read bound); nothing was verified. |

`failedAccess` counts bodies whose key or KMS was unavailable to the operator;
`failedIntegrity` counts envelopes, bindings or digests that did not verify (a wrong
key also lands here). Bounds: `--max-rows` 1–10,000 (default 1,000) must cover every
quarantine row, including resolved and rejected history; `--budget-seconds` 60–1,800
(default 60; crypto stops 10 seconds before it); 10 seconds per body; SQL statements
bounded by the remaining budget. Verify does not resume: a store that cannot open
within one budget needs a larger budget, not more runs. No production latency figure
has been measured.

## Rewrap (WRITES stored ciphertext; uses KMS)

Requires migration20260923h, both roles, the same keys as verify plus KMS
GenerateDataKey on the target, and `AWS_REGION` = the target's region.

```sh
node dist/scripts/cx-quarantine-rewrap.js --apply --target-key-arn <resolved-key-arn> [--max-rows 1000] [--budget-seconds 60]
```

`--apply` is required: this command changes production rows. One run at a time
(a session advisory lock; a second run exits 1 with `rewrap_in_progress`). For each
verified body not already stored under the target it: reads it in a closed snapshot,
runs the reviewed helper (cold opens and a new envelope under the target) with no
transaction open, then calls the audited CAS in one short transaction (5-second lock
and idle limits). One `operationId` covers the run and appears in every audit row.

- A lost CAS or a row lock held longer than 5 seconds is `contended`, never overwritten.
- A server-reported error before COMMIT, after a proven ROLLBACK, is `failed` (no change); the run continues.
- A client timeout, a dropped connection, an unproven ROLLBACK or a COMMIT without an
  acknowledgement is `unknownOutcome`: the run stops at once and the connection is
  discarded. Rerun later; the next manifest shows what is really stored. Never hand-write SQL.
- A replacement finished after its record deadline or after Ctrl-C is discarded, never stored.
- After the first CAS attempt every failure still prints the report with its
  `operationId` (exit 2, e.g. `authority_denied` or `database_unavailable`), so audit
  rows can be matched. Exit 1 means no CAS was attempted.
- `complete: true` means the final manifest holds every verified body under the
  target key and nothing failed. It proves key metadata only; run cold verify next.
- Reruns are safe: rows already under the target are skipped (`nothing_to_do`).

Incomplete reasons: `manifest_incomplete`, `state_changed`, `rewrap_failed`,
`off_target_remaining`, `unknown_outcome`, `cancelled`, `time_limit`,
`authority_denied`, `database_unavailable`. Ctrl-C stops before the next CAS; bodies
already rewrapped stay valid under the target. Each v2 body costs up to four KMS
Decrypts and one GenerateDataKey.

## Key replacement procedure (each step needs its own approval)

1. Provision the operator login (both grants above) and its KMS permissions:
   Decrypt on every current key and the target, GenerateDataKey on the target only.
2. Give the runtime (API/worker) KMS Decrypt on the target: adoption opens bodies
   with runtime credentials. Then point new admissions at the target
   (`NEXUS_KMS_KEY_ID`); otherwise new arrivals keep adding bodies under the old key
   and rewrap cannot complete.
3. Run inventory, then rewrap until it exits 0, then cold verify until it exits 0
   with `atTarget` equal to `verified` and `envVerified` 0.
4. Workspace credentials are a separate store (credential maintenance). A key is
   still in use until both stores show no dependency on it.
5. Disable (do not delete) the old key, rerun cold verify, and wait an agreed period.
   Deleting a KMS key is irreversible and needs a separate explicit approval.

The tools never mark a key retirable. Environment-key envelopes have no key identity;
replacing the environment key itself is unsupported. Rotating material inside the
same KMS resource needs no rewrite.

Security boundary: `nexus_rewrap_ebay_quarantine` compares cipher/key/digest and
writes an append-only audit (hashes, key IDs, database time, operation ID, session
user) atomically; audit failure rolls back. SQL does not prove plaintext
equivalence: only the reviewed helper may prepare replacements. A database
administrator can still change DDL; the audit is not tamper-evident storage.

## Deployment and recovery

Package A was deployed on 2026-09-26 as PR #15 with every new switch OFF (approved by the Owner on
2026-09-25; merged on the Owner's word). This covered encrypted admission, the additive migrations,
restricted role creation, owner recovery UI and automatic logical archival of eligible completed
receipts. No operator grant, operator KMS use, rewrap, key retirement, activation or vendor probe
followed from it. Inventory requires migration `20260923g`; cold verify, rewrap and the custodian
role require `20260923h`; maintenance authority/audit begins with `20260923f`; the deletion census
requires `20260926s`. Preserve every applied migration file byte for byte in recovery builds.

Recovery for Package A is `recovery/cx-20260925` (rebuilt for the PR #4 architecture) and for
release B+C `recovery/cx-bc-20260926`; the gating and rehearsal history is in
[RELEASE-C9-C11F6C](RELEASE-C9-C11F6C.md). Older recovery branches (`recovery/cx-20260923`,
`recovery/cx-20260924`) are superseded.

The pre-package serving build lacks the new migration folders and cannot restart after expansion.
Never downgrade the database to recover. After activation, flag OFF alone does not hide already
scheduled retries from old workers. Retire old APIs/workers and in-flight sweeps before activation,
and use only protocol-aware recovery builds thereafter.
