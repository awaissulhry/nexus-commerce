# Exact proposed eBay deletion list — Xavia Racing

**Not deleted; awaiting Owner confirmation.** Measured 2026-09-22 at 16:22:22Z (dependents) and 16:23:18Z (credential presence). Both probes positively confirmed database `neondb`, `transaction_read_only=on`, workspace `nexus_legacy_workspace`. All 13 schema-derived relations counted successfully. These are two timestamped reads, not one simultaneous measurement; the actual delete rechecks under lock.

## The ten currently eligible rows

Each is inactive, not primary, disconnected, has no encrypted/plaintext credentials, destroys zero dependents and unlinks zero history rows.

| Exact connection ID | Created (UTC date) |
|---|---|
| `cmooy5zpz0000k7011seabha9` | 2026-05-02 |
| `cmooy5zzx0001k701bquf7bmb` | 2026-05-02 |
| `cmopxjoi90000o7012z97k46v` | 2026-05-03 |
| `cmopxjzrt0001o7014fr21mw8` | 2026-05-03 |
| `cmopxk9kw0002o7019nq99dki` | 2026-05-03 |
| `cmopxl8wm0003o701mr9aul0y` | 2026-05-03 |
| `cmopzqppu0000mo01lyawyqy1` | 2026-05-03 |
| `cmoq0evfu0001mo01sbd1pqr4` | 2026-05-03 |
| `cmpe9b0i803zsoj01in61qf6z` | 2026-05-20 |
| `cmt142pwf01xvp4019mowaexn` | 2026-08-20 |

## Retain these three

- `cmr4aaqb00025nz016k18rup9`: LIVE primary, encrypted credentials present, destroys 15 rows including 13 EbayCampaign; 3848 rows would be unlinked.
- `cmt142bli01vcp4010fjo2k13`: destroys 1 ConnectionScope and would unlink 2079 ConnectionEvent.
- `cmt0ksbbs01r4mo01c9diw1qp`: destroys zero, but still has **encrypted credentials** and one ConnectionEvent. This is the eleventh row originally called safe by dependency count alone. The guarded dead-row delete refuses it. It needs separate Owner consideration; do not silently clear its credentials to pass the guard.

The live primary's two plaintext refresh-token columns are now empty while encrypted credentials are present. The report must show that storage distinction; plaintext absence is not proof of no credentials. No encrypted value was returned or decrypted by these probes.
