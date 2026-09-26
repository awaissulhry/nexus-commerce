# eBay quarantine inventory and encryption maintenance

## Latest checkpoint — 2026-09-25 11:38 UTC

**Package A code/recovery APPROVED, fully gated and locally rehearsed. No package or
recovery ref has been pushed by this session; nothing new is deployed or enabled.**
Final documentation signoff/publication remain pending. The Owner has approved reviewed,
gated, rehearsed deployment with every new switch OFF. The existing CI eBay consent-page
GET probes still need the separate narrow exception already requested; no yes received.

Published main is `2459bf52fe85e1ffe0b5f0c510994e019cb3eed4` (refetched11:37Z; docs after
bc39). Public readiness re-read before that fetch reports healthy serving **bc39f98d**.
Release source is **`3be0a62e1344626db7f8adf4e49351880cae6725`**; recovery branch
`recovery/cx-20260925` is **`34c376113380f4c803d4f91190f94c06126c56a2`**. Metadata commits
may follow the reviewed source. Recovery preserves published main and the exact release
DB tree; application differences are C11f6a/b/c only. Its PCO fixture correction has an
independent APPROVE; no assertion, timeout, ratchet or hook was weakened.

Clean source full hook: DB33, **API12220/359 existing skips**, **web4887/13**, both builds,
security127, RBAC2728/zero unmapped, **realPG328 in25 suites/zero skips**; profiles977 files,
41 known-failing/217 tests, none new or worse. Clean recovery full hook: **API12129/340**,
web4887/13, DB33/security127/builds, **realPG309 in23 suites/zero skips**; profiles971 files,
same41/217 unchanged baseline. Contrast at these heads: web92/factory106 pairs, zero below7:1.
Logs: release `package-a-gate-3be0a62e1-clean.log`, recovery
`package-a-recovery-gate-34c376113.log`; archived sublogs under their helpers' build/evidence
`package-a-3be0a62e1/` and `recovery-34c376113/`.

HTTP rehearsal passed **10:52:36Z**; background-jobs rehearsal **11:06:55Z**. Base **bc39**
bootstrap→release adds exactly eight CX migrations (**473→481**); old base refuses;
recovery34→release3be→recovery34 each returns ready200 with its exact build, unchanged
migration history/checksums and role/object invariants. Jobs initialized with processing
held. Current rehearsal folders contain these heads; earlier4e/77 proof is archived.
Both code/recovery reviews APPROVE. A first PCO-fixture gate failure and the source-equivalent
pre-checkout pass are preserved but are not substituted for the clean3be gate.

Latest private read-only census: **08:54:05Z**, `production-census-20260925-085405.json` (kept locally; not in the public repo):
473 applied migrations, zero unresolved failures, two rolled-back historical rows; all332
eBay listings IT (232 follow master), two active sellers with default warehouses; no v0
finance duplicates, **73 finance rows/62 orders unattributed**,39 recent Amazon orders
unattributed; exact Etsy shop57783036 active Motovento route; one active connected Shopify.
No non-IT master-price exception is triggered by this snapshot. Refresh before Package B
shipping. Last private switch evidence remains01:00:45Z: all six new switches unset/OFF,
with positive DB-source match. Refresh before publication; no newer switch verification is
claimed. Public health at06:54:44Z reported15 quantity mismatches and existing critical Ads
findings; healthy readiness is not a blanket operational verdict.

Package B remains unintegrated: contract a6b5fefaa, price3fa33094f, Finances3f493f5ff and
eBay orders68fcc9f36 APPROVED. Etsy ingest c621418e and SKU identity da1de249 APPROVED;
pooled line foundation61cbe88bc is under review and terminal writer integration remains open.
Its offset-ceiling history limit remains an explicit hold, not unrestricted completeness.
Package C: listing issues16945532a and Tag contrast e738e4531 APPROVED; privacy census
6e6687952 APPROVED, candidate records in verification; cancellation parity b77db1bd3 APPROVED,
terminal follow-up b382fb7ba required fixes (recovery65bda8b72 committed, atomic-state fix in
progress). Contract follow-up330395766 and teardown87406ac23 await independent review.
The latter proves/fixes a setup-client shutdown race consistent with the original57P01;
it does not explain recoveryf9's separate PGlite socket loss. Remaining engineering,
activation preparations and Phase5 audit remain open under the structured plan.


Status: inventory (C11f5), crypto cancellation (C11f6a), cold verify (C11f6b) and rewrap (C11f6c)
are implemented and tested locally; **not deployed, provisioned or production-verified**.
See [the completion matrix](COMPLETION-MATRIX.md) and
[the build evidence](build/CX-REMAINING.md). Processing/setup remain held.

## Authority and approval

The ordinary application role cannot execute any maintenance function. Two NOLOGIN
roles hold operator authority; the NOLOGIN writer role owns the restricted functions
and must never be granted to anyone. The migrations create the roles/functions but
grant no operator login access.

| Role | Allows | Needed by |
|---|---|---|
| `nexus_ebay_quarantine_maintenance` | metadata inventory, digest manifest, audited rewrap CAS | inventory, verify, rewrap |
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

The Owner approved Package A deployment on 2026-09-25 with every new switch OFF. This covers
encrypted admission, additive migrations, restricted role creation, owner recovery UI and automatic
logical archival of eligible completed receipts after the package gates and rehearsal pass.
No operator grant, KMS use, rewrap, key retirement, activation or vendor probe is implied.
Inventory requires migration20260923g; cold verify, rewrap and the custodian role require20260923h;
maintenance authority/audit begins with20260923f. Preserve every applied migration file byte-for-byte
in recovery builds.

Historical source checkpoint: release `77c787559` merges published main `a22f2fc36`. Recovery candidate `a5efa0dd9` on
`recovery/cx-20260925` is `38c99a7af` + that same published main + the exact release database tree
and prescribed maintenance/concurrent-database test files. Release exact-head full hook passes;
recovery database parity, source APPROVE and full hook pass. Source77/recoverya5 HTTP rehearsal
passed at2026-09-25 00:12:13Z and jobs at00:15:11Z (471→479,exact8CX,base refuses,exact builds,
unchanged history/checksums/roles/objects; each jobs boot alive45s and processing held).
The final docs/tools commit hook and both exact-build rehearsals remain pending; set
`CX_RELEASE_SHA=<final-release-sha>` explicitly because defaults pin source77. No package or recovery
ref is pushed/deployed. See the release record for the reviewed recovery-ref publication from the
clean final release checkout and the distinct tested release HEAD / pushed recovery SHA. The existing deploy workflow's automatic eBay consent-page GET
probes need separate narrow Owner scope confirmation before main push; finish preparation first,
then ask once, and never skip or weaken that gate. See the release record for exact probe scope.
The earlier `recovery/cx-20260923` (`fdd368e0c`) and `recovery/cx-20260924` (`64bf38e48`)
are superseded; use only the currently gated/rehearsed artifact recorded in
[RELEASE-C9-C11F6C](RELEASE-C9-C11F6C.md).

The pre-package serving build lacks the new migration folders and cannot restart after expansion.
Never downgrade the database to recover. After activation, flag OFF alone does not hide already
scheduled retries from old workers. Retire old APIs/workers and in-flight sweeps before activation,
and use only protocol-aware recovery builds thereafter.
