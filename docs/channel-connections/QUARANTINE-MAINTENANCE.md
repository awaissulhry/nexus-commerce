# eBay quarantine inventory and encryption maintenance

Status: implemented locally through C11f5; **not deployed or production-verified**.
See [the completion matrix](COMPLETION-MATRIX.md) and
[the build evidence](build/CX-REMAINING.md). Processing/setup remain held.

## Authority and approval

The ordinary application role cannot execute global inventory or rewrap. A separate
operator login needs SET membership in `nexus_ebay_quarantine_maintenance`. The
NOLOGIN writer role owns the restricted functions; do not grant it to operators.
The migrations create the roles/functions but grant no operator login access.

Before provisioning production access, identify the exact dedicated login, its
credential storage and its existing privileges. It must not be a database owner,
superuser, RLS-bypass role, application login, or member of the writer role. Prepare
the exact grant for approval; this template is **not an executed grant**:

```sql
GRANT nexus_ebay_quarantine_maintenance TO "<approved-operator-login>"
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

The role permits both metadata inventory and the restricted rewrap function.
Provisioning access does not approve production rewrap, live KMS checks or key
retirement. Those operations retain their separate approval boundaries. Keep the
original decryption key available from the moment encrypted admission is deployed.

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

## Rewrap boundary and remaining work

The private crypto helper validates the original sealed binding, byte digest,
envelope key metadata and exact serialized content. It cold-opens source/replacement
and pins encryption to the requested key resource. It does not require a supported
topic or valid provider JSON: verified opaque bodies must remain recoverable.
Adoption retains its separate, stricter account-identity checks.

`nexus_rewrap_ebay_quarantine` compares the original cipher/key/digest and changes
only ciphertext/key metadata, atomically inserting an append-only audit with
ciphertext hashes, key IDs, database time, operation ID and operator session identity.
It does not itself prove plaintext equivalence; the reviewed helper is mandatory.
Audit failure rolls the replacement back. Contention/no-op produces no success audit.
Never call it using hand-built replacement ciphertext.

The operator verify/rewrap command, complete cold traversal, safe handling of
concurrent writers and exact key-retirement procedure remain to be implemented and
reviewed. This inventory command cannot retire a key or certify recovery. Existing
workspace credential maintenance does not establish global quarantine coverage.
Environment-key envelopes have no key identity/keyring; replacing the environment
key is unsupported. Rotation of material within the same KMS resource does not
require rewriting stored envelopes.

## Deployment and recovery

Approval must explicitly cover encrypted admission, additive migrations, restricted
role creation, owner recovery UI and automatic logical archival of eligible completed
receipts. No operator grant, rewrap, key retirement, channel activation or vendor probe
is implied. Inventory requires migration20260923g; maintenance authority/audit begins
with20260923f. Preserve every applied migration file byte-for-byte in recovery builds.

Published0a cannot restart after these migrations: its applied-but-missing migration
gate rejects the new history. A protocol-aware recovery artifact with complete
migration history must be built, reviewed and rehearsed before deployment approval.
The nearere67 application snapshot is a candidate only. Unmodifiedc65 would restore
known credential-cache and profile-read races, so it is not the prepared fallback.
After activation, flagOFF alone does not hide already scheduled retries from old
workers. Retire old APIs/workers and in-flight sweeps before activation, and use only
protocol-aware recovery builds thereafter. Never downgrade the database to recover.
