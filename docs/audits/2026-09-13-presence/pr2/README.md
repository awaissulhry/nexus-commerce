# PR.2 — delist path evidence

W1.1, W1.2, W1.3, W1.5-QUEUE, W1.7 and **W1.9** are measured DONE. Owner approval for W1.9 is recorded verbatim in the ledger. The global push-lock repair has also landed. **AT-WAVE-4 remains open for the §B automatic verification integration**, whose shared service is being authored by PR.1. PR.1 repaired the three interim operational-impact type errors; the final API typecheck is green. No production/channel writes or commits by PR.2.

Latest API host: **127.0.0.1:55439/nexus_development**. Relevant API tests run from apps/api with the host printed; this is not the whole API suite. No check launched above1-minute load8.

| Instrument | Result | Exit |
| --- | --- | --- |
| API tsc / private build-info | no diagnostics | 0 |
| API Vitest | 19 passing files,323 tests;1 opt-in local test skipped here and passed separately | 0 |
| Local cascade rehearsal | four required arms, retry-cancel negative, later ordinary drain preserves UNKNOWN, +8s readback/cleanup | 0 |
| Local W1.9 rehearsal | pending/retry/BullMQ all SKIPPED with reason and no syncedAt | 0 |
| check-push-lock bare |47 listing-push functions+3 contracts,0 missing | 0 |
| check-cron-clustered | no direct cron bypasses | 0 |
| check-event-contract | no event-contract violation | 0 |
| check-route-prisma-ratchet | no baseline increase | 0 |

PR.4's global47-function DONE18:42:47Z supersedes the earlier scoped success and147/141 transport-candidate scan. The historical log/attribution remains on disk; latest logs have `resumed-final` names. [Machine gate receipt](gates.json).

## Committed local rehearsals

The delist fixture is one disposable DRAFT product in verified XAVIA with fake external IDs. Rollback proof preceded writes; four FK-free queue rows survived committed Product deletion and retained full coordinates/owning account/seller SKU/five-minute hold. [Actual queue IDs and readings](rehearsal.json).

| Arm | Persisted outcome | Queue status | Calls outbound / Amazon delete |
| --- | --- | --- | --- |
| Transport disconnect | UNKNOWN, retry hold set | PENDING |0 /0 |
| eBay access refusal | UNKNOWN / REFUSED | SKIPPED |0 /0 |
| Amazon unpublish | REFUSED / named error | FAILED |0 /0 |
| Grace cancellation | NOT_SENT | CANCELLED |0 /0 |

A second cancellation attempt against the transport retry is refused, preserving UNKNOWN. A later ordinary drain is also exercised on only that fixture: it performs no channel call, retains the original UNKNOWN/code/retryCount, records LIFECYCLE_DISPATCH_REFUSED separately, and ends as SKIPPED with nextRetryAt:null. Four unit regressions cover both lifecycle types in both drain lanes (4 red first, then18/18 including14 controls). Synthetic transport/access fixtures each run once; the outbound trap stays0. Final +8s cleanup products/listings/queue rows/events0, GALE59 unchanged. [Cleanup](rehearsal-cleanup.json).

The W1.9 fixture uses another disposable DRAFT product and three STATUS_UPDATE rows. All three real completion paths persist `SKIPPED`, `syncedAt:null`, `nextRetryAt:null`, `AMAZON_EMPTY_PATCH_NOT_SENT` and the operator sentence. Batch processed2/skipped2/succeeded0; BullMQ SKIPPED. Publisher0/outbound0; +8s cleanup products0/queues0; GALE59 unchanged. [W1.9 readings](w19-rehearsal.json), [approved change](w19-change.md).

## Contracts and evidence

- `services/delist-error-codes.ts`: stable error codes and operator sentences. Unimplemented unpublish/Shopify branches refuse before clients; day-one delist dashboard is visibly RED by design.
- `services/channel-delist.service.ts`: UNKNOWN transport/access/invalid acknowledgements, durable outcome events, seller SKU and owning eBay account. A successful acknowledgement remains distinct from a verified channel fact.
- `services/outbound-enqueue.ts`: captured full coordinates, FK-free cascade rows, five-minute grace, unsupported-coordinate receipts, eBay guard/dedup and post-commit evidence handling. Cancellation transaction moved here; route only validates/authenticates/calls the service.
- `services/outbound-sync.service.ts`: both lifecycle types refuse before ordinary adapters; each of five push methods reads current controls and uses shared assertPushAllowed; canonical FBA predicate consumed.
- `workers/bullmq-sync.worker.ts`: durable row supplies lifecycle type/channel; hold/CANCELLED/CAS enforced. Unknown/refused/dry-run completion cannot turn success counters green. Non-lifecycle routing/guards preserved; W1.9 corrects completion recording/counts.
- `products-catalog.routes.ts`: PR.2 changed only the announced transaction cascade hunk. PR.1 owns/applied registration, manifest and post-commit response.
- [Trading source caller inventory](site-id-callers.txt): 30 callers plus declaration; GB/UK tests include every requested caller and the private variation path through its public service.

Earlier red/green W1 logs are retained. Final commands and all assumptions/requests are in the ledger and [scope-and-assumptions.md](scope-and-assumptions.md). W1.9 is now measured DONE after Owner approval. M4 measured0 STATUS_UPDATE and0 30-day successes on both databases; historical empty-patch incidence remains unmeasurable. The new errorCode provides a durable marker for future measurements.
