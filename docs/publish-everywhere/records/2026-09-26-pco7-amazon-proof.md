# PCO-7 Amazon proof — PASS (2026-09-26, production, one listing)

Owner's word in the PE session (21:00 UTC) after seeing the exact change. Run on `nexus-worker` (`railway ssh`) because channel
logins are KMS-sealed since 2026-09-26. Tool: `docs/publish-changes-only/tools/pco7-amazon-proof.mts`. Ids are kept out of this
public file (proposal digest `0ad7243e…`; feed ids and the ASIN stay in the private records).

| Step | Time (UTC) | Result |
|---|---|---|
| Prepare (read only) | 20:32:57 | original Italian `generic_keyword` read; Amazon VALIDATION_PREVIEW ok for the send and the restore |
| Send (one PATCH, one root, one SKU) | 21:01:46 | processing report conclusive: "Amazon processed this product." |
| Canary read-back | 21:05:38 | matched — the hidden token is live |
| Restore (exact original root) | 21:05:39 | processing report conclusive: processed |
| Restore read-back | 21:09:13 | equals the original exactly |
| Delayed re-read (+60 s) | 21:10:13 | equals the original |

Listing: GALE-JACKET-BLACK-MEN-S · Amazon IT · search keywords (not buyer-visible). Journal rows carry reason `publish-proof`
(no normal accepted-field baseline was seeded). No audit error. Verdict: the change-only Amazon path works live end to end.
